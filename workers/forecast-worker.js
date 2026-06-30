import cities from "../data/cities.json";
import media from "../data/media.json";

const CACHE_KEY = "forecast:latest";
const LOCK_KEY = "forecast:refresh-lock";
const NORMAL_MAX_AGE_SECONDS = 30 * 60;
const STORM_MAX_AGE_SECONDS = 5 * 60;
const LOCK_TTL_SECONDS = 90;
const FALLBACK_FORECAST_URL = "https://auroraforecastnow.com/data/forecast.json";

const endpoints = {
  ovation: "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json",
  kp: "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json",
  alerts: "https://services.swpc.noaa.gov/products/alerts.json",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
    if (url.pathname === "/api/health") return handleHealth(env);
    if (url.pathname === "/api/forecast") return handleForecast(request, env, ctx);
    return withCors(jsonResponse({ error: "Not found" }, 404));
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduledRefresh(env, event.scheduledTime));
  },
};

async function handleForecast(request, env, ctx) {
  const url = new URL(request.url);
  const citySlug = url.searchParams.get("city");
  const cached = await readCachedForecast(env);

  if (cached) {
    const ageSeconds = ageOf(cached);
    const maxAgeSeconds = maxAgeFor(cached);
    const status = ageSeconds > maxAgeSeconds ? "stale" : "fresh";
    if (status === "stale") {
      ctx.waitUntil(refreshWithLock(env, { reason: "request-stale" }));
    }
    return withCors(jsonResponse(shapeResponse(cached, { status, ageSeconds, maxAgeSeconds, citySlug })));
  }

  try {
    const fresh = await refreshWithLock(env, { reason: "request-empty-cache" });
    if (fresh) {
      return withCors(jsonResponse(shapeResponse(fresh, {
        status: "fresh",
        ageSeconds: 0,
        maxAgeSeconds: maxAgeFor(fresh),
        citySlug,
      })));
    }
  } catch (error) {
    console.warn(`Initial refresh failed: ${error.message}`);
  }

  const fallback = await fetchFallbackForecast();
  return withCors(jsonResponse(shapeResponse(fallback, {
    status: "fallback",
    ageSeconds: ageOf(fallback),
    maxAgeSeconds: NORMAL_MAX_AGE_SECONDS,
    citySlug,
    warning: "Serving static fallback because KV cache is empty.",
  })));
}

async function handleHealth(env) {
  const cached = await readCachedForecast(env);
  return withCors(jsonResponse({
    ok: true,
    hasCache: Boolean(cached),
    updatedAt: cached?.generatedAt || null,
    ageSeconds: cached ? ageOf(cached) : null,
    stormMode: Boolean(cached?.stormMode),
    stormLevel: cached?.stormLevel || 0,
  }));
}

async function handleScheduledRefresh(env, scheduledTime) {
  const cached = await readCachedForecast(env);
  const alerts = await fetchJson(endpoints.alerts, "alerts");
  const alertInfo = parseAlertInfo(alerts);
  const ageSeconds = cached ? ageOf(cached) : Number.POSITIVE_INFINITY;
  const shouldRefresh = !cached || alertInfo.stormMode || ageSeconds >= NORMAL_MAX_AGE_SECONDS;

  if (!shouldRefresh) {
    await writeScheduleState(env, {
      skipped: true,
      reason: "normal-cache-fresh",
      scheduledTime,
      ageSeconds,
      alertInfo,
    });
    return;
  }

  await refreshWithLock(env, {
    reason: alertInfo.stormMode ? "scheduled-storm-mode" : "scheduled-normal-expired",
    preloadedAlerts: alerts,
    preloadedAlertInfo: alertInfo,
  });
}

