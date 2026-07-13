export const FORECAST_CACHE_KEY = "forecast:latest";
export const FORECAST_METADATA_KEY = "forecast:latest-meta";
export const FORECAST_SCHEDULE_STATE_KEY = "forecast:last-schedule";

function booleanValue(value) {
  return value === true || value === "true";
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeForecastMetadata(value) {
  if (!value || typeof value !== "object" || !value.generatedAt) return null;
  return {
    generatedAt: String(value.generatedAt),
    stormMode: booleanValue(value.stormMode),
    stormLevel: finiteNumber(value.stormLevel),
  };
}

export function forecastMetadataFromForecast(forecast) {
  return normalizeForecastMetadata(forecast);
}

export async function readForecastMetadata(kv) {
  const compactMetadata = normalizeForecastMetadata(await kv.get(FORECAST_METADATA_KEY, "json"));
  if (compactMetadata) return compactMetadata;

  const legacyKeys = await kv.list({ prefix: FORECAST_CACHE_KEY, limit: 2 });
  const forecastKey = legacyKeys.keys?.find((key) => key.name === FORECAST_CACHE_KEY);
  return normalizeForecastMetadata(forecastKey?.metadata);
}

export async function readForecastScheduleState(kv) {
  return kv.get(FORECAST_SCHEDULE_STATE_KEY, "json");
}

export function ageSecondsForMetadata(metadata, nowMs = Date.now()) {
  const generatedAtMs = new Date(metadata?.generatedAt).getTime();
  if (!Number.isFinite(generatedAtMs)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.round((nowMs - generatedAtMs) / 1000));
}

export function scheduledRefreshDecision(metadata, alertInfo, normalMaxAgeSeconds, nowMs = Date.now()) {
  const ageSeconds = metadata ? ageSecondsForMetadata(metadata, nowMs) : Number.POSITIVE_INFINITY;
  if (!metadata) {
    return { shouldRefresh: true, reason: "scheduled-cache-metadata-missing", ageSeconds };
  }
  if (alertInfo.stormMode) {
    return { shouldRefresh: true, reason: "scheduled-storm-mode", ageSeconds };
  }
  if (ageSeconds >= normalMaxAgeSeconds) {
    return { shouldRefresh: true, reason: "scheduled-normal-expired", ageSeconds };
  }
  return { shouldRefresh: false, reason: "normal-cache-fresh", ageSeconds };
}

function serializableAge(ageSeconds) {
  return Number.isFinite(ageSeconds) ? ageSeconds : null;
}

function errorDetails(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function scheduleLogFields(state) {
  return `status=${state.status} reason=${state.reason} ageSeconds=${state.ageSeconds ?? "unknown"}`;
}

export async function runScheduledRefresh({
  scheduledTime,
  normalMaxAgeSeconds,
  readMetadata,
  fetchAlerts,
  parseAlerts,
  refresh,
  writeState,
  now = () => Date.now(),
  logger = console,
}) {
  const nowMs = now();
  const checkedAt = new Date(nowMs).toISOString();
  let state = {
    ok: false,
    status: "error",
    refreshed: false,
    reason: "scheduled-check-failed",
    scheduledTime: scheduledTime ?? null,
    checkedAt,
    ageSeconds: null,
  };
  let failure = null;
  let activeReason = state.reason;

  try {
    const [metadata, alerts] = await Promise.all([readMetadata(), fetchAlerts()]);
    const alertInfo = parseAlerts(alerts);
    const decision = scheduledRefreshDecision(metadata, alertInfo, normalMaxAgeSeconds, nowMs);
    activeReason = decision.reason;
    logger.info(
      `[forecast-cron] decision scheduledTime=${scheduledTime ?? "unknown"} hasMetadata=${Boolean(metadata)} `
      + `ageSeconds=${serializableAge(decision.ageSeconds) ?? "unknown"} stormMode=${alertInfo.stormMode} `
      + `shouldRefresh=${decision.shouldRefresh} reason=${decision.reason}`,
    );

    if (decision.shouldRefresh) {
      const forecast = await refresh({
        reason: decision.reason,
        preloadedAlerts: alerts,
        preloadedAlertInfo: alertInfo,
        readCachedOnLock: false,
      });
      if (forecast) {
        state = {
          ok: true,
          status: "success",
          refreshed: true,
          reason: decision.reason,
          scheduledTime: scheduledTime ?? null,
          checkedAt,
          ageSeconds: serializableAge(decision.ageSeconds),
          updatedAt: forecast.generatedAt || null,
          alertInfo,
        };
      } else {
        state = {
          ok: true,
          status: "skipped",
          refreshed: false,
          reason: "refresh-lock-active",
          scheduledTime: scheduledTime ?? null,
          checkedAt,
          ageSeconds: serializableAge(decision.ageSeconds),
          alertInfo,
        };
      }
    } else {
      state = {
        ok: true,
        status: "skipped",
        refreshed: false,
        reason: decision.reason,
        scheduledTime: scheduledTime ?? null,
        checkedAt,
        ageSeconds: serializableAge(decision.ageSeconds),
        alertInfo,
      };
    }
  } catch (error) {
    failure = error;
    state = {
      ...state,
      reason: activeReason,
      error: errorDetails(error),
    };
    logger.error(`[forecast-cron] failed ${scheduleLogFields(state)} error=${state.error.message}`, error);
  }

  try {
    await writeState(state);
  } catch (error) {
    logger.error(`[forecast-cron] health-state-write-failed error=${errorDetails(error).message}`, error);
    if (!failure) failure = error;
  }

  if (failure) throw failure;
  logger.info(`[forecast-cron] completed ${scheduleLogFields(state)} refreshed=${state.refreshed}`);
  return state;
}
