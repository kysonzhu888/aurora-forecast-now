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
  const cityName = env.alertCityNames?.get(citySlug) || cityNameFromSlug(citySlug);
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
    const unsubscribeUrl = `${PUBLIC_ORIGIN}/api/alerts/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`;
    await sendEmail(env, settingsUpdate
      ? {
          to: email,
          subject: "Your Aurora storm alert settings updated",
          text: [
            `Your storm alert for ${cityName} is active at Score ${threshold}.`,
            `View the forecast: ${PUBLIC_ORIGIN}/cities/${citySlug}/`,
            "",
            "Unsubscribe:",
            unsubscribeUrl,
          ].join("\n"),
          html: alertEmailHtml({
            eyebrow: "Alert updated",
            title: `${cityName} alert is active`,
            message: `We will email you when the viewing score reaches ${threshold} or higher.`,
            actionLabel: "View city forecast",
            actionUrl: `${PUBLIC_ORIGIN}/cities/${citySlug}/`,
            unsubscribeUrl,
          }),
        }
      : {
          to: email,
          subject: "Confirm your Aurora Forecast Now storm alerts",
          ...confirmationEmail({
            cityName,
            threshold,
            confirmUrl: `${PUBLIC_ORIGIN}/api/alerts/confirm?token=${encodeURIComponent(confirmToken)}`,
            unsubscribeUrl,
          }),
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
        html: alertEmailHtml({
          eyebrow: "Storm alert",
          title: `${city.name} is worth a look`,
          message: `The city score is ${city.score} with a forecast Kp of ${forecast.maxKp ?? "N/A"}. Check local cloud cover before you head out.`,
          actionLabel: "Open the live forecast",
          actionUrl: `${PUBLIC_ORIGIN}/cities/${city.slug}/`,
          unsubscribeUrl: `${PUBLIC_ORIGIN}/api/alerts/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`,
        }),
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
  const nativeEmail = env.EMAIL?.send && env.ALERT_FROM_EMAIL;
  const relayEmail = validRelayUrl(env.ALERT_EMAIL_RELAY_URL) && env.ALERT_EMAIL_RELAY_SECRET;
  return Boolean(env.ALERT_TOKEN_SECRET && (nativeEmail || relayEmail));
}

async function sendEmail(env, { to, subject, text, html: emailHtml }) {
  const from = normalizeHeader(env.ALERT_FROM_EMAIL);
  const recipient = normalizeHeader(to);
  const message = {
    to: recipient,
    subject: normalizeHeader(subject),
    text,
    html: emailHtml,
  };
  if (env.EMAIL?.send && from) {
    await env.EMAIL.send({
      ...message,
      from: { email: from, name: SENDER_NAME },
    });
    return;
  }
  await sendThroughRelay(env, message);
}

async function sendThroughRelay(env, message) {
  const relayUrl = validRelayUrl(env.ALERT_EMAIL_RELAY_URL);
  if (!relayUrl || !env.ALERT_EMAIL_RELAY_SECRET) throw new Error("Email relay is not configured");
  const body = JSON.stringify(message);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await hmacHex(`${timestamp}.${body}`, env.ALERT_EMAIL_RELAY_SECRET);
  const send = typeof env.ALERT_FETCH === "function" ? env.ALERT_FETCH : fetch;
  const response = await send(relayUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Aurora-Timestamp": String(timestamp),
      "X-Aurora-Signature": `v1=${signature}`,
    },
    body,
  });
  if (!response.ok) throw new Error(`Email relay returned ${response.status}`);
}

function validRelayUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:"
      && url.hostname === "tinyneed.com"
      && url.pathname === "/api/aurora-email"
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

function confirmationEmail({ cityName, threshold, confirmUrl, unsubscribeUrl }) {
  return {
    text: [
      `Confirm storm alerts for ${cityName}:`,
      confirmUrl,
      "",
      `We will email when the viewing score reaches ${threshold} or higher.`,
      "",
      "Unsubscribe:",
      unsubscribeUrl,
    ].join("\n"),
    html: alertEmailHtml({
      eyebrow: "One quick step",
      title: `Confirm storm alerts for ${cityName}`,
      message: `We will email you when the viewing score reaches ${threshold} or higher.`,
      actionLabel: "Confirm storm alerts",
      actionUrl: confirmUrl,
      unsubscribeUrl,
    }),
  };
}

function alertEmailHtml({ eyebrow, title, message, actionLabel, actionUrl, unsubscribeUrl }) {
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#101312;color:#f4f7ef;font-family:Arial,sans-serif">
    <div style="max-width:560px;margin:0 auto;padding:40px 20px">
      <p style="margin:0 0 12px;color:#74f2a4;font-size:12px;font-weight:700;text-transform:uppercase">${escapeHtml(eyebrow)}</p>
      <h1 style="margin:0 0 16px;font-size:28px;line-height:1.2">${escapeHtml(title)}</h1>
      <p style="margin:0 0 24px;color:#c8d0c5;font-size:16px;line-height:1.6">${escapeHtml(message)}</p>
      <p style="margin:0 0 28px"><a href="${escapeHtml(actionUrl)}" style="display:inline-block;padding:13px 18px;border-radius:6px;background:#74f2a4;color:#090b0a;font-weight:700;text-decoration:none">${escapeHtml(actionLabel)}</a></p>
      <p style="margin:0;color:#9aa59a;font-size:12px;line-height:1.5">Aurora Forecast Now provides viewing guidance, not a guarantee. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#c8d0c5">Unsubscribe</a>.</p>
    </div>
  </body>
</html>`;
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

async function hmacHex(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

function cityNameFromSlug(value) {
  return String(value || "")
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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
