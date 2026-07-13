import cities from "../data/cities.json";
import media from "../data/media.json";
import { scoreCity, labelForScore, guidanceFor, nearestAurora, normalizeLon } from "../lib/forecast-core.mjs";
import { buildAuroraGridIndex, nearestAuroraFromGrid } from "../lib/forecast-grid.mjs";
import {
  FORECAST_CACHE_KEY as CACHE_KEY,
  FORECAST_METADATA_KEY,
  FORECAST_SCHEDULE_STATE_KEY,
  ageSecondsForMetadata,
  forecastMetadataFromForecast,
  readForecastMetadata,
  readForecastScheduleState,
  runScheduledRefresh,
} from "../lib/forecast-schedule.mjs";

const LOCK_KEY = "forecast:refresh-lock";
const GEOCODE_PREFIX = "geocode:";
const NORMAL_MAX_AGE_SECONDS = 30 * 60;
const STORM_MAX_AGE_SECONDS = 5 * 60;
const LOCK_TTL_SECONDS = 90;
const FORECAST_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const SCHEDULE_STATE_TTL_SECONDS = 2 * 24 * 60 * 60;
const FALLBACK_FORECAST_URL = "https://auroraforecastnow.com/data/forecast.json";
const ALERT_LOOKBACK_MS = 72 * 60 * 60 * 1000;
const MAX_NAME_LENGTH = 40;
const MAX_COMMENT_LENGTH = 600;
const MAX_COMMENTS_PER_RESPONSE = 30;

const endpoints = {
  ovation: "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json",
  kp: "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json",
  alerts: "https://services.swpc.noaa.gov/products/alerts.json",
  geocoding: "https://geocoding-api.open-meteo.com/v1/search",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
    if (normalizedPath === "/api/health" || normalizedPath === "/health") return handleHealth(env);
    if (normalizedPath === "/api/forecast" || normalizedPath === "/forecast") return handleForecastWithEdgeCache(request, env, ctx);
    if (normalizedPath === "/api/comments" || normalizedPath === "/comments") return handleComments(request, env);
    if (normalizedPath === "/api/alerts/subscribe") return handleAlertSubscribe(request, env);
    return withCors(jsonResponse({ error: "Not found" }, 404));
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduledRefresh(env, event.scheduledTime));
  },
};

// 边缘缓存包装层：forecast 数据由 cron 每 5 分钟刷新，同一位置的响应在短窗口内完全相同，
// 用 Cache API 存 120s，命中时 Worker 主逻辑与 KV 读取都不执行。
const FORECAST_EDGE_TTL_SECONDS = 120;
const FORECAST_BROWSER_TTL_SECONDS = 60;

function forecastCacheKey(request) {
  const url = new URL(request.url);
  const keep = new URLSearchParams();
  for (const param of ["city", "q", "lat", "lon"]) {
    const value = url.searchParams.get(param);
    if (value !== null && value.trim() !== "") keep.set(param, value.trim().toLowerCase());
  }
  return new Request(`${url.origin}/api/forecast?${keep.toString()}`, { method: "GET" });
}

async function handleForecastWithEdgeCache(request, env, ctx) {
  if (request.method !== "GET") return handleForecast(request, env, ctx);
  const cacheKey = forecastCacheKey(request);
  const edgeCache = caches.default;

  const hit = await edgeCache.match(cacheKey);
  if (hit) return hit;

  const response = await handleForecast(request, env, ctx);
  if (response.status !== 200) return response;

  const cacheable = new Response(response.body, response);
  cacheable.headers.set(
    "cache-control",
    `public, max-age=${FORECAST_BROWSER_TTL_SECONDS}, s-maxage=${FORECAST_EDGE_TTL_SECONDS}, stale-while-revalidate=300`,
  );
  ctx.waitUntil(edgeCache.put(cacheKey, cacheable.clone()));
  return cacheable;
}

