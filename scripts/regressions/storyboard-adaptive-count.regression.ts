import assert from "node:assert/strict";
import {
  resolveAdaptiveStoryboardKeyframeCount,
  normalizeStoryboardAgentSettings,
} from "../../packages/shared/src/index.js";

const count = (words: number, sections: number, enabled = true, maximum = 10, baseCount = 3) =>
  resolveAdaptiveStoryboardKeyframeCount({
    baseCount,
    enabled,
    maximum,
    sourceText: "word ".repeat(words),
    sectionCount: sections,
  });
assert.equal(count(800, 12), 3);
assert.equal(count(7364, 317), 8);
assert.equal(count(6000, 80), 6);
assert.equal(count(500, 240), 6);
assert.equal(count(24000, 1001), 10);
assert.equal(count(7364, 317, false), 3);
assert.equal(count(7364, 317, true, 6), 6);
assert.equal(count(800, 12, true, 4, 8), 4);
const legacy = normalizeStoryboardAgentSettings({ keyframeCount: 3 });
assert.equal(legacy.adaptiveKeyframeCount, false);
assert.equal(legacy.maxAutomaticKeyframes, 10);
const enabled = normalizeStoryboardAgentSettings({
  adaptiveKeyframeCount: true,
  maxAutomaticKeyframes: 8,
  keyframeCount: 10,
});
assert.equal(enabled.adaptiveKeyframeCount, true);
assert.equal(enabled.maxAutomaticKeyframes, 8);
assert.equal(enabled.keyframeCount, 10);
console.info(
  "Adaptive storyboard coverage grows with words or scene sections, respects the maximum, and preserves fixed legacy settings.",
);

// Exercise the real plan sanitizer's count handling; isolate unrelated appearance/range helpers.
const { readFileSync } = await import("node:fs");
const { createRequire } = await import("node:module");
const require = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const ts = require("typescript");
const route = readFileSync(new URL("../../packages/server/src/routes/game.routes.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("game.routes.ts", route, ts.ScriptTarget.Latest, true);
const sanitizerSource = ast.statements
  .find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "sanitizeStoryboardPlan")
  .getText(ast);
const helpers = {
  asStoryboardRecord: (value) => value ?? {},
  fallbackStoryboardPlan: () => ({ title: "Fallback", summary: "", keyframes: [] }),
  normalizeStoryboardKeyframeCount: (value) => Math.max(1, Math.min(10, value)),
  compactStoryboardText: (value) => (typeof value === "string" ? value : ""),
  compactStoryboardAnimationPrompt: (value) => value ?? "",
  normalizeStoryboardSectionIndex: () => null,
  storyboardSectionsForRange: () => [],
  normalizeStoryboardAnchorKind: () => "narration",
  dominantStoryboardSectionKind: () => "narration",
  storyboardSectionText: (section) => section.content,
  reconcileStoryboardCharactersForFrame: () => ({ characters: [], omittedMentionedCharacters: [] }),
  appendStoryboardCharacterScopeToPrompt: (prompt) => prompt,
  sanitizeStoryboardCharacterPrompts: () => [],
  normalizeStoryboardDuration: () => 5,
  normalizeStoryboardAspectRatio: () => "16:9",
};
const sanitize = new Function(
  ...Object.keys(helpers),
  ts.transpileModule(sanitizerSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText +
    ";return sanitizeStoryboardPlan;",
)(...Object.values(helpers));
const raw = {
  keyframes: Array.from({ length: 12 }, (_, index) => ({
    title: `Beat ${index + 1}`,
    imagePrompt: `Distinct action ${index + 1}`,
  })),
};
for (const requested of [3, 6, 8, 10]) {
  const plan = sanitize(raw, {
    keyframeCount: requested,
    sections: [],
    sourceNarration: "The full evening",
    durationSeconds: 5,
    aspectRatio: "16:9",
  });
  assert.equal(plan.keyframes.length, requested);
  assert.equal(plan.keyframes.at(-1).title, `Beat ${requested}`);
}
console.info("The route sanitizer retains all eight or ten requested frames and trims only surplus planner output.");
