import assert from "node:assert/strict";
import test from "node:test";

import { handleLemonSqueezyWebhook } from "../lib/pro-webhook.mjs";

const endpoint = "https://auroraforecastnow.com/api/pro/webhook";
const signingSecret = "test-signing-secret";

test("Aurora webhook rejects unsigned requests before touching storage", async () => {
  let prepared = false;
  const request = new Request(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Event-Name": "order_created",
      "X-Signature": "0".repeat(64),
    },
    body: JSON.stringify(orderPayload()),
  });
  const response = await handleLemonSqueezyWebhook(request, configuredEnv({
    COMMENTS_DB: { prepare() { prepared = true; } },
  }));

  assert.equal(response.status, 401);
  assert.equal(prepared, false);
  assert.deepEqual(await response.json(), { ok: false, error: "Invalid webhook signature." });
});

test("Aurora webhook atomically records a signed test purchase without PII", async () => {
  const db = recordingDb({ aggregateChanges: 1 });
  const response = await handleLemonSqueezyWebhook(
    await signedRequest("order_created", orderPayload()),
    configuredEnv({ COMMENTS_DB: db }),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true, recorded: true });
  assert.equal(db.batches.length, 1);
  assert.match(db.prepared[0].query, /pro_webhook_receipts/);
  assert.equal(db.batches[0][0].values[0].length, 64);
  assert.deepEqual(db.batches[0][0].values.slice(1), ["order_created", 1]);
  assert.deepEqual(db.batches[0][1].values, ["purchase_completed", "webhook_test"]);
  assert.doesNotMatch(JSON.stringify(db.batches), /buyer@example\.com|Buyer Name|order-123/);
});

test("Aurora webhook acknowledges duplicate deliveries without incrementing twice", async () => {
  const db = recordingDb({ aggregateChanges: 0 });
  const response = await handleLemonSqueezyWebhook(
    await signedRequest("order_created", orderPayload()),
    configuredEnv({ COMMENTS_DB: db }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, recorded: false });
});

test("Aurora webhook ignores signed events for a different product", async () => {
  let prepared = false;
  const response = await handleLemonSqueezyWebhook(
    await signedRequest("order_created", orderPayload({ productId: "other-product" })),
    configuredEnv({ COMMENTS_DB: { prepare() { prepared = true; } } }),
  );

  assert.equal(response.status, 200);
  assert.equal(prepared, false);
  assert.deepEqual(await response.json(), {
    ok: true,
    recorded: false,
    reason: "product_mismatch",
  });
});

test("Aurora webhook records issued licenses separately from completed orders", async () => {
  const db = recordingDb({ aggregateChanges: 1 });
  const response = await handleLemonSqueezyWebhook(
    await signedRequest("license_key_created", licensePayload()),
    configuredEnv({ COMMENTS_DB: db }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(db.batches[0][0].values.slice(1), ["license_key_created", 1]);
  assert.deepEqual(db.batches[0][1].values, ["license_issued", "webhook_test"]);
});

test("Aurora webhook rejects mismatched signed event metadata", async () => {
  const response = await handleLemonSqueezyWebhook(
    await signedRequest("order_created", licensePayload()),
    configuredEnv({ COMMENTS_DB: recordingDb({ aggregateChanges: 1 }) }),
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { ok: false, error: "Webhook event metadata does not match." });
});

function configuredEnv(overrides = {}) {
  return {
    AURORA_LEMONSQUEEZY_PRODUCT_ID: "aurora-product-2026",
    AURORA_LEMONSQUEEZY_WEBHOOK_SECRET: signingSecret,
    ...overrides,
  };
}

async function signedRequest(eventName, payload) {
  const body = JSON.stringify(payload);
  return new Request(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Event-Name": eventName,
      "X-Signature": await sign(body, signingSecret),
    },
    body,
  });
}

function orderPayload({ productId = "aurora-product-2026" } = {}) {
  return {
    meta: { event_name: "order_created" },
    data: {
      type: "orders",
      id: "order-123",
      attributes: {
        test_mode: true,
        user_name: "Buyer Name",
        user_email: "buyer@example.com",
        first_order_item: {
          product_id: productId,
          variant_id: "aurora-variant-2026",
        },
      },
    },
  };
}

function licensePayload() {
  return {
    meta: { event_name: "license_key_created" },
    data: {
      type: "license-keys",
      id: "license-resource-123",
      attributes: {
        test_mode: true,
        product_id: "aurora-product-2026",
        variant_id: "aurora-variant-2026",
        key: "must-not-be-stored",
        user_email: "buyer@example.com",
      },
    },
  };
}

function recordingDb({ aggregateChanges }) {
  return {
    prepared: [],
    batches: [],
    prepare(query) {
      this.prepared.push({ query });
      return {
        bind: (...values) => ({ query, values }),
      };
    },
    async batch(statements) {
      this.batches.push(statements);
      return [{ meta: { changes: 1 } }, { meta: { changes: aggregateChanges } }];
    },
  };
}

async function sign(body, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
