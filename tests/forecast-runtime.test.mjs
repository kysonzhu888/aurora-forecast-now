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
