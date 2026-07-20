import assert from "node:assert/strict";
import test from "node:test";

import {
  ALERT_PROMPT_DISMISS_MS,
  ALERT_PROMPT_STORAGE_KEY,
  markAlertPromptDismissed,
  markAlertPromptSaved,
  shouldShowAlertPrompt,
} from "../assets/alert-prompt.js";

function memoryStorage(initialValue = null) {
  const values = new Map();
  if (initialValue !== null) values.set(ALERT_PROMPT_STORAGE_KEY, initialValue);
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    value() {
      return values.get(ALERT_PROMPT_STORAGE_KEY) ?? null;
    },
  };
}

test("the prompt shows with no state and fails open on malformed state", () => {
  assert.equal(shouldShowAlertPrompt(memoryStorage(), 1_000), true);
  assert.equal(shouldShowAlertPrompt(memoryStorage("{broken"), 1_000), true);
});

test("dismissal suppresses the prompt for exactly fourteen days", () => {
  const storage = memoryStorage();
  const now = 1_000;

  assert.equal(markAlertPromptDismissed(storage, now), true);
  assert.deepEqual(JSON.parse(storage.value()), {
    status: "dismissed",
    until: now + ALERT_PROMPT_DISMISS_MS,
  });
  assert.equal(shouldShowAlertPrompt(storage, now + ALERT_PROMPT_DISMISS_MS - 1), false);
  assert.equal(shouldShowAlertPrompt(storage, now + ALERT_PROMPT_DISMISS_MS), true);
});

test("a saved request suppresses the prompt without persisting contact data", () => {
  const storage = memoryStorage();

  assert.equal(markAlertPromptSaved(storage), true);
  assert.deepEqual(JSON.parse(storage.value()), { status: "saved" });
  assert.doesNotMatch(storage.value(), /email|@/i);
  assert.equal(shouldShowAlertPrompt(storage, Number.MAX_SAFE_INTEGER), false);
});

test("unavailable browser storage never blocks the site", () => {
  const storage = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
  };

  assert.equal(shouldShowAlertPrompt(storage, 1_000), true);
  assert.equal(markAlertPromptDismissed(storage, 1_000), false);
  assert.equal(markAlertPromptSaved(storage), false);
});
