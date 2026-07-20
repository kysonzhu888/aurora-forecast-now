import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { nearestAurora } from "../lib/forecast-core.mjs";
import {
  buildAuroraGridIndex,
  nearestAuroraFromGrid,
} from "../lib/forecast-grid.mjs";
import {
  FORECAST_CACHE_KEY,
  FORECAST_METADATA_KEY,
  evaluateForecastHealth,
  readForecastMetadata,
  runScheduledRefresh,
  scheduledRefreshDecision,
} from "../lib/forecast-schedule.mjs";
import {
  handleAlertSubscribe,
  handleAlertToken,
  runAlertCron,
  runAlertCronIfConfigured,
  createAlertToken,
  hashAlertToken,
} from "../lib/alerts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cities = JSON.parse(fs.readFileSync(path.join(root, "data/cities.json"), "utf8"));
const fixedNowMs = Date.parse("2026-07-14T00:00:00.000Z");

function metadata(overrides = {}) {
  return {
    generatedAt: new Date(fixedNowMs - 60_000).toISOString(),
    stormMode: false,
    stormLevel: 0,
    ...overrides,
  };
}

function quietAlertInfo(overrides = {}) {
  return {
    level: 0,
    stormMode: false,
    summary: "No active storm.",
    ...overrides,
  };
}

function silentLogger() {
  return { info() {}, error() {} };
}

test("readForecastMetadata reads only the compact metadata key on the normal path", async () => {
  const getCalls = [];
  const kv = {
    async get(key, type) {
      getCalls.push([key, type]);
      assert.notEqual(key, FORECAST_CACHE_KEY, "cron must not deserialize the full forecast value");
      return metadata({ stormMode: "false", stormLevel: "1" });
    },
    async list() {
      assert.fail("compact metadata should avoid a KV list fallback");
    },
  };

  assert.deepEqual(await readForecastMetadata(kv), metadata({ stormMode: false, stormLevel: 1 }));
  assert.deepEqual(getCalls, [[FORECAST_METADATA_KEY, "json"]]);
});

test("readForecastMetadata migrates safely from legacy KV key metadata without reading its value", async () => {
  const getCalls = [];
  const kv = {
    async get(key, type) {
      getCalls.push([key, type]);
      return null;
    },
    async list(options) {
      assert.deepEqual(options, { prefix: FORECAST_CACHE_KEY, limit: 2 });
      return {
        keys: [{
          name: FORECAST_CACHE_KEY,
          metadata: metadata({ stormMode: "true", stormLevel: "2" }),
        }],
      };
    },
  };

  assert.deepEqual(await readForecastMetadata(kv), metadata({ stormMode: true, stormLevel: 2 }));
  assert.deepEqual(getCalls, [[FORECAST_METADATA_KEY, "json"]]);
});

test("scheduledRefreshDecision distinguishes fresh, expired, storm, and missing metadata", () => {
  assert.deepEqual(
    scheduledRefreshDecision(metadata(), quietAlertInfo(), 1_800, fixedNowMs),
    { shouldRefresh: false, reason: "normal-cache-fresh", ageSeconds: 60 },
  );
  assert.deepEqual(
    scheduledRefreshDecision(
      metadata({ generatedAt: new Date(fixedNowMs - 1_800_000).toISOString() }),
      quietAlertInfo(),
      1_800,
      fixedNowMs,
    ),
    { shouldRefresh: true, reason: "scheduled-normal-expired", ageSeconds: 1_800 },
  );
  assert.equal(
    scheduledRefreshDecision(metadata(), quietAlertInfo({ stormMode: true, level: 2 }), 1_800, fixedNowMs).reason,
    "scheduled-storm-mode",
  );
  assert.equal(
    scheduledRefreshDecision(null, quietAlertInfo(), 1_800, fixedNowMs).reason,
    "scheduled-cache-metadata-missing",
  );
});

test("scheduledRefreshDecision refreshes before the next five-minute cron would cross the SLA", () => {
  const refreshWindowMetadata = metadata({
    generatedAt: new Date(fixedNowMs - 1_699_000).toISOString(),
  });
  assert.deepEqual(
    scheduledRefreshDecision(
      refreshWindowMetadata,
      quietAlertInfo(),
      1_800,
      fixedNowMs,
      300,
    ),
    { shouldRefresh: true, reason: "scheduled-normal-refresh-window", ageSeconds: 1_699 },
  );
  assert.equal(
    scheduledRefreshDecision(
      metadata({ generatedAt: new Date(fixedNowMs - 1_499_000).toISOString() }),
      quietAlertInfo(),
      1_800,
      fixedNowMs,
      300,
    ).shouldRefresh,
    false,
  );
});