async function refreshWithLock(env, options = {}) {
  const existingLock = await env.AURORA_FORECAST_CACHE.get(LOCK_KEY);
  if (existingLock) return readCachedForecast(env);

  await env.AURORA_FORECAST_CACHE.put(LOCK_KEY, JSON.stringify({
    createdAt: new Date().toISOString(),
    reason: options.reason || "unknown",
  }), { expirationTtl: LOCK_TTL_SECONDS });

  try {
    const forecast = await buildForecast(options);
    await env.AURORA_FORECAST_CACHE.put(CACHE_KEY, JSON.stringify(forecast), {
      expirationTtl: 7 * 24 * 60 * 60,
      metadata: {
        generatedAt: forecast.generatedAt,
        stormMode: String(forecast.stormMode),
        stormLevel: String(forecast.stormLevel),
      },
    });
    return forecast;
  } finally {
    await env.AURORA_FORECAST_CACHE.delete(LOCK_KEY);
  }
}

async function buildForecast(options = {}) {
  const startedAt = Date.now();
  const [ovation, kpRows, alerts, cloudBySlug] = await Promise.all([
    fetchJson(endpoints.ovation, "ovation"),
    fetchJson(endpoints.kp, "kp"),
    Promise.resolve(options.preloadedAlerts || fetchJson(endpoints.alerts, "alerts")),
    fetchCloudCover(cities),
  ]);

  const alertInfo = options.preloadedAlertInfo || parseAlertInfo(alerts);
  const coordinates = Array.isArray(ovation?.coordinates) ? ovation.coordinates : [];
  const maxKp = maxUpcomingKp(kpRows);
  const cityForecasts = cities
    .map((city) => {
      const aurora = nearestAurora(coordinates, city);
      const clouds = cloudBySlug.get(city.slug) || { bestCloud: null, avgCloud: null };
      const score = scoreCity(city, aurora.value, maxKp, clouds.bestCloud);
      const label = labelForScore(score);
      return {
        ...city,
        aurora: aurora.value,
        gridLat: aurora.lat,
        gridLon: aurora.lon,
        bestCloud: clouds.bestCloud,
        avgCloud: clouds.avgCloud,
        score,
        label,
        watchWindow: "10:00 PM to 2:00 AM local time",
        guidance: guidanceFor(city, score, maxKp, clouds.bestCloud),
      };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return {
    generatedAt: new Date().toISOString(),
    observationTime: ovation?.["Observation Time"] || "",
    forecastTime: ovation?.["Forecast Time"] || "",
    maxKp,
    stormSummary: alertInfo.summary,
    stormMode: alertInfo.stormMode,
    stormLevel: alertInfo.level,
    refreshPolicy: {
      normalMaxAgeSeconds: NORMAL_MAX_AGE_SECONDS,
      stormMaxAgeSeconds: STORM_MAX_AGE_SECONDS,
      mode: alertInfo.stormMode ? "storm" : "normal",
    },
    dataSources: media.dataSources,
    cities: cityForecasts,
    mapDots: buildMapDots(coordinates),
    worker: {
      reason: options.reason || "manual",
      durationMs: Date.now() - startedAt,
    },
  };
}

async function fetchJson(url, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 16000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "AuroraForecastNow/0.2 hello@auroraforecastnow.com" },
    });
    if (!response.ok) throw new Error(`${label} ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCloudCover(cityRows) {
  const result = new Map();
  const chunkSize = 25;
  for (let i = 0; i < cityRows.length; i += chunkSize) {
    const chunk = cityRows.slice(i, i + chunkSize);
    const lat = chunk.map((city) => city.lat).join(",");
    const lon = chunk.map((city) => city.lon).join(",");
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=cloud_cover&timezone=UTC&forecast_days=2`;
    const json = await fetchJson(url, "open-meteo");
    const rows = Array.isArray(json) ? json : json ? [json] : [];
    rows.forEach((row, index) => {
      const city = chunk[index];
      const cloudValues = (row?.hourly?.cloud_cover || []).slice(0, 24).filter((value) => Number.isFinite(value));
      const bestCloud = cloudValues.length ? Math.min(...cloudValues) : null;
      const avgCloud = cloudValues.length ? Math.round(cloudValues.reduce((sum, value) => sum + value, 0) / cloudValues.length) : null;
      result.set(city.slug, { bestCloud, avgCloud });
    });
  }
  return result;
}