async function handleForecast(request, env, ctx) {
  const url = new URL(request.url);
  const locationRequest = await parseLocationRequest(url, env);
  if (locationRequest.type === "not-found") {
    return withCors(jsonResponse({
      error: "City not found",
      query: locationRequest.query,
      message: "Try a larger nearby city or latitude/longitude.",
    }, 404));
  }
  const cached = await readCachedForecast(env);

  if (cached) {
    if (locationRequest.type !== "none" && !cached.rawCoordinates?.length) {
      const refreshed = await refreshWithLock(env, { reason: "request-dynamic-city-needs-grid" });
      if (refreshed?.rawCoordinates?.length) {
        return withCors(jsonResponse(await shapeResponse(refreshed, {
          status: "fresh",
          ageSeconds: 0,
          maxAgeSeconds: maxAgeFor(refreshed),
          locationRequest,
        })));
      }
    }
    const ageSeconds = ageOf(cached);
    const maxAgeSeconds = maxAgeFor(cached);
    const status = ageSeconds > maxAgeSeconds ? "stale" : "fresh";
    if (status === "stale") {
      ctx.waitUntil(refreshWithLock(env, { reason: "request-stale" }));
    }
    return withCors(jsonResponse(await shapeResponse(cached, { status, ageSeconds, maxAgeSeconds, locationRequest })));
  }

  try {
    const fresh = await refreshWithLock(env, { reason: "request-empty-cache" });
    if (fresh) {
      return withCors(jsonResponse(await shapeResponse(fresh, {
        status: "fresh",
        ageSeconds: 0,
        maxAgeSeconds: maxAgeFor(fresh),
        locationRequest,
      })));
    }
  } catch (error) {
    console.warn(`Initial refresh failed: ${error.message}`);
  }

  const fallback = await fetchFallbackForecast();
  return withCors(jsonResponse(await shapeResponse(fallback, {
    status: "fallback",
    ageSeconds: ageOf(fallback),
    maxAgeSeconds: NORMAL_MAX_AGE_SECONDS,
    locationRequest,
    warning: "Serving static fallback because KV cache is empty.",
  })));
}

async function handleHealth(env) {
  const [metadata, lastSchedule] = await Promise.all([
    readForecastMetadata(env.AURORA_FORECAST_CACHE),
    readForecastScheduleState(env.AURORA_FORECAST_CACHE),
  ]);
  return withCors(jsonResponse({
    ok: Boolean(metadata) && lastSchedule?.status !== "error",
    hasCache: Boolean(metadata),
    updatedAt: metadata?.generatedAt || null,
    ageSeconds: metadata ? ageSecondsForMetadata(metadata) : null,
    stormMode: Boolean(metadata?.stormMode),
    stormLevel: metadata?.stormLevel || 0,
    lastSchedule: lastSchedule || null,
  }));
}

async function handleComments(request, env) {
  if (request.method === "GET") {
    const url = new URL(request.url);
    const pageKey = normalizeText(
      url.searchParams.get("pageKey") || url.searchParams.get("gameSlug"),
      120
    );
    if (!pageKey) {
      return withCors(jsonResponse({ error: "Missing pageKey." }, 400));
    }
    return withCors(jsonResponse({ comments: await listComments(env, pageKey) }));
  }

  if (request.method !== "POST") {
    return withCors(jsonResponse({ error: "Method not allowed." }, 405));
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return withCors(jsonResponse({ error: "Invalid JSON body." }, 400));
  }

  const pageKey = normalizeText(payload.pageKey || payload.gameSlug, 120);
  const name = normalizeText(payload.name || "Visitor", MAX_NAME_LENGTH) || "Visitor";
  const body = normalizeText(payload.comment || payload.body, MAX_COMMENT_LENGTH);

  if (!pageKey) {
    return withCors(jsonResponse({ error: "Missing pageKey." }, 400));
  }

  if (!body) {
    return withCors(jsonResponse({ error: "Comment cannot be empty." }, 400));
  }

  const db = commentsDb(env);
  if (!db) {
    return withCors(jsonResponse({ error: "Comments database is not configured yet." }, 503));
  }

  const id = crypto.randomUUID();
  await db
    .prepare(`
      INSERT INTO comments (id, page_key, name, body)
      VALUES (?, ?, ?, ?)
    `)
    .bind(id, pageKey, name, body)
    .run();

  return withCors(jsonResponse({ ok: true, comments: await listComments(env, pageKey) }, 201));
}