test("evaluateForecastHealth distinguishes healthy, degraded, and stale data", () => {
  const recentSchedule = {
    ok: true,
    status: "skipped",
    checkedAt: new Date(fixedNowMs - 5 * 60_000).toISOString(),
  };

  assert.deepEqual(
    evaluateForecastHealth({
      metadata: metadata(),
      scheduleState: recentSchedule,
      normalMaxAgeSeconds: 1_800,
      stormMaxAgeSeconds: 300,
      maxScheduleGapSeconds: 15 * 60,
      nowMs: fixedNowMs,
    }),
    {
      ok: true,
      status: "healthy",
      hasCache: true,
      dataFresh: true,
      scheduleHealthy: true,
      fallbackNeeded: false,
      ageSeconds: 60,
      maxAgeSeconds: 1_800,
      scheduleAgeSeconds: 300,
    },
  );

  const degraded = evaluateForecastHealth({
    metadata: metadata(),
    scheduleState: {
      ...recentSchedule,
      checkedAt: new Date(fixedNowMs - 60 * 60_000).toISOString(),
    },
    normalMaxAgeSeconds: 1_800,
    stormMaxAgeSeconds: 300,
    maxScheduleGapSeconds: 15 * 60,
    nowMs: fixedNowMs,
  });
  assert.equal(degraded.ok, true);
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.dataFresh, true);
  assert.equal(degraded.scheduleHealthy, false);
  assert.equal(degraded.fallbackNeeded, false);

  const unhealthy = evaluateForecastHealth({
    metadata: metadata({ generatedAt: new Date(fixedNowMs - 31 * 60_000).toISOString() }),
    scheduleState: recentSchedule,
    normalMaxAgeSeconds: 1_800,
    stormMaxAgeSeconds: 300,
    maxScheduleGapSeconds: 15 * 60,
    nowMs: fixedNowMs,
  });
  assert.equal(unhealthy.ok, false);
  assert.equal(unhealthy.status, "unhealthy");
  assert.equal(unhealthy.dataFresh, false);
  assert.equal(unhealthy.scheduleHealthy, true);
  assert.equal(unhealthy.fallbackNeeded, true);
});

test("runScheduledRefresh records a lightweight skipped health state", async () => {
  const written = [];
  let refreshCalled = false;
  const state = await runScheduledRefresh({
    scheduledTime: fixedNowMs,
    normalMaxAgeSeconds: 1_800,
    now: () => fixedNowMs,
    readMetadata: async () => metadata(),
    fetchAlerts: async () => [],
    parseAlerts: () => quietAlertInfo(),
    refresh: async () => {
      refreshCalled = true;
    },
    writeState: async (value) => written.push(value),
    logger: silentLogger(),
  });

  assert.equal(refreshCalled, false);
  assert.equal(state.status, "skipped");
  assert.equal(state.ok, true);
  assert.equal(state.reason, "normal-cache-fresh");
  assert.equal(state.ageSeconds, 60);
  assert.deepEqual(written, [state]);
});

test("runScheduledRefresh records success after a completed refresh", async () => {
  const written = [];
  const refreshedForecast = metadata({ generatedAt: "2026-07-14T00:00:01.000Z", stormLevel: 2 });
  const state = await runScheduledRefresh({
    scheduledTime: fixedNowMs,
    normalMaxAgeSeconds: 1_800,
    now: () => fixedNowMs,
    readMetadata: async () => null,
    fetchAlerts: async () => ["alert-row"],
    parseAlerts: () => quietAlertInfo(),
    refresh: async (options) => {
      assert.equal(options.reason, "scheduled-cache-metadata-missing");
      assert.deepEqual(options.preloadedAlerts, ["alert-row"]);
      return refreshedForecast;
    },
    writeState: async (value) => written.push(value),
    logger: silentLogger(),
  });

  assert.equal(state.status, "success");
  assert.equal(state.ok, true);
  assert.equal(state.refreshed, true);
  assert.equal(state.updatedAt, refreshedForecast.generatedAt);
  assert.deepEqual(written, [state]);
});

test("runScheduledRefresh records an active refresh lock without loading the forecast", async () => {
  const written = [];
  const state = await runScheduledRefresh({
    scheduledTime: fixedNowMs,
    normalMaxAgeSeconds: 1_800,
    now: () => fixedNowMs,
    readMetadata: async () => null,
    fetchAlerts: async () => [],
    parseAlerts: () => quietAlertInfo(),
    refresh: async () => null,
    writeState: async (value) => written.push(value),
    logger: silentLogger(),
  });

  assert.equal(state.status, "skipped");
  assert.equal(state.reason, "refresh-lock-active");
  assert.deepEqual(written, [state]);
});

