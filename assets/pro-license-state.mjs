const MAX_LICENSE_KEY_LENGTH = 120;
const SENSITIVE_RETURN_PARAMS = Object.freeze([
  "license_key",
  "licenseKey",
  "key",
  "order_id",
  "orderId",
]);
const LICENSE_KEY_PARAMS = Object.freeze(["license_key", "licenseKey", "key"]);
const UUID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const INSTANCE_NAME_PATTERN = /^Aurora Web [a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const ACCESS_SOURCES = new Set(["founder", "lemonsqueezy"]);

export function parseLicenseReturnUrl(href) {
  const url = new URL(href);
  const searchParams = new URLSearchParams(url.search);
  const fragmentValue = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const fragmentParams = new URLSearchParams(fragmentValue);
  const fragmentHasSensitiveParams = hasSensitiveParams(fragmentParams);
  const searchHasSensitiveParams = hasSensitiveParams(searchParams);
  const rawLicenseKey = readFirstLicenseKey(fragmentParams) || readFirstLicenseKey(searchParams);

  if (searchHasSensitiveParams) {
    SENSITIVE_RETURN_PARAMS.forEach((name) => searchParams.delete(name));
    url.search = searchParams.toString();
  }
  if (fragmentHasSensitiveParams) {
    SENSITIVE_RETURN_PARAMS.forEach((name) => fragmentParams.delete(name));
    url.hash = fragmentParams.toString();
  }

  return {
    licenseKey: normalizeLicenseKey(rawLicenseKey),
    hadSensitiveParams: searchHasSensitiveParams || fragmentHasSensitiveParams,
    cleanUrl: `${url.pathname}${url.search}${url.hash}`,
  };
}

export function createOpaqueInstanceName(cryptoImpl = globalThis.crypto) {
  const uuid = typeof cryptoImpl?.randomUUID === "function"
    ? cryptoImpl.randomUUID()
    : randomUuidFromBytes(cryptoImpl);
  if (!UUID_PATTERN.test(uuid)) {
    throw new Error("A secure browser activation identifier is unavailable.");
  }
  return `Aurora Web ${uuid.toLowerCase()}`;
}

export function normalizeOpaqueInstanceName(value) {
  const instanceName = String(value || "").trim();
  return INSTANCE_NAME_PATTERN.test(instanceName) ? instanceName : "";
}

export function normalizeStoredAccess(value) {
  const licenseKey = normalizeLicenseKey(value?.licenseKey);
  if (!value?.unlocked || !licenseKey) return null;

  const normalized = { unlocked: true, licenseKey };
  const source = String(value.source || "").trim().toLowerCase();
  if (ACCESS_SOURCES.has(source)) normalized.source = source;
  const instanceId = normalizeUuid(value.instanceId);
  if (instanceId) normalized.instanceId = instanceId;
  return normalized;
}

function hasSensitiveParams(params) {
  return SENSITIVE_RETURN_PARAMS.some((name) => params.has(name));
}

function readFirstLicenseKey(params) {
  for (const name of LICENSE_KEY_PARAMS) {
    const value = params.get(name);
    if (value) return value;
  }
  return "";
}

function normalizeLicenseKey(value) {
  const licenseKey = String(value || "").replace(/\s+/g, "");
  return licenseKey.length <= MAX_LICENSE_KEY_LENGTH ? licenseKey : "";
}

function normalizeUuid(value) {
  const uuid = String(value || "").trim();
  return UUID_PATTERN.test(uuid) ? uuid.toLowerCase() : "";
}

function randomUuidFromBytes(cryptoImpl) {
  if (typeof cryptoImpl?.getRandomValues !== "function") return "";
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