async function fetchFallbackForecast() {
  const response = await fetch(FALLBACK_FORECAST_URL, {
    headers: { "User-Agent": "AuroraForecastNow/0.2 fallback" },
  });
  if (!response.ok) throw new Error(`fallback ${response.status}`);
  const data = await response.json();
  return {
    ...data,
    stormMode: Boolean(data.stormMode),
    stormLevel: Number(data.stormLevel || 0),
    refreshPolicy: data.refreshPolicy || {
      normalMaxAgeSeconds: NORMAL_MAX_AGE_SECONDS,
      stormMaxAgeSeconds: STORM_MAX_AGE_SECONDS,
      mode: data.stormMode ? "storm" : "normal",
    },
  };
}

function parseAlertInfo(rows) {
  if (!Array.isArray(rows)) {
    return {
      level: 0,
      stormMode: false,
      summary: "No current NOAA alert summary was available during the last refresh.",
    };
  }

  const messages = rows.map((row) => row.message || "").filter(Boolean);
  const level = messages.reduce((max, message) => {
    const matches = [...message.matchAll(/\bG([1-5])\b/g)].map((match) => Number(match[1]));
    return Math.max(max, ...matches, 0);
  }, 0);
  const storm = messages.find((message) => /Geomagnetic Storm|G[1-5]/i.test(message));
  if (!storm) {
    return {
      level,
      stormMode: level >= 2,
      summary: "No active geomagnetic storm watch appeared in the latest NOAA alert feed.",
    };
  }

  const summary = storm
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /WATCH|WARNING|ALERT|G[1-5]|Predicted|Observed|Highest Storm Level/i.test(line))
    .slice(0, 4)
    .join(" ");

  return {
    level,
    stormMode: level >= 2,
    summary,
  };
}

function shapeResponse(forecast, meta) {
  const city = meta.citySlug ? forecast.cities.find((candidate) => candidate.slug === meta.citySlug) || null : null;
  return {
    ...forecast,
    city,
    cache: {
      status: meta.status,
      warning: meta.warning || null,
      ageSeconds: Math.max(0, Math.round(meta.ageSeconds || 0)),
      maxAgeSeconds: meta.maxAgeSeconds,
      updatedAt: forecast.generatedAt,
      refreshMode: forecast.stormMode ? "storm" : "normal",
      refreshAfterSeconds: Math.max(0, meta.maxAgeSeconds - Math.round(meta.ageSeconds || 0)),
    },
  };
}

async function readCachedForecast(env) {
  return env.AURORA_FORECAST_CACHE.get(CACHE_KEY, "json");
}

async function writeScheduleState(env, state) {
  await env.AURORA_FORECAST_CACHE.put("forecast:last-schedule", JSON.stringify({
    ...state,
    checkedAt: new Date().toISOString(),
  }), { expirationTtl: 2 * 24 * 60 * 60 });
}

function ageOf(forecast) {
  const generatedAt = new Date(forecast.generatedAt).getTime();
  if (!Number.isFinite(generatedAt)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.round((Date.now() - generatedAt) / 1000));
}

function maxAgeFor(forecast) {
  return forecast.stormMode ? STORM_MAX_AGE_SECONDS : NORMAL_MAX_AGE_SECONDS;
}

function maxUpcomingKp(rows) {
  if (!Array.isArray(rows)) return 0;
  const now = Date.now();
  const start = now - 3 * 60 * 60 * 1000;
  const end = now + 36 * 60 * 60 * 1000;
  const values = rows
    .filter((row) => {
      const time = new Date(row.time_tag).getTime();
      return Number.isFinite(time) && time >= start && time <= end;
    })
    .map((row) => Number(row.kp ?? row.Kp))
    .filter(Number.isFinite);
  return values.length ? round1(Math.max(...values)) : 0;
}

