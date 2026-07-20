const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_EMAIL_LENGTH = 254;
const DEFAULT_THRESHOLD = 60;
const ALERT_COOLDOWN_HOURS = 6;
const PUBLIC_ORIGIN = "https://auroraforecastnow.com";
const SENDER_NAME = "Aurora Forecast Now";

export async function handleAlertSubscribe(request, env = {}) {
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  if (normalize(payload.website, 200)) return json({ ok: true }, 201);

  const email = normalize(payload.email, MAX_EMAIL_LENGTH).toLowerCase();
  if (!email || !EMAIL_PATTERN.test(email)) {
    return json({ error: "Please enter a valid email address." }, 400);
  }
  const db = env.COMMENTS_DB;
  if (!db?.prepare) return json({ error: "Signup storage is not configured yet." }, 503);

  const proposedId = crypto.randomUUID();
  const citySlug = normalizeSlug(payload.citySlug, 80);
  if (!citySlug || (env.alertCitySlugs && !env.alertCitySlugs.has(citySlug))) {
    return json({ error: "Please select a valid city." }, 400);
  }
  const sourcePath = normalize(payload.sourcePath, 200);
  const threshold = normalizeThreshold(payload.threshold);
  const emailReady = alertDeliveryConfigured(env);
  await db.prepare(`
    INSERT OR IGNORE INTO alert_subscriptions
      (id, email, city_slug, threshold, status, source_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'waitlist', ?, datetime('now'), datetime('now'))
  `).bind(proposedId, email, citySlug, threshold, sourcePath).run();
  const existing = await db.prepare(`
    SELECT id, status, unsubscribe_token_hash
    FROM alert_subscriptions
    WHERE email = ? AND city_slug = ?
  `).bind(email, citySlug).first();
  if (!existing?.id) return json({ error: "Signup storage is temporarily unavailable." }, 503);

  const id = existing.id;
  if (!emailReady) {
    await db.prepare(`
      UPDATE alert_subscriptions SET
        threshold = ?, source_path = ?,
        status = CASE WHEN status = 'active' THEN 'active' ELSE 'waitlist' END,
        confirmation_token_hash = CASE WHEN status = 'active' THEN confirmation_token_hash ELSE NULL END,
        unsubscribe_token_hash = CASE WHEN status = 'active' THEN unsubscribe_token_hash ELSE NULL END,
        updated_at = datetime('now')
      WHERE id = ?
    `).bind(threshold, sourcePath, id).run();
    return json({ ok: true, status: "waitlist", delivery: "unavailable" }, 201);
  }

  const confirmToken = await createAlertToken("confirm", id, env.ALERT_TOKEN_SECRET);
  const unsubscribeToken = await createAlertToken("unsubscribe", id, env.ALERT_TOKEN_SECRET);
  const confirmHash = await sha256(confirmToken);
  const unsubscribeHash = await sha256(unsubscribeToken);
  const settingsUpdate = existing.status === "active"
    && existing.unsubscribe_token_hash === unsubscribeHash;
  const status = settingsUpdate ? "active" : "pending";
  await db.prepare(`
    UPDATE alert_subscriptions SET
      threshold = ?, source_path = ?,
      status = ?,
      confirmation_token_hash = CASE WHEN ? = 'active' THEN confirmation_token_hash ELSE ? END,
      unsubscribe_token_hash = ?,
      confirmed_at = CASE WHEN ? = 'pending' THEN NULL ELSE confirmed_at END,
      unsubscribed_at = CASE WHEN ? = 'pending' THEN NULL ELSE unsubscribed_at END,
      last_alert_at = CASE WHEN ? = 'pending' THEN NULL ELSE last_alert_at END,
      updated_at = datetime('now')
    WHERE id = ?
  `).bind(
    threshold,
    sourcePath,
    status,
    status,
    confirmHash,
    unsubscribeHash,
    status,
    status,
    status,
    id,
  ).run();

  try {
    await sendEmail(env, settingsUpdate
      ? {
          to: email,
          subject: "Your Aurora storm alert settings updated",
          text: [
            `Your storm alert for ${citySlug} is active at Score ${threshold}.`,
            `View the forecast: ${PUBLIC_ORIGIN}/cities/${citySlug}/`,
            "",
            "Unsubscribe:",
            `${PUBLIC_ORIGIN}/api/alerts/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`,
          ].join("\n"),
        }
      : {
          to: email,
          subject: "Confirm your Aurora Forecast Now storm alerts",
          text: [
            `Confirm storm alerts for ${citySlug}:`,
            `${PUBLIC_ORIGIN}/api/alerts/confirm?token=${encodeURIComponent(confirmToken)}`,
            "",
            "Unsubscribe:",
            `${PUBLIC_ORIGIN}/api/alerts/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`,
          ].join("\n"),
        });
  } catch {
    await db.prepare(`
      UPDATE alert_subscriptions
      SET status = 'waitlist', confirmation_token_hash = NULL,
          unsubscribe_token_hash = NULL, updated_at = datetime('now')
      WHERE email = ? AND city_slug = ? AND status = 'pending'
    `).bind(email, citySlug).run();
    return json({ ok: true, status: "waitlist", delivery: "unavailable" }, 201);
  }

  return json({ ok: true, status: "confirmation_pending", delivery: "email" }, 201);
}

