import assert from "node:assert/strict";
import test from "node:test";

import {
  handleProFunnelRequest,
  recordDeduplicatedProWebhookEvent,
} from "../lib/pro-funnel.mjs";

const endpoint = "https://auroraforecastnow.com/api/pro/funnel";

test("pro funnel rejects unsupported events without touching D1", async () => {
  let prepared = false;
  const response = await handleProFunnelRequest(jsonRequest({
    eventName: "email_captured",
    pageType: "pro",
    locationCount: 2,
    email: "must-not-be-stored@example.com",
  }), {
    COMMENTS_DB: { prepare() { prepared = true; } },
  });

  assert.equal(response.status, 400);
  assert.equal(prepared, false);
  assert.deepEqual(await response.json(), { error: "Unsupported Pro funnel event." });
});

test("public funnel requests cannot forge server-side purchase completion", async () => {
  let prepared = false;
  const response = await handleProFunnelRequest(jsonRequest({
    eventName: "purchase_completed",
    pageType: "webhook_live",
    locationCount: 0,
  }), {
    COMMENTS_DB: { prepare() { prepared = true; } },
  });

  assert.equal(response.status, 400);
  assert.equal(prepared, false);
  assert.deepEqual(await response.json(), { error: "Unsupported Pro funnel event." });
});

test("pro funnel requires its aggregate D1 binding", async () => {
  const response = await handleProFunnelRequest(jsonRequest({
    eventName: "pro_view",
    pageType: "pro",
    locationCount: 0,
  }), {});

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Pro funnel storage is unavailable." });
});

test("pro funnel increments only an anonymous daily aggregate", async () => {
  const calls = [];
  const response = await handleProFunnelRequest(jsonRequest({
    eventName: "comparison_run",
    pageType: "pro",
    locationCount: 99,
    city: "Tromso",
    licenseKey: "must-not-be-stored",
  }), {
    COMMENTS_DB: {
      prepare(query) {
        calls.push({ query });
        return {
          bind(...values) {
            calls.at(-1).values = values;
            return { async run() { calls.at(-1).ran = true; } };
          },
        };
      },
    },
  });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /ON CONFLICT/);
  assert.doesNotMatch(calls[0].query, /city|email|license/i);
  assert.deepEqual(calls[0].values, ["comparison_run", "pro", 5]);
  assert.equal(calls[0].ran, true);
});

test("trusted webhook events atomically deduplicate purchase aggregates without customer data", async () => {
  const prepared = [];
  const batches = [];
  const recorded = await recordDeduplicatedProWebhookEvent({
    COMMENTS_DB: {
      prepare(query) {
        const statement = { query };
        prepared.push(statement);
        return {
          bind(...values) {
            return { query, values };
          },
        };
      },
      async batch(statements) {
        batches.push(statements);
        return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
      },
    },
  }, {
    receiptHash: "a".repeat(64),
    sourceEventName: "order_created",
    funnelEventName: "purchase_completed",
    pageType: "webhook_test",
    testMode: true,
  });

  assert.equal(recorded, true);
  assert.equal(prepared.length, 2);
  assert.match(prepared[0].query, /INSERT OR IGNORE INTO pro_webhook_receipts/);
  assert.match(prepared[1].query, /WHERE changes\(\) = 1/);
  assert.deepEqual(batches[0][0].values, ["a".repeat(64), "order_created", 1]);
  assert.deepEqual(batches[0][1].values, ["purchase_completed", "webhook_test"]);
});

function jsonRequest(payload) {
  return new Request(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
