import assert from "node:assert/strict";

import { splitGameLorePrompt } from "../../packages/server/src/services/generation/game-lore-prompt.js";
import { normalizePromptCacheLayout } from "../../packages/server/src/services/generation/prompt-cache-layout.js";

const scan = {
  worldInfoBefore: "core-before\n\nconditional-before\n\nmacro-before",
  worldInfoAfter: "core-after\n\nconditional-after",
  activatedEntries: [
    {
      id: "core-before",
      content: "core-before",
      matchedKeys: [],
      activationSources: [],
      matchType: "always_loaded" as const,
    },
    {
      id: "conditional-before",
      content: "conditional-before",
      matchedKeys: [],
      activationSources: [],
      matchType: "keyword" as const,
    },
    {
      id: "macro-before",
      content: "resolved macro-before",
      matchedKeys: [],
      activationSources: [],
      matchType: "keyword" as const,
    },
    {
      id: "core-after",
      content: "core-after",
      matchedKeys: [],
      activationSources: [],
      matchType: "always_loaded" as const,
    },
    {
      id: "conditional-after",
      content: "conditional-after",
      matchedKeys: [],
      activationSources: [],
      matchType: "keyword" as const,
    },
  ],
};

const stored = new Map([
  ["core-before", { content: "core-before", alwaysLoaded: true, position: 0 as const, order: 1 }],
  ["conditional-before", { content: "conditional-before", alwaysLoaded: false, position: 0 as const, order: 2 }],
  ["macro-before", { content: "{{getvar::scene}}", alwaysLoaded: true, position: 0 as const, order: 3 }],
  ["core-after", { content: "core-after", alwaysLoaded: true, position: 1 as const, order: 4 }],
  ["conditional-after", { content: "conditional-after", alwaysLoaded: false, position: 1 as const, order: 5 }],
]);

const first = splitGameLorePrompt(scan, stored);
assert.equal(first.stable, "core-before\ncore-after");
assert.equal(first.runtime, "conditional-before\n\nresolved macro-before\nconditional-after");
assert.equal((first.stable?.match(/core-before/g) ?? []).length, 1);
assert.equal((first.runtime?.match(/conditional-before/g) ?? []).length, 1);

const changed = splitGameLorePrompt(
  {
    ...scan,
    activatedEntries: scan.activatedEntries.map((entry) =>
      entry.id === "conditional-before" ? { ...entry, content: "changed conditional-before" } : entry,
    ),
  },
  stored,
);
assert.equal(changed.stable, first.stable);
assert.equal(changed.runtime, "changed conditional-before\n\nresolved macro-before\nconditional-after");

const assembled = [
  { role: "system" as const, content: "GM instructions" },
  {
    role: "system" as const,
    content: `<lore>\n${first.stable}\n</lore>`,
    contextKind: "prompt" as const,
    providerMetadata: { marinaraFullLoreContext: true },
  },
  {
    role: "system" as const,
    content: `<lore>\n${first.runtime}\n</lore>`,
    contextKind: "injection" as const,
    providerMetadata: { marinaraRuntimeContext: true, marinaraDynamicLoreContext: true },
  },
];
assembled[0]!.content += " capability-context";
const normalized = normalizePromptCacheLayout(assembled);
assert.equal(normalized[0]?.content, "<lore>\ncore-before\ncore-after\n</lore>");
assert.equal(normalized.filter((message) => message.content.includes("conditional-before")).length, 1);

const missingMetadata = splitGameLorePrompt(scan, new Map([["core-before", stored.get("core-before")]]));
assert.equal(missingMetadata.stable, undefined);
assert.equal(
  missingMetadata.runtime,
  "core-before\n\nconditional-before\n\nmacro-before\ncore-after\n\nconditional-after",
);

console.log("game-lore-cache regression passed");
