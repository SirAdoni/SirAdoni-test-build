import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The job tracking switch (E02) lives in Settings > Advanced > Features as a row like the others, keeps
// its own app setting (generationJobTracking), starts off, and still reaches the Generation jobs viewer.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const features = read("../../packages/client/src/components/panels/settings/FeatureSwitchesSettings.tsx");
const panel = read("../../packages/client/src/components/panels/SettingsPanel.tsx");
const row = read("../../packages/client/src/components/panels/settings/GenerationJobTrackingSettings.tsx");
const hook = read("../../packages/client/src/hooks/use-generation-job-tracking.ts");
const en = JSON.parse(read("../../packages/client/src/localization/locales/en.json")) as Record<string, string>;

assert.match(features, /<GenerationJobTrackingSettings \/>/, "the switch renders inside the Features section");
assert.doesNotMatch(panel, /GenerationJobTrackingSettings/, "no separate job tracking block in the Settings panel");
assert.doesNotMatch(panel, /id: "generation-job-tracking"/, "no separate search entry");
assert.match(panel, /"keep generating"/, "searching for the old wording still finds the Features section");
assert.match(row, /openModal\("generation-jobs"\)/, "the jobs viewer stays reachable from the row");
assert.match(hook, /\/generation-job-records\/settings/, "it keeps its own app setting route (no migration)");
assert.equal(en["settings.generationJobTracking.toggle"], "Keep generating when the tab is closed (job tracking)");
assert.ok(en["settings.generationJobTracking.startsOff"], "the row notes that it starts off");
for (const key of [
  "settings.generationJobTracking.toggle",
  "settings.generationJobTracking.help",
  "settings.generationJobTracking.startsOff",
])
  assert.ok(!en[key].includes("—"), `${key} has no em dash`);

console.log("Generation job tracking settings placement regressions passed.");
