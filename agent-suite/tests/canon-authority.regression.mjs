import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageIds = [
  "card-evolution-auditor",
  "character-tracker",
  "continuity",
  "custom-tracker",
  "director",
  "inventory-tracker",
  "lorebook-keeper",
  "memory-nag",
  "persona-stats",
  "prose-guardian",
  "quest",
  "world-state",
];

function prompts(value, result = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => prompts(item, result));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "defaultPromptTemplate" && typeof child === "string") result.push(child);
      else prompts(child, result);
    }
  }
  return result;
}

for (const packageId of packageIds) {
  const file = path.join(root, "packages", packageId, "agents.json");
  const definition = JSON.parse(fs.readFileSync(file, "utf8"));
  const packagePrompts = prompts(definition);
  assert.ok(packagePrompts.length > 0, `${packageId} has no default prompt`);
  assert.ok(
    packagePrompts.every(
      (prompt) =>
        prompt.includes("Source authority:") ||
        prompt.includes("Treat assistant text as candidate evidence") ||
        prompt.includes("There is no drama quota") ||
        prompt.includes("Treat user-authored") ||
        prompt.includes("Preserve every source-backed"),
    ),
    `${packageId} is missing the canon-authority guard`,
  );
}

console.log(`Checked canon-authority guards in ${packageIds.length} packages.`);
