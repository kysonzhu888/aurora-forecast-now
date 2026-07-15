const LEMON_LICENSE_API_BASE_URL = "https://api.lemonsqueezy.com/v1/licenses";
const LEMON_LICENSE_PATHS = Object.freeze({
  activate: `${LEMON_LICENSE_API_BASE_URL}/activate`,
  deactivate: `${LEMON_LICENSE_API_BASE_URL}/deactivate`,
  validate: `${LEMON_LICENSE_API_BASE_URL}/validate`,
});
const LICENSE_ACTIONS = new Set(["activate", "deactivate", "validate"]);
const LICENSE_ACTION_LABELS = Object.freeze({
  activate: "activation",
  deactivate: "deactivation",
  validate: "validation",
});
const MAX_LICENSE_KEY_LENGTH = 120;
const SHA256_HEX_LENGTH = 64;
const UUID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const INSTANCE_NAME_PATTERN = /^Aurora Web [a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

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
  if (licenseKey.length > MAX_LICENSE_KEY_LENGTH) {
    return json({ ok: false, error: "That Aurora Pro access key is too long." }, 400);
  }

  const action = normalizeAction(payload.action);
  if (!action) {
    return json({ ok: false, error: "Unsupported license action." }, 400);
  }

  const founderAccessHash = normalizeSha256Hash(env.AURORA_PRO_FOUNDER_ACCESS_HASH);
  if (founderAccessHash && await sha256(licenseKey) === founderAccessHash) {
    if (action === "deactivate") return json({ ok: true, deactivated: true });
    return json({
      ok: true,
      license: { status: "valid", productName: "Aurora Pro", source: "founder" },
    });
  }

  const productContract = readProductContract(env);
  if (!productContract.productId) {
    return json({ ok: false, error: "Aurora Pro purchases are not configured yet." }, 503);
  }

  const instanceId = normalizeInstanceId(payload.instanceId || payload.instance_id);
  if ((payload.instanceId || payload.instance_id) && !instanceId) {
    return json({ ok: false, error: "The saved Aurora Pro browser activation is invalid." }, 400);
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (action === "activate") {
    const instanceName = normalizeInstanceName(payload.instanceName || payload.instance_name);
    if (!instanceName) {
      return json({ ok: false, error: "Aurora Pro needs an anonymous browser activation name." }, 400);
    }
    return activateLicense(licenseKey, instanceName, productContract, fetchImpl);
  }

  if (action === "deactivate") {
    if (!instanceId) {
      return json({ ok: false, error: "The Aurora Pro browser activation is missing." }, 400);
    }
    return deactivateLicense(licenseKey, instanceId, productContract, fetchImpl);
  }

  return validateLicense(licenseKey, instanceId, productContract, fetchImpl);
}

async function activateLicense(licenseKey, instanceName, productContract, fetchImpl) {
  const validation = await requestLemon("validate", { licenseKey }, fetchImpl);
  const validationError = validateEntitlementResponse(validation, productContract);
  if (validationError) return validationError;

  const activation = await requestLemon("activate", { licenseKey, instanceName }, fetchImpl);
  if (activation.type === "unavailable") {
    return json({ ok: false, error: activation.error }, activation.status);
  }
  if (!activation.responseOk || !activation.payload.activated) {
    return json({
      ok: false,
      error: activation.payload.error || "This key could not activate another browser.",
    }, 409);
  }

  const contractError = productContractError(activation.payload, productContract);
  if (contractError) return contractError;

  const instanceId = normalizeInstanceId(activation.payload.instance?.id);
  if (!instanceId) {
    return json({ ok: false, error: "License activation returned an invalid browser instance." }, 502);
  }

  return licenseSuccess(activation.payload, instanceId);
}

async function validateLicense(licenseKey, instanceId, productContract, fetchImpl) {
  const validation = await requestLemon("validate", { licenseKey, instanceId }, fetchImpl);
  const validationError = validateEntitlementResponse(validation, productContract);
  if (validationError) return validationError;

  if (instanceId) {
    const returnedInstanceId = normalizeInstanceId(validation.payload.instance?.id);
    if (returnedInstanceId !== instanceId) {
      return json({ ok: false, error: "This browser activation is no longer valid." }, 401);
    }
  }

  return licenseSuccess(validation.payload, instanceId || undefined);
}

async function deactivateLicense(licenseKey, instanceId, productContract, fetchImpl) {
  const validation = await requestLemon("validate", { licenseKey, instanceId }, fetchImpl);
  const validationError = validateEntitlementResponse(validation, productContract);
  if (validationError) return validationError;

  const returnedInstanceId = normalizeInstanceId(validation.payload.instance?.id);
  if (returnedInstanceId !== instanceId) {
    return json({ ok: false, error: "This browser activation is no longer valid." }, 401);
  }

  const deactivation = await requestLemon("deactivate", { licenseKey, instanceId }, fetchImpl);
  if (deactivation.type === "unavailable") {
    return json({ ok: false, error: deactivation.error }, deactivation.status);
  }
  if (!deactivation.responseOk || !deactivation.payload.deactivated) {
    return json({
      ok: false,
      error: deactivation.payload.error || "This browser activation could not be released.",
    }, 409);
  }
  return json({ ok: true, deactivated: true });
}

function validateEntitlementResponse(result, productContract) {
  if (result.type === "unavailable") {
    return json({ ok: false, error: result.error }, result.status);
  }
  if (!result.responseOk || !result.payload.valid) {
    return json({
      ok: false,
      error: result.payload.error || "This Aurora Pro access key is not valid.",
    }, 401);
  }
  return productContractError(result.payload, productContract);
}

function productContractError(payload, productContract) {
  const productId = String(payload.meta?.product_id || "");
  if (productId !== productContract.productId) {
    return json({ ok: false, error: "This access key belongs to a different product." }, 403);
  }

  const variantId = String(payload.meta?.variant_id || "");
  if (productContract.variantId && variantId !== productContract.variantId) {
    return json({ ok: false, error: "This access key belongs to a different offer." }, 403);
  }

  const status = String(payload.license_key?.status || "").toLowerCase();
  if (status === "expired" || status === "disabled") {
    return json({ ok: false, error: `This Aurora Pro access key is ${status}.` }, 401);
  }
  return null;
}

async function requestLemon(action, values, fetchImpl) {
  const actionLabel = LICENSE_ACTION_LABELS[action];
  const body = new URLSearchParams();
  body.set("license_key", values.licenseKey);
  if (values.instanceId) body.set("instance_id", values.instanceId);
  if (values.instanceName) body.set("instance_name", values.instanceName);

  let response;
  try {
    response = await fetchImpl(LEMON_LICENSE_PATHS[action], {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  } catch {
    return unavailable(`License ${actionLabel} is temporarily unavailable.`, 503);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return unavailable(`License ${actionLabel} returned an unreadable response.`, 502);
  }

  if (response.status === 429 || response.status >= 500) {
    return unavailable(`License ${actionLabel} is temporarily unavailable.`, 503);
  }
  return { payload, responseOk: response.ok };
}

function licenseSuccess(payload, instanceId) {
  const license = {
    status: payload.license_key?.status || "valid",
    productName: payload.meta?.product_name || "Aurora Pro",
    source: "lemonsqueezy",
  };
  if (instanceId) license.instanceId = instanceId;
  return json({ ok: true, license });
}

function readProductContract(env) {
  return {
    productId: String(env.AURORA_LEMONSQUEEZY_PRODUCT_ID || "").trim(),
    variantId: String(env.AURORA_LEMONSQUEEZY_VARIANT_ID || "").trim(),
  };
}

function unavailable(error, status) {
  return { type: "unavailable", error, status };
}

function normalizeAction(value) {
  const action = String(value || "validate").trim().toLowerCase();
  return LICENSE_ACTIONS.has(action) ? action : "";
}

function normalizeLicenseKey(value) {
  return String(value || "").replace(/\s+/g, "");
}

function normalizeInstanceId(value) {
  const instanceId = String(value || "").trim();
  return UUID_PATTERN.test(instanceId) ? instanceId.toLowerCase() : "";
}

function normalizeInstanceName(value) {
  const instanceName = String(value || "").trim();
  return INSTANCE_NAME_PATTERN.test(instanceName) ? instanceName : "";
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
