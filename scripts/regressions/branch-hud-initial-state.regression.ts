import assert from "node:assert/strict";
import { restoreBranchHudLists } from "../../packages/server/src/services/game/branch-state.js";
import type { HudWidget } from "../../packages/shared/src/types/game.js";

function listWidget(id: string, label: string, items: string[]): HudWidget {
  return {
    id,
    type: "list",
    label,
    position: "hud_left",
    config: { items, nested: { markers: [id] } },
  } as HudWidget;
}

const startingSpells = [
  "Ashen ward",
  "Blue flame",
  "Cinder step",
  "Dawn veil",
  "Ember sight",
  "Frost knot",
  "Gale thread",
];
const startingRumors = [
  "A bell rings beneath the lake",
  "The west road is watched",
  "A courier never arrived",
  "The old tower has a keeper",
  "A seal was broken",
  "The miller pays in silver",
  "Footprints end at the shrine",
  "Someone asked after the map",
];
const baseline: HudWidget[] = [
  listWidget("spell_library", "Learned spells", startingSpells),
  {
    id: "rumor_board",
    type: "rumor_board",
    label: "Rumors",
    position: "hud_right",
    config: {
      rumors: startingRumors.map((text) => ({ text, status: "unverified" as const })),
      nested: { markers: ["rumor_board"] },
    },
  },
  ...Array.from({ length: 15 }, (_, index) =>
    listWidget("inherited_" + index, "Inherited widget " + index, ["state " + index]),
  ),
];
const expectedBaseline = structuredClone(baseline);
const sourceMeta = {
  gameExtendedWidgetsEnabled: true,
  gameWidgetInitialState: baseline,
  gameBlueprint: {
    hudWidgets: Array.from({ length: 6 }, (_, index) => listWidget("blueprint_" + index, "Blueprint " + index, [])),
  },
  // Deliberately contains state from after the selected fork cutoff.
  gameWidgetState: [
    ...structuredClone(baseline),
    listWidget("spell_library", "Learned spells", [...startingSpells, "Future spell"]),
  ],
};
const sourceMessages = [
  { content: '[widget: spell_library,add:"Moonlit ward"]' },
  { content: '[widget: rumor_board,add:"Future rumor"]' },
];

const firstBranchState = restoreBranchHudLists(sourceMeta, sourceMessages.slice(0, 1));
assert.equal(firstBranchState.length, 17, "the session baseline keeps inherited dynamic widgets");
assert.deepEqual(
  firstBranchState.find((widget) => widget.id === "spell_library")?.config.items,
  [...startingSpells, "Moonlit ward"],
  "the fork keeps inherited spells and applies only the copied prefix",
);
const initialRumorConfig = {
  rumors: startingRumors.map((text) => ({ text, status: "unverified" })),
  nested: { markers: ["rumor_board"] },
};
assert.deepEqual(
  firstBranchState.find((widget) => widget.id === "rumor_board")?.config,
  initialRumorConfig,
  "the fork keeps the inherited rumor widget's full config",
);
assert.equal(
  firstBranchState.some((widget) => widget.config.items?.includes("Future spell")),
  false,
  "mutable source end state does not leak into the fork",
);
assert.equal(
  (firstBranchState.find((widget) => widget.id === "rumor_board")?.config.rumors ?? []).some(
    (rumor) => rumor.text === "Future rumor",
  ),
  false,
  "a post-cutoff rumor command does not leak into the fork",
);
assert.equal(
  firstBranchState.some((widget) => widget.id.startsWith("blueprint_")),
  false,
);
assert.notStrictEqual(
  (firstBranchState.find((widget) => widget.id === "rumor_board")?.config as any).nested.markers,
  (baseline.find((widget) => widget.id === "rumor_board")?.config as any).nested.markers,
  "nested baseline arrays are deep-cloned before replay",
);

const nestedMeta = { ...sourceMeta, gameWidgetState: firstBranchState };
const nestedBranchState = restoreBranchHudLists(nestedMeta, [
  sourceMessages[0]!,
  { content: '[widget: rumor_board,add:"Nested branch clue"]' },
]);
assert.deepEqual(
  nestedBranchState.find((widget) => widget.id === "spell_library")?.config.items,
  [...startingSpells, "Moonlit ward"],
  "a nested branch replays its retained prefix from the same immutable session baseline",
);
assert.deepEqual(
  nestedBranchState.find((widget) => widget.id === "rumor_board")?.config,
  {
    rumors: [
      ...startingRumors.slice(1).map((text) => ({ text, status: "unverified" })),
      { text: "Nested branch clue", status: "unverified" },
    ],
    nested: { markers: ["rumor_board"] },
  },
  "nested replay preserves inherited rumors and applies its copied command with normal capacity rules",
);
assert.deepEqual(baseline, expectedBaseline, "replay never mutates nested arrays in the stored baseline");

const replayedAgain = restoreBranchHudLists(sourceMeta, sourceMessages.slice(0, 1));
assert.deepEqual(replayedAgain, firstBranchState, "reset/replay produces the same cutoff state");

const legacyState = restoreBranchHudLists(
  { gameBlueprint: sourceMeta.gameBlueprint, gameWidgetState: sourceMeta.gameWidgetState },
  sourceMessages.slice(0, 1),
);
assert.equal(legacyState.length, 6, "legacy chats without a captured baseline keep the existing blueprint fallback");
assert.equal(
  legacyState.some((widget) => widget.config.items?.includes("Future spell")),
  false,
  "legacy replay still excludes mutable end-state content",
);

console.log("branch HUD initial-state regression passed");
