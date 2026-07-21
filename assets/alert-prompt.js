export const ALERT_PROMPT_STORAGE_KEY = "aurora:alert-prompt:v1";
export const ALERT_PROMPT_DISMISS_MS = 14 * 24 * 60 * 60 * 1000;

export function shouldShowAlertPrompt(storage, now = Date.now()) {
  const state = readAlertPromptState(storage);
  if (!state) return true;
  if (state.status === "saved") return false;
  if (state.status === "dismissed" && Number.isFinite(state.until)) {
    return state.until <= now;
  }
  return true;
}

export function markAlertPromptDismissed(storage, now = Date.now()) {
  return writeAlertPromptState(storage, {
    status: "dismissed",
    until: now + ALERT_PROMPT_DISMISS_MS,
  });
}

export function markAlertPromptSaved(storage) {
  return writeAlertPromptState(storage, { status: "saved" });
}

function readAlertPromptState(storage) {
  if (!storage) return null;
  try {
    const value = storage.getItem(ALERT_PROMPT_STORAGE_KEY);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function writeAlertPromptState(storage, state) {
  if (!storage) return false;
  try {
    storage.setItem(ALERT_PROMPT_STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

function initializeAlertPrompt() {
  const prompt = document.querySelector("[data-alert-prompt]");
  if (!prompt) return;

  let storage = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }

  const closeButton = prompt.querySelector("[data-alert-prompt-close]");
  const citySelect = prompt.querySelector('select[name="citySlug"]');
  let lastOpener = null;
  const showPrompt = (opener = null) => {
    lastOpener = opener;
    const citySlug = opener?.dataset.alertCity || "";
    if (citySlug && citySelect?.querySelector(`option[value="${CSS.escape(citySlug)}"]`)) {
      citySelect.value = citySlug;
    }
    if (!prompt.open) {
      if (typeof prompt.showModal === "function") prompt.showModal();
      else prompt.setAttribute("open", "");
    }
    window.setTimeout(() => citySelect?.focus(), 0);
  };
  const dismiss = () => {
    if (prompt.dataset.alertSaved === "true") return;
    markAlertPromptDismissed(storage);
    if (prompt.open) prompt.close();
  };

  closeButton?.addEventListener("click", dismiss);
  prompt.addEventListener("cancel", () => {
    if (prompt.dataset.alertSaved !== "true") markAlertPromptDismissed(storage);
  });
  prompt.addEventListener("click", (event) => {
    if (event.target === prompt) dismiss();
  });
  prompt.addEventListener("close", () => lastOpener?.focus());
  document.querySelectorAll("[data-open-alert-prompt]").forEach((button) => {
    button.addEventListener("click", () => showPrompt(button));
  });
  document.addEventListener("aurora:alert-saved", () => {
    prompt.dataset.alertSaved = "true";
    markAlertPromptSaved(storage);
    window.setTimeout(() => {
      if (prompt.open) prompt.close();
    }, 1_200);
  });

  window.setTimeout(() => {
    if (!shouldShowAlertPrompt(storage) || prompt.open) return;
    showPrompt();
  }, 850);
}

if (typeof document !== "undefined") initializeAlertPrompt();
