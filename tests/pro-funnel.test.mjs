import assert from "node:assert/strict";
import test from "node:test";

import { handleProFunnelRequest } from "../lib/pro-funnel.mjs";

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

function jsonRequest(payload) {
  return new Request(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
