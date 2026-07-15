import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeProConfig,
  publicProConfig,
  serializeProClientConfig,
} from "../tools/lib/pro-page.mjs";

const AURORA_CHECKOUT_URL =
  "https://auroraforecastnow.lemonsqueezy.com/checkout/buy/00000000-0000-4000-8000-000000000000";

test("Aurora Pro stays disabled and hides checkout data by default", () => {
  const config = normalizeProConfig({
    checkoutUrl: AURORA_CHECKOUT_URL,
  });

  assert.equal(config.enabled, false);
  assert.equal(publicProConfig(config).checkoutUrl, "");
});

test("Aurora Pro cannot be enabled without a dedicated HTTPS checkout", () => {
  assert.throws(
    () => normalizeProConfig({ enabled: true }),
    /checkoutUrl is required/,
  );
  assert.throws(
    () => normalizeProConfig({ enabled: true, checkoutUrl: AURORA_CHECKOUT_URL.replace("https://", "http://") }),
    /must use HTTPS/,
  );
  assert.throws(
    () => normalizeProConfig({
      enabled: true,
      checkoutUrl: "https://gameguidebase.lemonsqueezy.com/checkout/buy/1fb81c2d-6ff1-411d-8fd9-eeee319d5145",
    }),
    /dedicated Aurora checkout/,
  );
  assert.throws(
    () => normalizeProConfig({
      enabled: true,
      checkoutUrl: "https://auroraforecastnow.lemonsqueezy.com/products/123",
    }),
    /checkout\/buy/,
  );
});

test("serialized browser config escapes markup and caps saved locations", () => {
  const config = normalizeProConfig({
    enabled: true,
    checkoutUrl: `${AURORA_CHECKOUT_URL}?note=<script>`,
    storageKey: "</script><script>alert(1)</script>",
    maxSavedLocations: 99,
  });
  const serialized = serializeProClientConfig(config);

  assert.doesNotMatch(serialized, /<script>/);
  assert.match(serialized, /\\u003cscript>/);
  assert.equal(JSON.parse(serialized).maxSavedLocations, 5);
});
