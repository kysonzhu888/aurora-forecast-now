const LEMON_LICENSE_VALIDATE_URL = "https://api.lemonsqueezy.com/v1/licenses/validate";
const MAX_LICENSE_KEY_LENGTH = 120;
const SHA256_HEX_LENGTH = 64;

export async function handleProLicenseRequest(request, env = {}, options = {}) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed." }, 405);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const licenseKey = normalizeLicenseKey(payload.licenseKey || payload.license_key);
  if (!licenseKey) {
    return json({ ok: false, error: "Enter an Aurora Pro access key." }, 400);
  }

  const founderAccessHash = normalizeSha256Hash(env.AURORA_PRO_FOUNDER_ACCESS_HASH);
  if (founderAccessHash && await sha256(licenseKey) === founderAccessHash) {
    return json({
      ok: true,
      license: { status: "valid", productName: "Aurora Pro", source: "founder" },
    });
  }

  const allowedProductId = String(env.AURORA_LEMONSQUEEZY_PRODUCT_ID || "").trim();
  if (!allowedProductId) {
    return json({ ok: false, error: "Aurora Pro purchases are not configured yet." }, 503);
  }

  const validation = await validateWithLemonSqueezy(
    licenseKey,
    options.fetchImpl || globalThis.fetch,
  );
  if (validation.type === "unavailable") {
    return json({ ok: false, error: validation.error }, validation.status);
  }
  if (!validation.payload.valid) {
    return json({
      ok: false,
      error: validation.payload.error || "This Aurora Pro access key is not valid.",
    }, 401);
  }

  const productId = String(validation.payload.meta?.product_id || "");
  if (productId !== allowedProductId) {
    return json({ ok: false, error: "This access key belongs to a different product." }, 403);
  }

  return json({
    ok: true,
    license: {
      status: validation.payload.license_key?.status || "valid",
      productName: validation.payload.meta?.product_name || "Aurora Pro",
      source: "lemonsqueezy",
    },
  });
}

async function validateWithLemonSqueezy(licenseKey, fetchImpl) {
  const body = new URLSearchParams();
  body.set("license_key", licenseKey);

  let response;
  try {
    response = await fetchImpl(LEMON_LICENSE_VALIDATE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  } catch {
    return unavailable("License validation is temporarily unavailable.", 503);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return unavailable("License validation returned an unreadable response.", 502);
  }

  if (!response.ok) {
    return {
      payload: {
        valid: false,
        error: payload.error || "License validation failed.",
      },
    };
  }
  return { payload };
}

function unavailable(error, status) {
  return { type: "unavailable", error, status };
}

function normalizeLicenseKey(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .slice(0, MAX_LICENSE_KEY_LENGTH);
}

function normalizeSha256Hash(value) {
  const hash = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]+$/.test(hash) && hash.length === SHA256_HEX_LENGTH ? hash : "";
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
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
