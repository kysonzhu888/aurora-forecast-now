import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "assets", "pro-access.js"), "utf8");

test("Aurora client activates new keys and validates stored browser instances", () => {
  assert.match(source, /action:\s*"activate"/);
  assert.match(source, /action:\s*"validate"/);
  assert.match(source, /instanceId:\s*access\.instanceId/);
  assert.match(source, /createOpaqueInstanceName/);
});

test("Aurora client records checkout return only after a successful activation", () => {
  const successIndex = source.indexOf('trackFunnelEvent("license_success")');
  const returnIndex = source.indexOf('trackFunnelEvent("checkout_return")');
  assert.ok(successIndex > 0);
  assert.ok(returnIndex > successIndex);
  assert.doesNotMatch(source, /trackFunnelEvent\("purchase_completed"\)/);
});

test("Aurora manual lock releases Lemon Squeezy activation without blocking local lock", () => {
  assert.match(source, /action:\s*"deactivate"/);
  assert.match(source, /removeStorage\(storageKey\)/);
  assert.match(source, /activation could not be released/);
});

test("Aurora funnel payload contains only coarse anonymous dimensions", () => {
  const trackingFunction = source.slice(
    source.indexOf("function trackFunnelEvent"),
    source.indexOf("function consumeLicenseReturnFromUrl"),
  );
  assert.match(trackingFunction, /eventName/);
  assert.match(trackingFunction, /pageType/);
  assert.match(trackingFunction, /locationCount/);
  assert.doesNotMatch(trackingFunction, /license|email|order|instance/i);
});