test("runScheduledRefresh records an error and preserves rejection semantics", async () => {
  const written = [];
  const rootError = new Error("NOAA timeout");
  await assert.rejects(
    runScheduledRefresh({
      scheduledTime: fixedNowMs,
      normalMaxAgeSeconds: 1_800,
      now: () => fixedNowMs,
      readMetadata: async () => null,
      fetchAlerts: async () => [],
      parseAlerts: () => quietAlertInfo(),
      refresh: async () => {
        throw rootError;
      },
      writeState: async (value) => written.push(value),
      logger: silentLogger(),
    }),
    (error) => error === rootError,
  );

  assert.equal(written.length, 1);
  assert.equal(written[0].status, "error");
  assert.equal(written[0].ok, false);
  assert.equal(written[0].reason, "scheduled-cache-metadata-missing");
  assert.deepEqual(written[0].error, { name: "Error", message: "NOAA timeout" });
});

test("indexed aurora lookup matches the brute-force implementation for the saved city set", () => {
  const coordinates = [];
  for (let lon = 0; lon < 360; lon += 1) {
    for (let lat = -90; lat <= 90; lat += 1) {
      coordinates.push([lon, lat, (lon * 17 + lat * 13 + 9000) % 101]);
    }
  }
  const index = buildAuroraGridIndex(coordinates);
  assert.equal(index.indexedPointCount, coordinates.length);

  for (const city of cities) {
    assert.deepEqual(
      nearestAuroraFromGrid(index, coordinates, city),
      nearestAurora(coordinates, city),
      city.slug,
    );
  }
});

test("indexed aurora lookup falls back correctly for a sparse or malformed grid", () => {
  const coordinates = [[210, 65, 8], [147, -70, 5], ["bad", 51, 99]];
  const index = buildAuroraGridIndex(coordinates);
  const city = { lat: 64.84, lon: -147.72 };
  assert.deepEqual(nearestAuroraFromGrid(index, coordinates, city), nearestAurora(coordinates, city));
});

test("GitHub fallback repairs and validates the public health endpoint every fifteen minutes", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/aurora-health-fallback.yml"),
    "utf8",
  );

  assert.match(workflow, /cron:\s*["']7,22,37,52 \* \* \* \*["']/);
  assert.match(workflow, /aurora-forecast-now-api\.kysonzhu888\.workers\.dev/);
  assert.match(workflow, /api\/health\?repair=1/);
  assert.match(workflow, /\.ok == true and \.dataFresh == true/);
  assert.match(workflow, /Cloudflare cron is degraded/);
});

test("alert signup validates email and saves a pending subscription without returning secrets", async () => {
  const calls = [];
  const env = alertEnv(calls);
  const invalid = await handleAlertSubscribe(alertRequest({ email: "not-an-email" }), env);
  assert.equal(invalid.status, 400);
  const unknownCity = await handleAlertSubscribe(alertRequest({
    email: "viewer@example.com",
    citySlug: "made-up-city",
  }), env);
  assert.equal(unknownCity.status, 400);
  assert.equal(calls.length, 0);

  const response = await handleAlertSubscribe(alertRequest({
    email: " Viewer@Example.com ",
    citySlug: "fairbanks",
    threshold: 70,
  }), env);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true, status: "confirmation_pending", delivery: "email" });
  const stored = calls.find((call) => /INSERT OR IGNORE INTO alert_subscriptions/.test(call.query)).values;
  const tokenUpdate = calls.find((call) => /UPDATE alert_subscriptions SET/.test(call.query)).values;
  assert.equal(stored.includes("viewer@example.com"), true);
  assert.equal(stored.includes("fairbanks"), true);
  assert.equal(stored.includes(70), true);
  assert.equal(tokenUpdate.some((value) => /^[a-f0-9]{64}$/.test(String(value))), true);
  assert.equal(tokenUpdate.some((value) => String(value).includes("confirm.")), false);
  assert.equal(env.sent.length, 1);
  assert.deepEqual(env.sent[0].from, {
    email: "alerts@auroraforecastnow.com",
    name: "Aurora Forecast Now",
  });
  assert.equal(env.sent[0].to, "viewer@example.com");
  assert.match(env.sent[0].text, /Confirm storm alerts/);
  assert.match(env.sent[0].text, /Unsubscribe/);
  assert.match(env.sent[0].html, /Confirm storm alerts/);
  assert.match(env.sent[0].html, /auroraforecastnow\.com\/api\/alerts\/confirm/);
  assert.equal("raw" in env.sent[0], false);
});

