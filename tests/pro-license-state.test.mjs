import assert from "node:assert/strict";
import test from "node:test";

import {
  createOpaqueInstanceName,
  normalizeStoredAccess,
  parseLicenseReturnUrl,
} from "../assets/pro-license-state.mjs";

test("license return parser consumes fragment keys without sending them to the server", () => {
  const result = parseLicenseReturnUrl(
    "https://auroraforecastnow.com/pro/#license_key=abc-123&order_id=private-order",
  );

  assert.equal(result.licenseKey, "abc-123");
  assert.equal(result.hadSensitiveParams, true);
  assert.equal(result.cleanUrl, "/pro/");
  assert.doesNotMatch(result.cleanUrl, /abc-123|private-order/);
});

test("license return parser supports legacy query links and preserves safe attribution", () => {
  const result = parseLicenseReturnUrl(
    "https://auroraforecastnow.com/pro/?utm_source=receipt&licenseKey=abc-123#details",
  );

  assert.equal(result.licenseKey, "abc-123");
  assert.equal(result.cleanUrl, "/pro/?utm_source=receipt#details");
});

test("license return parser scrubs oversized keys instead of truncating them", () => {
  const result = parseLicenseReturnUrl(
    `https://auroraforecastnow.com/pro/#license_key=${"a".repeat(121)}`,
  );

  assert.equal(result.licenseKey, "");
  assert.equal(result.hadSensitiveParams, true);
  assert.equal(result.cleanUrl, "/pro/");
});

test("browser activation names are opaque and contain no device fingerprint", () => {
  const instanceName = createOpaqueInstanceName({
    randomUUID: () => "01234567-89ab-cdef-0123-456789abcdef",
  });

  assert.equal(instanceName, "Aurora Web 01234567-89ab-cdef-0123-456789abcdef");
  assert.doesNotMatch(instanceName, /mac|iphone|kyson/i);
});

test("stored access keeps only a valid key, source and browser instance", () => {
  assert.deepEqual(normalizeStoredAccess({
    unlocked: true,
    licenseKey: " abc-123 ",
    source: "lemonsqueezy",
    instanceId: "47596AD9-A811-4EBF-AC8A-03FC7B6D2A17",
    customerEmail: "must-not-survive@example.com",
  }), {
    unlocked: true,
    licenseKey: "abc-123",
    source: "lemonsqueezy",
    instanceId: "47596ad9-a811-4ebf-ac8a-03fc7b6d2a17",
  });

  assert.equal(normalizeStoredAccess({ unlocked: true, licenseKey: "" }), null);
});