const MAX_EMAIL_LENGTH = 254;
const ALERT_RATE_LIMIT_PER_MINUTE = 3;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function handleAlertSubscribe(request, env) {
  if (request.method !== "POST") {
    return withCors(jsonResponse({ error: "Method not allowed." }, 405));
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return withCors(jsonResponse({ error: "Invalid JSON body." }, 400));
  }

  // honeypot：正常用户看不到 website 字段；bot 填了就假装成功，不暴露识别逻辑
  if (normalizeText(payload.website, 200)) {
    return withCors(jsonResponse({ ok: true }, 201));
  }

  const email = normalizeText(payload.email, MAX_EMAIL_LENGTH).toLowerCase();
  if (!email || !EMAIL_PATTERN.test(email)) {
    return withCors(jsonResponse({ error: "Please enter a valid email address." }, 400));
  }
  const citySlug = normalizeText(payload.citySlug, 80);
  const sourcePath = normalizeText(payload.sourcePath, 200);

  // KV 限流：同 IP 每分钟最多 3 次（KV 非原子，边界超发可接受，够挡脚本滥用）
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const rateKey = `alerts-rl:${ip}`;
  const currentCount = Number((await env.AURORA_FORECAST_CACHE.get(rateKey)) || 0);
  if (currentCount >= ALERT_RATE_LIMIT_PER_MINUTE) {
    return withCors(jsonResponse({ error: "Too many requests. Try again in a minute." }, 429));
  }
  await env.AURORA_FORECAST_CACHE.put(rateKey, String(currentCount + 1), { expirationTtl: 60 });

  const db = commentsDb(env);
  if (!db) {
    return withCors(jsonResponse({ error: "Signup storage is not configured yet." }, 503));
  }

  // INSERT OR IGNORE：同 email+city 重复报名幂等返回成功，不泄露是否已存在
  await db
    .prepare(`
      INSERT OR IGNORE INTO alert_signups (id, email, city_slug, source_path, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .bind(crypto.randomUUID(), email, citySlug, sourcePath, new Date().toISOString())
    .run();

  return withCors(jsonResponse({ ok: true }, 201));
}

async function listComments(env, pageKey) {
  const db = commentsDb(env);
  if (!db) return [];

  const { results } = await db
    .prepare(`
      SELECT id, name, body, created_at
      FROM comments
      WHERE page_key = ? AND status = 'visible'
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .bind(pageKey, MAX_COMMENTS_PER_RESPONSE)
    .all();

  return (results || []).map((row) => ({
    id: row.id,
    name: row.name,
    body: row.body,
    createdAt: row.created_at,
  }));
}

function commentsDb(env) {
  return env && env.COMMENTS_DB;
}

function normalizeText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

async function handleScheduledRefresh(env, scheduledTime) {
  return runScheduledRefresh({
    scheduledTime,
    normalMaxAgeSeconds: NORMAL_MAX_AGE_SECONDS,
    readMetadata: () => readForecastMetadata(env.AURORA_FORECAST_CACHE),
    fetchAlerts: () => fetchJson(endpoints.alerts, "alerts"),
    parseAlerts: parseAlertInfo,
    refresh: (options) => refreshWithLock(env, options),
    writeState: (state) => writeScheduleState(env, state),
  });
}

async function refreshWithLock(env, options = {}) {
  const existingLock = await env.AURORA_FORECAST_CACHE.get(LOCK_KEY);
  if (existingLock) {
    console.info(
      `[forecast-refresh] lock-active reason=${options.reason || "unknown"} `
      + `readCachedOnLock=${options.readCachedOnLock !== false}`,
    );
    return options.readCachedOnLock === false ? null : readCachedForecast(env);
  }

  await env.AURORA_FORECAST_CACHE.put(LOCK_KEY, JSON.stringify({
    createdAt: new Date().toISOString(),
    reason: options.reason || "unknown",
  }), { expirationTtl: LOCK_TTL_SECONDS });

  try {
    const forecast = await buildForecast(options);
    const metadata = forecastMetadataFromForecast(forecast);
    await env.AURORA_FORECAST_CACHE.put(CACHE_KEY, JSON.stringify(forecast), {
      expirationTtl: FORECAST_CACHE_TTL_SECONDS,
      metadata,
    });
    await env.AURORA_FORECAST_CACHE.put(FORECAST_METADATA_KEY, JSON.stringify(metadata), {
      expirationTtl: FORECAST_CACHE_TTL_SECONDS,
    });
    console.info(
      `[forecast-refresh] completed reason=${options.reason || "unknown"} generatedAt=${forecast.generatedAt} `
      + `durationMs=${forecast.worker.durationMs} cities=${forecast.cities.length} coordinates=${forecast.rawCoordinates.length}`,
    );
    return forecast;
  } catch (error) {
    console.error(`[forecast-refresh] failed reason=${options.reason || "unknown"} error=${error.message}`, error);
    throw error;
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
  const auroraGridIndex = buildAuroraGridIndex(coordinates);
  const maxKp = maxUpcomingKp(kpRows);
  console.info(
    `[forecast-refresh] grid-index coordinates=${coordinates.length} indexed=${auroraGridIndex.indexedPointCount} `
    + `cities=${cities.length}`,
  );
  const cityForecasts = cities
    .map((city) => {
      const aurora = nearestAuroraFromGrid(auroraGridIndex, coordinates, city);
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
    rawCoordinates: coordinates,
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

async function resolveCityQuery(query, env) {
  const normalized = query.trim().toLowerCase();
  const normalizedSlug = slugify(query);
  if (!normalized) return null;

  const preset = cities.find((city) => {
    const cityNameSlug = slugify(city.name);
    const cityRegionSlug = slugify(`${city.name}-${city.region}`);
    const cityCountrySlug = slugify(`${city.name}-${city.country}`);
    const cityLabel = `${city.name}, ${city.region}`.toLowerCase();
    return city.slug === normalizedSlug
      || cityNameSlug === normalizedSlug
      || cityRegionSlug === normalizedSlug
      || cityCountrySlug === normalizedSlug
      || cityLabel === normalized;
  });
  if (preset) return preset;

  const cacheKey = `${GEOCODE_PREFIX}${normalized}`;
  const cached = await env.AURORA_FORECAST_CACHE.get(cacheKey, "json");
  if (cached) return cached;

  const endpoint = `${endpoints.geocoding}?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;
  const data = await fetchJson(endpoint, "open-meteo-geocoding");
  const match = data?.results?.[0];
  if (!match) return null;

  const city = {
    slug: slugify(`${match.name}-${match.admin1 || match.country_code || match.country}`),
    name: match.name,
    region: match.admin1 || match.admin2 || match.country || "",
    country: match.country || "",
    lat: match.latitude,
    lon: match.longitude,
    timezone: match.timezone || "UTC",
    priority: 9,
    source: "open-meteo-geocoding",
  };
  await env.AURORA_FORECAST_CACHE.put(cacheKey, JSON.stringify(city), { expirationTtl: 30 * 24 * 60 * 60 });
  return city;
}

async function parseLocationRequest(url, env) {
  const latParam = url.searchParams.get("lat");
  const lonParam = url.searchParams.get("lon");
  const hasCoordinates = latParam != null && lonParam != null;
  const lat = hasCoordinates ? Number(latParam) : null;
  const lon = hasCoordinates ? Number(lonParam) : null;
  if (hasCoordinates && Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
    return {
      type: "coordinates",
      city: {
        slug: `lat-${round1(lat)}-lon-${round1(lon)}`.replaceAll(".", "-"),
        name: "Custom location",
        region: "",
        country: "",
        lat,
        lon,
        timezone: "UTC",
        priority: 9,
        source: "coordinates",
      },
    };
  }

  const rawCity = url.searchParams.get("city") || url.searchParams.get("q");
  if (!rawCity) return { type: "none", city: null };

  const resolved = await resolveCityQuery(rawCity, env);
  if (!resolved) return { type: "not-found", query: rawCity, city: null };
  return { type: "city", query: rawCity, city: resolved };
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

  const currentAlerts = rows
    .map((row) => ({
      message: row.message || "",
      issueMs: parseNoaaIssueTime(row.issue_datetime),
    }))
    .filter((row) => row.message && Number.isFinite(row.issueMs))
    .filter((row) => Date.now() - row.issueMs <= ALERT_LOOKBACK_MS)
    .filter((row) => !/\bCANCEL(?:LED)?\b/i.test(row.message));

  const geomagneticAlerts = currentAlerts.filter((row) => /Geomagnetic Storm|Geomagnetic K-index|K-index|G[1-5]/i.test(row.message));
  const level = geomagneticAlerts.reduce((max, row) => Math.max(max, alertLevelFromMessage(row.message)), 0);
  const storm = geomagneticAlerts.find((row) => /WATCH|WARNING|ALERT|G[1-5]/i.test(row.message));
  if (!storm) {
    return {
      level,
      stormMode: level >= 2,
      summary: "No active geomagnetic storm watch appeared in the latest NOAA alert feed.",
    };
  }

  const summary = storm.message
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

function parseNoaaIssueTime(value) {
  if (!value) return Number.NaN;
  return new Date(`${String(value).replace(" ", "T")}Z`).getTime();
}

function alertLevelFromMessage(message) {
  const gLevels = [...message.matchAll(/\bG([1-5])\b/g)].map((match) => Number(match[1]));
  const kLevels = [...message.matchAll(/K-index of ([5-9])/gi)].map((match) => Number(match[1]) - 4);
  return Math.max(...gLevels, ...kLevels, 0);
}

async function shapeResponse(forecast, meta) {
  const city = await resolveResponseCity(forecast, meta.locationRequest);
  const { rawCoordinates, ...publicForecast } = forecast;
  return {
    ...publicForecast,
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

async function resolveResponseCity(forecast, locationRequest) {
  if (!locationRequest || locationRequest.type === "none") return null;
  if (!locationRequest.city) return null;

  const cachedCity = forecast.cities.find((candidate) => candidate.slug === locationRequest.city.slug);
  if (cachedCity) return { ...cachedCity, source: locationRequest.city.source || "preset" };

  const city = locationRequest.city;
  const aurora = nearestAurora(forecast.rawCoordinates || [], city);
  const clouds = await fetchSingleCloudCover(city);
  const score = scoreCity(city, aurora.value, forecast.maxKp, clouds.bestCloud);
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
    guidance: guidanceFor(city, score, forecast.maxKp, clouds.bestCloud),
    source: city.source || "dynamic",
  };
}

async function fetchSingleCloudCover(city) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&hourly=cloud_cover&timezone=UTC&forecast_days=2`;
    const json = await fetchJson(url, "open-meteo-single");
    const cloudValues = (json?.hourly?.cloud_cover || []).slice(0, 24).filter((value) => Number.isFinite(value));
    return {
      bestCloud: cloudValues.length ? Math.min(...cloudValues) : null,
      avgCloud: cloudValues.length ? Math.round(cloudValues.reduce((sum, value) => sum + value, 0) / cloudValues.length) : null,
    };
  } catch (error) {
    console.warn(`Dynamic cloud lookup failed: ${error.message}`);
    return { bestCloud: null, avgCloud: null };
  }
}

async function readCachedForecast(env) {
  return env.AURORA_FORECAST_CACHE.get(CACHE_KEY, "json");
}

async function writeScheduleState(env, state) {
  await env.AURORA_FORECAST_CACHE.put(FORECAST_SCHEDULE_STATE_KEY, JSON.stringify(state), {
    expirationTtl: SCHEDULE_STATE_TTL_SECONDS,
  });
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

// scoreCity / labelForScore / guidanceFor / nearestAurora / normalizeLon
// 已抽取到 ../lib/forecast-core.mjs（与 tools/build.mjs 共用，wrangler 打包时自动 bundle）

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


function round1(value) {
  return Math.round(value * 10) / 10;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "custom-location";
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
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
