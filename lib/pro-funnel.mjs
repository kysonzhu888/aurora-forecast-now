const PUBLIC_PRO_FUNNEL_EVENT_NAMES = new Set([
  "pro_view",
  "checkout_click",
  "checkout_return",
  "license_attempt",
  "license_success",
  "license_failure",
  "location_add",
  "comparison_run",
]);
const SYSTEM_PRO_FUNNEL_EVENT_NAMES = new Set([
  ...PUBLIC_PRO_FUNNEL_EVENT_NAMES,
  "license_issued",
  "purchase_completed",
]);
const PUBLIC_PRO_FUNNEL_PAGE_TYPES = new Set(["home", "pro", "access"]);
const SYSTEM_PRO_FUNNEL_PAGE_TYPES = new Set([
  ...PUBLIC_PRO_FUNNEL_PAGE_TYPES,
  "webhook_live",
  "webhook_test",
]);
const PRO_WEBHOOK_SOURCE_EVENT_NAMES = new Set([
  "license_key_created",
  "order_created",
]);
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const MAX_EVENT_NAME_LENGTH = 40;
const MAX_PAGE_TYPE_LENGTH = 20;
const MAX_LOCATION_COUNT = 5;

export async function handleProFunnelRequest(request, env = {}) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const eventName = normalizeToken(payload.eventName, MAX_EVENT_NAME_LENGTH);
  if (!PUBLIC_PRO_FUNNEL_EVENT_NAMES.has(eventName)) {
    return json({ error: "Unsupported Pro funnel event." }, 400);
  }

  const pageType = normalizeToken(payload.pageType, MAX_PAGE_TYPE_LENGTH);
  if (!PUBLIC_PRO_FUNNEL_PAGE_TYPES.has(pageType)) {
    return json({ error: "Unsupported Pro funnel page type." }, 400);
  }

  try {
    await recordProFunnelEvent(env, {
      eventName,
      pageType,
      locationCount: payload.locationCount,
    });
  } catch {
    return json({ error: "Pro funnel storage is unavailable." }, 503);
  }

  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}

async function recordProFunnelEvent(env, event) {
  const eventName = normalizeToken(event?.eventName, MAX_EVENT_NAME_LENGTH);
  const pageType = normalizeToken(event?.pageType, MAX_PAGE_TYPE_LENGTH);
  if (!SYSTEM_PRO_FUNNEL_EVENT_NAMES.has(eventName)) {
    throw new TypeError("Unsupported internal Pro funnel event.");
  }
  if (!SYSTEM_PRO_FUNNEL_PAGE_TYPES.has(pageType)) {
    throw new TypeError("Unsupported internal Pro funnel page type.");
  }
  if (!env.COMMENTS_DB?.prepare) {
    throw new Error("Pro funnel storage is unavailable.");
  }

  const locationCount = clampLocationCount(event.locationCount);
  await env.COMMENTS_DB
    .prepare(`
      INSERT INTO pro_funnel_daily (event_date, event_name, page_type, location_count, event_count)
      VALUES (date('now'), ?, ?, ?, 1)
      ON CONFLICT (event_date, event_name, page_type, location_count)
      DO UPDATE SET event_count = event_count + 1
    `)
    .bind(eventName, pageType, locationCount)
    .run();
}

export async function recordDeduplicatedProWebhookEvent(env, event) {
  const receiptHash = String(event?.receiptHash || "").trim().toLowerCase();
  const sourceEventName = normalizeToken(event?.sourceEventName, MAX_EVENT_NAME_LENGTH);
  const funnelEventName = normalizeToken(event?.funnelEventName, MAX_EVENT_NAME_LENGTH);
  const pageType = normalizeToken(event?.pageType, MAX_PAGE_TYPE_LENGTH);
  if (!SHA256_HEX_PATTERN.test(receiptHash)) {
    throw new TypeError("Invalid Pro webhook receipt hash.");
  }
  if (!PRO_WEBHOOK_SOURCE_EVENT_NAMES.has(sourceEventName)) {
    throw new TypeError("Unsupported Pro webhook source event.");
  }
  if (!SYSTEM_PRO_FUNNEL_EVENT_NAMES.has(funnelEventName)) {
    throw new TypeError("Unsupported Pro webhook funnel event.");
  }
  if (!pageType.startsWith("webhook_") || !SYSTEM_PRO_FUNNEL_PAGE_TYPES.has(pageType)) {
    throw new TypeError("Unsupported Pro webhook page type.");
  }
  if (!env.COMMENTS_DB?.prepare || !env.COMMENTS_DB?.batch) {
    throw new Error("Pro webhook storage is unavailable.");
  }

  const receiptStatement = env.COMMENTS_DB.prepare(`
    INSERT OR IGNORE INTO pro_webhook_receipts
      (event_hash, source_event_name, test_mode, received_at)
    VALUES (?, ?, ?, datetime('now'))
  `).bind(receiptHash, sourceEventName, event.testMode === true ? 1 : 0);
  const aggregateStatement = env.COMMENTS_DB.prepare(`
    INSERT INTO pro_funnel_daily
      (event_date, event_name, page_type, location_count, event_count)
    SELECT date('now'), ?, ?, 0, 1
    WHERE changes() = 1
    ON CONFLICT (event_date, event_name, page_type, location_count)
    DO UPDATE SET event_count = event_count + 1
  `).bind(funnelEventName, pageType);

  const results = await env.COMMENTS_DB.batch([receiptStatement, aggregateStatement]);
  return Number(results?.[1]?.meta?.changes || 0) > 0;
}

function normalizeToken(value, maxLength) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .slice(0, maxLength);
}

function clampLocationCount(value) {
  const count = Number.isFinite(Number(value)) ? Math.floor(Number(value)) : 0;
  return Math.min(MAX_LOCATION_COUNT, Math.max(0, count));
}

function json(body, status) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
