import { recordDeduplicatedProWebhookEvent } from "./pro-funnel.mjs";

const SUPPORTED_WEBHOOK_EVENTS = new Set(["license_key_created", "order_created"]);
const WEBHOOK_FUNNEL_EVENTS = Object.freeze({
  license_key_created: "license_issued",
  order_created: "purchase_completed",
});
const MAX_WEBHOOK_BYTES = 128 * 1024;
const MAX_RESOURCE_TOKEN_LENGTH = 120;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;

export async function handleLemonSqueezyWebhook(request, env = {}) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed." }, 405);
  }

  const signingSecret = String(env.AURORA_LEMONSQUEEZY_WEBHOOK_SECRET || "").trim();
  const productId = String(env.AURORA_LEMONSQUEEZY_PRODUCT_ID || "").trim();
  const variantId = String(env.AURORA_LEMONSQUEEZY_VARIANT_ID || "").trim();
  if (!signingSecret || !productId) {
    return json({ ok: false, error: "Aurora Pro webhooks are not configured yet." }, 503);
  }

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_WEBHOOK_BYTES) {
    return json({ ok: false, error: "Webhook payload is too large." }, 413);
  }

  const rawBody = await request.text();
  const bodyBytes = new TextEncoder().encode(rawBody);
  if (bodyBytes.byteLength > MAX_WEBHOOK_BYTES) {
    return json({ ok: false, error: "Webhook payload is too large." }, 413);
  }

  const signature = String(request.headers.get("x-signature") || "").trim();
  if (!await verifySignature(bodyBytes, signature, signingSecret)) {
    return json({ ok: false, error: "Invalid webhook signature." }, 401);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ ok: false, error: "Invalid webhook JSON body." }, 400);
  }

  const headerEventName = normalizeToken(request.headers.get("x-event-name"));
  const payloadEventName = normalizeToken(payload.meta?.event_name);
  if (!SUPPORTED_WEBHOOK_EVENTS.has(headerEventName)) {
    return json({ ok: true, recorded: false, reason: "event_ignored" });
  }
  if (payloadEventName !== headerEventName) {
    return json({ ok: false, error: "Webhook event metadata does not match." }, 400);
  }

  const resource = readResourceContract(headerEventName, payload);
  if (!resource) {
    return json({ ok: false, error: "Webhook resource contract is incomplete." }, 400);
  }
  if (resource.productId !== productId || (variantId && resource.variantId !== variantId)) {
    return json({ ok: true, recorded: false, reason: "product_mismatch" });
  }

  const receiptHash = await sha256(`${headerEventName}|${resource.type}|${resource.id}`);
  try {
    const recorded = await recordDeduplicatedProWebhookEvent(env, {
      receiptHash,
      sourceEventName: headerEventName,
      funnelEventName: WEBHOOK_FUNNEL_EVENTS[headerEventName],
      pageType: resource.testMode ? "webhook_test" : "webhook_live",
      testMode: resource.testMode,
    });
    return json({ ok: true, recorded });
  } catch {
    return json({ ok: false, error: "Aurora Pro webhook storage is unavailable." }, 503);
  }
}

function readResourceContract(eventName, payload) {
  const data = payload.data;
  const attributes = data?.attributes;
  const id = normalizeResourceToken(data?.id);
  const type = normalizeResourceToken(data?.type);
  if (!id || !type || !attributes) return null;

  const orderItem = eventName === "order_created" ? attributes.first_order_item : null;
  const productId = String(orderItem?.product_id ?? attributes.product_id ?? "").trim();
  const variantId = String(orderItem?.variant_id ?? attributes.variant_id ?? "").trim();
  if (!productId) return null;

  return {
    id,
    type,
    productId,
    variantId,
    testMode: attributes.test_mode === true || orderItem?.test_mode === true,
  };
}

async function verifySignature(bodyBytes, signatureHex, secret) {
  if (!SHA256_HEX_PATTERN.test(signatureHex)) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "HMAC",
      key,
      hexBytes(signatureHex),
      bodyBytes,
    );
  } catch {
    return false;
  }
}

function hexBytes(value) {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

function normalizeToken(value) {
  return String(value || "").trim().toLowerCase().slice(0, 40);
}

function normalizeResourceToken(value) {
  const token = String(value || "").trim();
  return token && token.length <= MAX_RESOURCE_TOKEN_LENGTH ? token : "";
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
