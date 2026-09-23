import assert from "node:assert/strict";
import {
  DEFAULT_BACKGROUND_CALLS_PER_HOUR,
  backgroundCallsPerHourLimit,
  resetBackgroundCallBudgetForTests,
  tryConsumeBackgroundCall,
} from "../../packages/server/src/services/generation/background-call-budget.js";
import { resetFeatureSettingsForTests } from "../../packages/server/src/services/features/feature-settings.js";

// Settings > Features "Background call cap" (backgroundCallCap + backgroundCallsPerHour). ON (default)
// is today: 600 automatic calls per rolling hour. The number replaces 600. OFF is upstream: no cap.
// MARINARA_BACKGROUND_CALLS_PER_HOUR wins over both when set, as before.
delete process.env.MARINARA_BACKGROUND_CALLS_PER_HOUR;
const now = Date.parse("2026-09-23T12:00:00.000Z");

try {
  resetBackgroundCallBudgetForTests();
  resetFeatureSettingsForTests();
  assert.equal(backgroundCallsPerHourLimit(), DEFAULT_BACKGROUND_CALLS_PER_HOUR, "ON: today's default");
  assert.equal(DEFAULT_BACKGROUND_CALLS_PER_HOUR, 600);

  resetFeatureSettingsForTests({ backgroundCallsPerHour: 2 });
  assert.equal(backgroundCallsPerHourLimit(), 2, "the Features number sets the cap");
  assert.equal(tryConsumeBackgroundCall("test", now).allowed, true);
  assert.equal(tryConsumeBackgroundCall("test", now + 1).allowed, true);
  assert.equal(tryConsumeBackgroundCall("test", now + 2).allowed, false, "ON: the third call in the hour is refused");

  resetFeatureSettingsForTests({ backgroundCallCap: false, backgroundCallsPerHour: 2 });
  assert.equal(backgroundCallsPerHourLimit(), 0, "OFF: no cap");
  for (let index = 0; index < 5; index += 1) {
    assert.equal(tryConsumeBackgroundCall("test", now + 10 + index).allowed, true, "OFF: never refused");
  }

  process.env.MARINARA_BACKGROUND_CALLS_PER_HOUR = "7";
  assert.equal(backgroundCallsPerHourLimit(), 7, "env wins over a saved off");
  process.env.MARINARA_BACKGROUND_CALLS_PER_HOUR = "off";
  resetFeatureSettingsForTests({ backgroundCallsPerHour: 3 });
  assert.equal(backgroundCallsPerHourLimit(), 0, "env off wins over a saved on");
  process.env.MARINARA_BACKGROUND_CALLS_PER_HOUR = "junk";
  assert.equal(backgroundCallsPerHourLimit(), DEFAULT_BACKGROUND_CALLS_PER_HOUR, "invalid env keeps today's fallback");
} finally {
  delete process.env.MARINARA_BACKGROUND_CALLS_PER_HOUR;
  resetFeatureSettingsForTests();
  resetBackgroundCallBudgetForTests();
}

console.log("feature-switch-background-cap regression passed");