function nearestAurora(coordinates, city) {
  if (!coordinates.length) return { value: 0, lat: null, lon: null };
  const cityLon = city.lon < 0 ? city.lon + 360 : city.lon;
  let best = null;
  for (const point of coordinates) {
    const [lon, lat, value] = point;
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(value)) continue;
    const dLat = lat - city.lat;
    const dLonRaw = Math.abs(lon - cityLon);
    const dLon = Math.min(dLonRaw, 360 - dLonRaw);
    const distance = dLat * dLat + dLon * dLon * Math.cos((city.lat * Math.PI) / 180) ** 2;
    if (!best || distance < best.distance) best = { value, lat, lon: normalizeLon(lon), distance };
  }
  return best || { value: 0, lat: null, lon: null };
}

function scoreCity(city, auroraValue, kp, bestCloud) {
  const latitudeBoost = Math.max(0, city.lat - 39) * 1.25;
  const auroraBoost = Math.min(52, auroraValue * 1.5);
  const kpBoost = Math.min(30, kp * 5.8);
  const cloudBoost = bestCloud == null ? 4 : Math.max(0, 100 - bestCloud) * 0.12;
  const score = Math.round(Math.min(99, auroraBoost + kpBoost + latitudeBoost + cloudBoost));
  return Math.max(3, score);
}

function labelForScore(score) {
  if (score >= 72) return "Great";
  if (score >= 52) return "Good";
  if (score >= 32) return "Possible";
  return "Low";
}

function guidanceFor(city, score, kp, bestCloud) {
  if (score >= 72) return `Conditions are strong for ${city.name}. Find a dark northern horizon and check the sky after local twilight.`;
  if (score >= 52) return `${city.name} has a reasonable chance if clouds stay low and the aurora oval pushes south. Dark sites north of town help.`;
  if (score >= 32) return `Aurora is possible near ${city.name}, but it may require a camera, a darker location, or a stronger-than-forecast Kp pulse.`;
  if (kp >= 5) return `${city.name} is on the southern edge for this forecast. Watch updates, but do not expect easy naked-eye aurora.`;
  if (bestCloud != null && bestCloud > 70) return `Cloud cover is the main problem for ${city.name}. Check again if the sky clears later tonight.`;
  return `${city.name} is unlikely tonight under the current NOAA forecast. Higher latitude cities have a better setup.`;
}

function buildMapDots(coordinates) {
  if (!coordinates.length) return [];
  const dots = [];
  for (const point of coordinates) {
    const lon = normalizeLon(point[0]);
    const lat = point[1];
    const value = point[2];
    if (lon < -170 || lon > -50 || lat < 35 || lat > 75) continue;
    const showQuietGrid = value <= 0 && lat >= 45 && Math.round(lat) % 4 === 0 && Math.round(lon) % 12 === 0;
    const showActiveGrid = value > 0 && Math.round(lat) % 2 === 0 && Math.round(lon) % 3 === 0;
    if (!showActiveGrid && !showQuietGrid) continue;
    dots.push({ lon, lat, value });
  }
  return dots
    .sort((a, b) => b.value - a.value)
    .slice(0, 240)
    .map((dot) => ({
      x: round1(((dot.lon + 170) / 120) * 100),
      y: round1(((75 - dot.lat) / 40) * 100),
      value: dot.value,
      alpha: round1(dot.value <= 0 ? 0.1 : Math.min(0.9, 0.16 + dot.value / 130)),
      size: Math.round(dot.value <= 0 ? 3 : 4 + Math.min(16, dot.value / 5)),
      color: dot.value >= 45 ? "#74f2a4" : dot.value >= 20 ? "#9ff7d2" : dot.value > 0 ? "#ffd166" : "#b7c1b4",
    }));
}

function normalizeLon(lon) {
  return lon > 180 ? lon - 360 : lon;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