export async function handleAlertToken(request, env = {}, action) {
  if (request.method !== "GET") return html("Method not allowed", "This link only supports GET.", 405);
  const db = env.COMMENTS_DB;
  if (!db?.prepare) return html("Temporarily unavailable", "Please try again later.", 503);
  const token = new URL(request.url).searchParams.get("token") || "";
  if (token.length < 8 || token.length > 512) return invalidToken();
  const tokenHash = await sha256(token);

  let result;
  if (action === "confirm") {
    result = await db.prepare(`
      UPDATE alert_subscriptions
      SET status = 'active', confirmed_at = COALESCE(confirmed_at, datetime('now')),
          updated_at = datetime('now')
      WHERE confirmation_token_hash = ? AND status IN ('pending', 'active')
    `).bind(tokenHash).run();
  } else if (action === "unsubscribe") {
    result = await db.prepare(`
      UPDATE alert_subscriptions
      SET status = 'unsubscribed', unsubscribed_at = COALESCE(unsubscribed_at, datetime('now')),
          updated_at = datetime('now')
      WHERE unsubscribe_token_hash = ? AND status != 'unsubscribed'
    `).bind(tokenHash).run();
  } else {
    return invalidToken();
  }

  if (Number(result?.meta?.changes || 0) < 1) return invalidToken();
  return action === "confirm"
    ? html("Alerts confirmed", "Your storm alerts are now active.")
    : html("Unsubscribed", "You will no longer receive storm alerts.");
}

