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

export async function recordProFunnelEvent(env, event) {
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