test("alert signup can use the signed TinyNeed email relay without exposing its secret", async () => {
  const calls = [];
  const env = alertEnv(calls, { relay: true });
  const response = await handleAlertSubscribe(alertRequest({
    email: "relay-viewer@example.com",
    citySlug: "fairbanks",
    threshold: 60,
  }), env);

  assert.deepEqual(await response.json(), {
    ok: true,
    status: "confirmation_pending",
    delivery: "email",
  });
  assert.equal(env.relayRequests.length, 1);
  const relayRequest = env.relayRequests[0];
  assert.equal(relayRequest.url, "https://tinyneed.com/api/aurora-email");
  assert.match(relayRequest.headers["X-Aurora-Timestamp"], /^\d+$/);
  assert.match(relayRequest.headers["X-Aurora-Signature"], /^v1=[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(relayRequest).includes(env.ALERT_EMAIL_RELAY_SECRET), false);
  assert.deepEqual(Object.keys(relayRequest.body).sort(), ["html", "subject", "text", "to"]);
  assert.equal(relayRequest.body.to, "relay-viewer@example.com");
  assert.match(relayRequest.body.html, /Confirm storm alerts/);
});

test("duplicate alert signup stays non-enumerating and email outages fail closed as waitlist", async () => {
  const calls = [];
  const env = alertEnv(calls);
  const first = await handleAlertSubscribe(alertRequest({ email: "same@example.com", citySlug: "tromso" }), env);
  const duplicate = await handleAlertSubscribe(alertRequest({ email: "same@example.com", citySlug: "tromso" }), env);
  assert.deepEqual(await duplicate.json(), await first.json());

  const offline = await handleAlertSubscribe(alertRequest({ email: "saved@example.com", citySlug: "tromso" }), {
    COMMENTS_DB: env.COMMENTS_DB,
  });
  assert.equal(offline.status, 201);
  assert.deepEqual(await offline.json(), { ok: true, status: "waitlist", delivery: "unavailable" });
});

test("an active duplicate updates settings without sending another confirmation request", async () => {
  const calls = [];
  const existingId = "active-subscription";
  const tokenSecret = "test-only-alert-token-secret";
  const unsubscribeToken = await createAlertToken("unsubscribe", existingId, tokenSecret);
  const env = alertEnv(calls, {
    existingId,
    existingStatus: "active",
    existingUnsubscribeHash: await hashAlertToken(unsubscribeToken),
  });

  const response = await handleAlertSubscribe(alertRequest({
    email: "active@example.com",
    citySlug: "fairbanks",
    threshold: 80,
  }), env);

  assert.deepEqual(await response.json(), {
    ok: true,
    status: "confirmation_pending",
    delivery: "email",
  });
  assert.equal(env.sent.length, 1);
  assert.match(env.sent[0].subject, /settings updated/i);
  assert.match(env.sent[0].text, /Score 80/);
  assert.match(env.sent[0].text, /unsubscribe\?token=/);
  assert.doesNotMatch(env.sent[0].text, /confirm\?token=/);
});

test("confirmation and one-click unsubscribe accept only hashed-token matches", async () => {
  const calls = [];
  const env = alertEnv(calls, { tokenChanges: 1 });
  const confirmed = await handleAlertToken(
    new Request("https://auroraforecastnow.com/api/alerts/confirm?token=confirm-secret"),
    env,
    "confirm",
  );
  assert.equal(confirmed.status, 200);
  assert.match(await confirmed.text(), /Alerts confirmed/);
  assert.equal(calls.at(-1).values.includes("confirm-secret"), false);
  assert.equal(calls.at(-1).values.some((value) => /^[a-f0-9]{64}$/.test(String(value))), true);

  const unsubscribed = await handleAlertToken(
    new Request("https://auroraforecastnow.com/api/alerts/unsubscribe?token=unsubscribe-secret"),
    env,
    "unsubscribe",
  );
  assert.equal(unsubscribed.status, 200);
  assert.match(await unsubscribed.text(), /Unsubscribed/);

  const invalid = await handleAlertToken(
    new Request("https://auroraforecastnow.com/api/alerts/confirm?token=wrong"),
    alertEnv([], { tokenChanges: 0 }),
    "confirm",
  );
  assert.equal(invalid.status, 400);
  assert.doesNotMatch(await invalid.text(), /wrong/);
});

test("alert cron sends threshold matches once and includes forecast details and private action links", async () => {
  const calls = [];
  const tokenSecret = "test-only-alert-token-secret";
  const unsubscribeToken = await createAlertToken("unsubscribe", "sub-1", tokenSecret);
  const env = alertEnv(calls, {
    candidates: [{
      id: "sub-1",
      email: "viewer@example.com",
      city_slug: "fairbanks",
      threshold: 60,
      unsubscribe_token_hash: await hashAlertToken(unsubscribeToken),
    }],
    deliveryChanges: [1, 0],
  });
  const forecast = {
    generatedAt: "2026-07-21T01:02:03.000Z",
    maxKp: 6,
    cities: [{ slug: "fairbanks", name: "Fairbanks", score: 82 }],
  };

  const first = await runAlertCron(env, forecast);
  const second = await runAlertCron(env, forecast);
  assert.deepEqual(first, { configured: true, matched: 1, sent: 1 });
  assert.deepEqual(second, { configured: true, matched: 1, sent: 0 });
  assert.equal(env.sent.length, 1);
  assert.match(env.sent[0].text, /Fairbanks/);
  assert.match(env.sent[0].text, /Score 82/);
  assert.match(env.sent[0].text, /Kp 6/);
  assert.match(env.sent[0].text, /cities\/fairbanks/);
  assert.match(env.sent[0].text, /unsubscribe\?token=/);
  assert.equal(JSON.stringify(first).includes("viewer@example.com"), false);
});

test("alert cron does not load the forecast when email delivery is unavailable", async () => {
  let forecastLoads = 0;
  const result = await runAlertCronIfConfigured({}, async () => {
    forecastLoads += 1;
    return { generatedAt: "2026-07-21T01:02:03.000Z", cities: [] };
  });

  assert.deepEqual(result, { configured: false, matched: 0, sent: 0 });
  assert.equal(forecastLoads, 0);
});

test("alert D1 migration is rerunnable and preserves legacy waitlist rows", () => {
  const schema = fs.readFileSync(path.join(root, "schema.sql"), "utf8");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS alert_subscriptions/);
  assert.match(schema, /INSERT OR IGNORE INTO alert_subscriptions[\s\S]*FROM alert_signups/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS alert_deliveries/);
  assert.doesNotMatch(schema, /ALTER TABLE alert_signups/);
});

