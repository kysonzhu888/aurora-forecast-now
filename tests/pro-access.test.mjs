import assert from "node:assert/strict";
import test from "node:test";

import { handleProLicenseRequest } from "../lib/pro-access.mjs";

const endpoint = "https://auroraforecastnow.com/api/pro/license";

test("pro license endpoint rejects non-POST requests without calling Lemon Squeezy", async () => {
  let fetchCalled = false;
  const response = await handleProLicenseRequest(
    new Request(endpoint),
    configuredEnv(),
    { fetchImpl: async () => { fetchCalled = true; } },
  );

  assert.equal(response.status, 405);
  assert.equal(fetchCalled, false);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("pro license endpoint rejects malformed JSON and empty keys", async () => {
  const malformed = await handleProLicenseRequest(
    new Request(endpoint, { method: "POST", body: "{" }),
    configuredEnv(),
  );
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { ok: false, error: "Invalid JSON body." });

  const empty = await handleProLicenseRequest(jsonRequest({ licenseKey: "  " }), configuredEnv());
  assert.equal(empty.status, 400);
  assert.deepEqual(await empty.json(), { ok: false, error: "Enter an Aurora Pro access key." });
});

test("pro license endpoint fails closed before upstream validation when product config is absent", async () => {
  let fetchCalled = false;
  const response = await handleProLicenseRequest(
    jsonRequest({ licenseKey: "buyer-key" }),
    {},
    { fetchImpl: async () => { fetchCalled = true; } },
  );

  assert.equal(response.status, 503);
  assert.equal(fetchCalled, false);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "Aurora Pro purchases are not configured yet.",
  });
});

test("pro license endpoint accepts an Aurora-specific founder key without exposing the key", async () => {
  const founderKey = "aurora-founder-test-key";
  const response = await handleProLicenseRequest(
    jsonRequest({ licenseKey: founderKey }),
    { AURORA_PRO_FOUNDER_ACCESS_HASH: await sha256(founderKey) },
    { fetchImpl: async () => { throw new Error("founder access must not call upstream"); } },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    license: { status: "valid", productName: "Aurora Pro", source: "founder" },
  });
});

test("pro license endpoint maps upstream outages and unreadable responses to service errors", async () => {
  const networkFailure = await handleProLicenseRequest(
    jsonRequest({ licenseKey: "buyer-key" }),
    configuredEnv(),
    { fetchImpl: async () => { throw new Error("offline"); } },
  );
  assert.equal(networkFailure.status, 503);
  assert.deepEqual(await networkFailure.json(), {
    ok: false,
    error: "License validation is temporarily unavailable.",
  });

  const unreadable = await handleProLicenseRequest(
    jsonRequest({ licenseKey: "buyer-key" }),
    configuredEnv(),
    { fetchImpl: async () => new Response("not-json", { status: 200 }) },
  );
  assert.equal(unreadable.status, 502);
  assert.deepEqual(await unreadable.json(), {
    ok: false,
    error: "License validation returned an unreadable response.",
  });
});

test("pro license endpoint rejects invalid and wrong-product licenses", async () => {
  const invalid = await handleProLicenseRequest(
    jsonRequest({ licenseKey: "invalid-key" }),
    configuredEnv(),
    { fetchImpl: async () => Response.json({ valid: false, error: "license_key not found." }) },
  );
  assert.equal(invalid.status, 401);
  assert.deepEqual(await invalid.json(), { ok: false, error: "license_key not found." });

  const wrongProduct = await handleProLicenseRequest(
    jsonRequest({ licenseKey: "other-product-key" }),
    configuredEnv(),
    { fetchImpl: async () => Response.json(validLicensePayload({ productId: "1189903" })) },
  );
  assert.equal(wrongProduct.status, 403);
  assert.deepEqual(await wrongProduct.json(), {
    ok: false,
    error: "This access key belongs to a different product.",
  });
});

test("pro license endpoint accepts the configured Aurora product and omits customer PII", async () => {
  let upstreamBody = "";
  const response = await handleProLicenseRequest(
    jsonRequest({ licenseKey: "  buyer key  " }),
    configuredEnv(),
    {
      fetchImpl: async (_url, options) => {
        upstreamBody = String(options.body);
        return Response.json(validLicensePayload());
      },
    },
  );

  assert.equal(response.status, 200);
  assert.match(upstreamBody, /license_key=buyerkey/);
  assert.deepEqual(await response.json(), {
    ok: true,
    license: { status: "active", productName: "Aurora Pro Lifetime", source: "lemonsqueezy" },
  });
});

function configuredEnv() {
  return { AURORA_LEMONSQUEEZY_PRODUCT_ID: "aurora-product-2026" };
}

function jsonRequest(payload) {
  return new Request(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function validLicensePayload({ productId = "aurora-product-2026" } = {}) {
  return {
    valid: true,
    license_key: { status: "active", key: "must-not-leak" },
    meta: {
      product_id: productId,
      product_name: "Aurora Pro Lifetime",
      customer_email: "must-not-leak@example.com",
    },
  };
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
