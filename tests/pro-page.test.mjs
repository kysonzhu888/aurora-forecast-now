import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeProConfig,
  publicProConfig,
  serializeProClientConfig,
} from "../tools/lib/pro-page.mjs";

test("Aurora Pro stays disabled and hides checkout data by default", () => {
  const config = normalizeProConfig({
    checkoutUrl: "https://example.lemonsqueezy.com/buy/aurora",
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
    () => normalizeProConfig({ enabled: true, checkoutUrl: "http://example.com/buy" }),
    /must use HTTPS/,
  );
});

test("serialized browser config escapes markup and caps saved locations", () => {
  const config = normalizeProConfig({
    enabled: true,
    checkoutUrl: "https://example.com/buy?<script>",
    storageKey: "</script><script>alert(1)</script>",
    maxSavedLocations: 99,
  });
  const serialized = serializeProClientConfig(config);

  assert.doesNotMatch(serialized, /<script>/);
  assert.match(serialized, /\\u003cscript>/);
  assert.equal(JSON.parse(serialized).maxSavedLocations, 5);
});