function alertRequest(payload) {
  return new Request("https://auroraforecastnow.com/api/alerts/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function alertEnv(calls, options = {}) {
  let deliveryIndex = 0;
  const env = {
    ALERT_FROM_EMAIL: "alerts@auroraforecastnow.com",
    ALERT_TOKEN_SECRET: "test-only-alert-token-secret",
    alertCitySlugs: new Set(["fairbanks", "tromso"]),
    sent: [],
    EMAIL: {
      async send(message) {
        env.sent.push(message);
      },
    },
    COMMENTS_DB: {
      prepare(query) {
        const call = { query };
        calls.push(call);
        return {
          bind(...values) {
            call.values = values;
            return {
              async run() {
                if (/INSERT OR IGNORE INTO alert_deliveries/.test(query)) {
                  return { meta: { changes: options.deliveryChanges?.[deliveryIndex++] ?? 1 } };
                }
                if (/confirmation_token_hash|unsubscribe_token_hash/.test(query) && /UPDATE/.test(query)) {
                  return { meta: { changes: options.tokenChanges ?? 1 } };
                }
                return { meta: { changes: 1 } };
              },
              async all() {
                return { results: options.candidates || [] };
              },
              async first() {
                return {
                  id: options.existingId || calls.find((item) => /INSERT OR IGNORE INTO alert_subscriptions/.test(item.query))?.values?.[0],
                  status: options.existingStatus || "waitlist",
                  unsubscribe_token_hash: options.existingUnsubscribeHash || null,
                };
              },
            };
          },
          async all() {
            return { results: options.candidates || [] };
          },
        };
      },
    },
  };
  if (options.relay) {
    delete env.EMAIL;
    env.ALERT_EMAIL_RELAY_URL = "https://tinyneed.com/api/aurora-email";
    env.ALERT_EMAIL_RELAY_SECRET = "test-only-email-relay-secret-with-32-bytes";
    env.relayRequests = [];
    env.ALERT_FETCH = async (url, init) => {
      env.relayRequests.push({
        url,
        headers: init.headers,
        body: JSON.parse(init.body),
      });
      return Response.json({ ok: true });
    };
  }
  return env;
}