export async function runAlertCron(env = {}, forecast) {
  if (!alertDeliveryConfigured(env) || !env.COMMENTS_DB?.prepare || !forecast?.generatedAt) {
    return { configured: false, matched: 0, sent: 0 };
  }
  const db = env.COMMENTS_DB;
  const { results = [] } = await db.prepare(`
    SELECT id, email, city_slug, threshold, unsubscribe_token_hash
    FROM alert_subscriptions
    WHERE status = 'active'
      AND (last_alert_at IS NULL OR last_alert_at <= datetime('now', '-${ALERT_COOLDOWN_HOURS} hours'))
  `).all();
  const cityBySlug = new Map((forecast.cities || []).map((city) => [city.slug, city]));
  const matches = results
    .map((subscription) => ({ subscription, city: cityBySlug.get(subscription.city_slug) }))
    .filter(({ subscription, city }) => city && Number(city.score) >= Number(subscription.threshold));
  let sent = 0;

  for (const { subscription, city } of matches) {
    const forecastKey = await sha256(`${forecast.generatedAt}:${city.slug}:${subscription.threshold}`);
    const deliveryClaim = await db.prepare(`
      INSERT OR IGNORE INTO alert_deliveries
        (subscription_id, forecast_key, created_at)
      VALUES (?, ?, datetime('now'))
    `).bind(subscription.id, forecastKey).run();
    if (Number(deliveryClaim?.meta?.changes || 0) < 1) continue;

    const claimedAt = new Date().toISOString();
    const cooldownClaim = await db.prepare(`
      UPDATE alert_subscriptions SET last_alert_at = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'active'
        AND (last_alert_at IS NULL OR datetime(last_alert_at) <= datetime('now', '-${ALERT_COOLDOWN_HOURS} hours'))
    `).bind(claimedAt, subscription.id).run();
    if (Number(cooldownClaim?.meta?.changes || 0) < 1) {
      await deletePendingDelivery(db, subscription.id, forecastKey);
      continue;
    }

    try {
      const unsubscribeToken = await createAlertToken("unsubscribe", subscription.id, env.ALERT_TOKEN_SECRET);
      const unsubscribeHash = await sha256(unsubscribeToken);
      if (unsubscribeHash !== subscription.unsubscribe_token_hash) throw new Error("Invalid stored token state");
      await sendEmail(env, {
        to: subscription.email,
        subject: `Aurora alert for ${city.name}`,
        text: [
          `${city.name} has reached your aurora alert threshold.`,
          `Score ${city.score} · Kp ${forecast.maxKp ?? "N/A"}`,
          `View the forecast: ${PUBLIC_ORIGIN}/cities/${city.slug}/`,
          `Unsubscribe: ${PUBLIC_ORIGIN}/api/alerts/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`,
        ].join("\n"),
      });
      await db.prepare(`
        UPDATE alert_deliveries SET sent_at = datetime('now')
        WHERE subscription_id = ? AND forecast_key = ?
      `).bind(subscription.id, forecastKey).run();
      sent += 1;
    } catch {
      await deletePendingDelivery(db, subscription.id, forecastKey);
      await db.prepare(`
        UPDATE alert_subscriptions SET last_alert_at = NULL, updated_at = datetime('now')
        WHERE id = ? AND last_alert_at = ?
      `).bind(subscription.id, claimedAt).run();
    }
  }

  return { configured: true, matched: matches.length, sent };
}

export async function runAlertCronIfConfigured(env = {}, loadForecast) {
  if (!alertDeliveryConfigured(env) || !env.COMMENTS_DB?.prepare) {
    return { configured: false, matched: 0, sent: 0 };
  }
  const forecast = await loadForecast();
  return runAlertCron(env, forecast);
}

async function deletePendingDelivery(db, subscriptionId, forecastKey) {
  await db.prepare(`
    DELETE FROM alert_deliveries WHERE subscription_id = ? AND forecast_key = ? AND sent_at IS NULL
  `).bind(subscriptionId, forecastKey).run();
}

export function alertDeliveryConfigured(env = {}) {
  return Boolean(
    env.EMAIL?.send
    && env.ALERT_FROM_EMAIL
    && env.ALERT_TOKEN_SECRET,
  );
}

async function sendEmail(env, { to, subject, text }) {
  const from = normalizeHeader(env.ALERT_FROM_EMAIL);
  const recipient = normalizeHeader(to);
  await env.EMAIL.send({
    to: recipient,
    from: { email: from, name: SENDER_NAME },
    subject: normalizeHeader(subject),
    text,
  });
}

export async function createAlertToken(action, id, secret) {
  const payload = `${action}.${id}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return `${payload}.${base64Url(signature)}`;
}

async function sha256(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const hashAlertToken = sha256;

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function normalize(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeSlug(value, maxLength) {
  return normalize(value, maxLength).toLowerCase().replace(/[^a-z0-9-]/g, "");
}

function normalizeThreshold(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_THRESHOLD;
  const threshold = Number(value);
  return Number.isInteger(threshold) && threshold >= 1 && threshold <= 99 ? threshold : DEFAULT_THRESHOLD;
}

function normalizeHeader(value) {
  return String(value || "").replace(/[\r\n]/g, " ").trim();
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function html(title, message, status = 200) {
  return new Response(`<!doctype html><meta name="referrer" content="no-referrer"><title>${title}</title><h1>${title}</h1><p>${message}</p><p><a href="/">Aurora Forecast Now</a></p>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

function invalidToken() {
  return html("Invalid or expired link", "Request a new alert link and try again.", 400);
}
