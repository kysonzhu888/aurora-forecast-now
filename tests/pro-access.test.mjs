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

test("pro license endpoint accepts a valid newly purchased key before device activation", async () => {
  const response = await handleProLicenseRequest(
    jsonRequest({ licenseKey: "new-buyer-key" }),
    configuredEnv(),
    { fetchImpl: async () => Response.json(validLicensePayload({ status: "inactive" })) },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    license: { status: "inactive", productName: "Aurora Pro Lifetime", source: "lemonsqueezy" },
  });
});

test("pro license endpoint validates product identity before activating an opaque browser instance", async () => {
  const upstreamCalls = [];
  const response = await handleProLicenseRequest(
    jsonRequest({
      action: "activate",
      licenseKey: "new-buyer-key",
      instanceName: "Aurora Web 01234567-89ab-cdef-0123-456789abcdef",
    }),
    configuredEnv(),
    {
      fetchImpl: async (url, options) => {
        upstreamCalls.push({ url, body: String(options.body) });
        if (String(url).endsWith("/validate")) {
          return Response.json(validLicensePayload({ status: "inactive" }));
        }
        return Response.json({
          activated: true,
          error: null,
          license_key: { status: "active", key: "must-not-leak" },
          instance: { id: "47596ad9-a811-4ebf-ac8a-03fc7b6d2a17", name: "must-not-leak" },
          meta: {
            product_id: "aurora-product-2026",
            product_name: "Aurora Pro Lifetime",
            customer_email: "must-not-leak@example.com",
          },
        });
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(upstreamCalls.length, 2);
  assert.match(upstreamCalls[0].url, /\/licenses\/validate$/);
  assert.match(upstreamCalls[1].url, /\/licenses\/activate$/);
  assert.match(upstreamCalls[1].body, /instance_name=Aurora\+Web\+01234567-89ab-cdef-0123-456789abcdef/);
  assert.deepEqual(await response.json(), {
    ok: true,
    license: {
      status: "active",
      productName: "Aurora Pro Lifetime",
      source: "lemonsqueezy",
      instanceId: "47596ad9-a811-4ebf-ac8a-03fc7b6d2a17",
    },
  });
});

test("pro license endpoint never activates a key for another product", async () => {
  let callCount = 0;
  const response = await handleProLicenseRequest(
    jsonRequest({
      action: "activate",
      licenseKey: "other-product-key",
      instanceName: "Aurora Web 01234567-89ab-cdef-0123-456789abcdef",
    }),
    configuredEnv(),
    {
      fetchImpl: async () => {
        callCount += 1;
        return Response.json(validLicensePayload({ productId: "other-product" }));
      },
    },
  );

  assert.equal(response.status, 403);
  assert.equal(callCount, 1);
});

test("pro license endpoint validates a stored instance instead of the whole key", async () => {
  let upstreamBody = "";
  const response = await handleProLicenseRequest(
    jsonRequest({
      action: "validate",
      licenseKey: "buyer-key",
      instanceId: "47596ad9-a811-4ebf-ac8a-03fc7b6d2a17",
    }),
    configuredEnv(),
    {
      fetchImpl: async (_url, options) => {
        upstreamBody = String(options.body);
        return Response.json({
          ...validLicensePayload(),
          instance: { id: "47596ad9-a811-4ebf-ac8a-03fc7b6d2a17", name: "must-not-leak" },
        });
      },
    },
  );

  assert.match(upstreamBody, /instance_id=47596ad9-a811-4ebf-ac8a-03fc7b6d2a17/);
  assert.deepEqual(await response.json(), {
    ok: true,
    license: {
      status: "active",
      productName: "Aurora Pro Lifetime",
      source: "lemonsqueezy",
      instanceId: "47596ad9-a811-4ebf-ac8a-03fc7b6d2a17",
    },
  });
});

test("pro license endpoint verifies product ownership before deactivating an instance", async () => {
  const upstreamCalls = [];
  const response = await handleProLicenseRequest(
    jsonRequest({
      action: "deactivate",
      licenseKey: "buyer-key",
      instanceId: "47596ad9-a811-4ebf-ac8a-03fc7b6d2a17",
    }),
    configuredEnv(),
    {
      fetchImpl: async (url, options) => {
        upstreamCalls.push({ url, body: String(options.body) });
        if (String(url).endsWith("/validate")) {
          return Response.json({
            ...validLicensePayload(),
            instance: { id: "47596ad9-a811-4ebf-ac8a-03fc7b6d2a17" },
          });
        }
        return Response.json({ deactivated: true, error: null });
      },
    },
  );

  assert.equal(upstreamCalls.length, 2);
  assert.match(upstreamCalls[1].url, /\/licenses\/deactivate$/);
  assert.match(upstreamCalls[1].body, /instance_id=47596ad9-a811-4ebf-ac8a-03fc7b6d2a17/);
  assert.deepEqual(await response.json(), { ok: true, deactivated: true });
});

test("pro license endpoint rejects malformed instance contracts before upstream calls", async () => {
  let fetchCalled = false;
  const options = { fetchImpl: async () => { fetchCalled = true; } };

  const invalidName = await handleProLicenseRequest(jsonRequest({
    action: "activate",
    licenseKey: "buyer-key",
    instanceName: "Kyson's MacBook",
  }), configuredEnv(), options);
  assert.equal(invalidName.status, 400);

  const invalidId = await handleProLicenseRequest(jsonRequest({
    action: "deactivate",
    licenseKey: "buyer-key",
    instanceId: "not-a-uuid",
  }), configuredEnv(), options);
  assert.equal(invalidId.status, 400);
  assert.equal(fetchCalled, false);
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

function validLicensePayload({ productId = "aurora-product-2026", status = "active" } = {}) {
  return {
    valid: true,
    license_key: { status, key: "must-not-leak" },
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
