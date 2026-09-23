import assert from "node:assert/strict";
import { parseMessageCursor } from "../../packages/server/src/services/storage/chats.storage.js";
import {
  buildFocusedNpcProfileMessages,
  encodeMessageCursor,
  isRelevantNpcName,
  sourceSnapshotMatches,
} from "../../packages/server/src/services/game/npc-retroactive.js";
import { buildNpcProfileContext } from "../../packages/server/src/services/game/npc-profile.js";
import { extractNamedRoleNpcNames } from "../../packages/shared/src/utils/game-npc-narration.js";

const roster =
  "The roster identifies Ysanne Korr, butler and manager; Brina Holt, senior housemaid responsible for rooms; " +
  "Brina Holt, senior housemaid responsible for rooms; and Orla Kes, carriage driver responsible for transport.";
assert.deepEqual(extractNamedRoleNpcNames(roster), ["Ysanne Korr", "Brina Holt", "Orla Kes"]);
assert.deepEqual(
  extractNamedRoleNpcNames("The Orynath, city, has a silver table; the group, item, remains sealed."),
  [],
  "places, groups, and objects are not NPCs",
);
assert.deepEqual(extractNamedRoleNpcNames("Stone Keep, where the guard waits."), [], "role must start the apposition");

const old = {
  id: "old|npc",
  chatId: "previous-session",
  role: "narrator",
  content: "Ann, the archivist, kept the sealed records.",
  createdAt: "2026-09-01T00:00:00.000Z",
  activeSwipeIndex: 1,
};
const correction = {
  id: "new-user",
  chatId: "current-session",
  role: "user",
  content: "Ann has a scar across her left cheek; make her card reflect that.",
  createdAt: "2026-09-19T00:00:00.000Z",
  activeSwipeIndex: 0,
};

const cursor = encodeMessageCursor(old);
assert.deepEqual(parseMessageCursor(cursor), { createdAt: old.createdAt, id: old.id });
assert.equal(isRelevantNpcName("Ann", [correction.content], ["Ann", "Joanna"]), true);
assert.equal(isRelevantNpcName("Ann", ["Joanna arrived."], ["Ann", "Joanna"]), false);
assert.equal(isRelevantNpcName("Ann", ["The old story introduced Ann."], ["Ann"]), true);
assert.equal(isRelevantNpcName("Sera Vale", ["Create Sera's card."], ["Sera Vale"]), true);
assert.equal(isRelevantNpcName("Alex Smith", ["Remember Alex?"], ["Alex Smith", "Alex Jones"]), false);
assert.equal(isRelevantNpcName("Alex Smith", ["Remember Alex Smith?"], ["Alex Smith", "Alex Jones"]), true);

const focused = buildFocusedNpcProfileMessages([old, correction], [old.id]);
assert.deepEqual(
  focused.map((message) => message.id),
  [old.id, correction.id],
);
const longOld = { ...old, content: `Ann was introduced in the canonical opening. ${"irrelevant detail ".repeat(900)}` };
const boundedContext = JSON.parse(
  buildNpcProfileContext(
    [{ npcId: "npc:ann", name: "Ann", description: "archivist", appearance: "" }],
    buildFocusedNpcProfileMessages(
      [
        longOld,
        { ...correction, content: "Ann has a NEW scar correction." },
        ...Array.from({ length: 20 }, (_, index) => ({
          ...correction,
          id: `noise-${index}`,
          content: "unrelated recent text",
        })),
      ],
      [longOld.id],
    ),
    [],
  ),
);
assert.match(
  boundedContext.transcript.map((message: { content: string }) => message.content).join("\n"),
  /Ann was introduced/,
);
assert.match(
  boundedContext.transcript.map((message: { content: string }) => message.content).join("\n"),
  /NEW scar correction/,
);
assert.equal(
  sourceSnapshotMatches({ chatId: old.chatId!, messageId: old.id, swipeIndex: 1, content: old.content }, old),
  true,
);
assert.equal(
  sourceSnapshotMatches(
    { chatId: old.chatId!, messageId: old.id, swipeIndex: 1, content: old.content },
    { ...old, chatId: "wrong-session" },
  ),
  false,
);
assert.equal(
  sourceSnapshotMatches(
    { chatId: old.chatId!, messageId: old.id, swipeIndex: 1, content: old.content },
    { ...old, activeSwipeIndex: 2 },
  ),
  false,
);
assert.equal(
  sourceSnapshotMatches(
    { chatId: old.chatId!, messageId: old.id, swipeIndex: 1, content: old.content },
    { ...old, content: "edited" },
  ),
  false,
);
const buried = {
  ...old,
  content: `${"unrelated ".repeat(2000)}Ann, the archivist, carries the sealed ledger.${"unrelated ".repeat(2000)}`,
};
const crowdedHistory = [
  buried,
  ...Array.from({ length: 15 }, (_, index) => ({
    ...old,
    id: `old-${index}`,
    content: "unrelated history ".repeat(1500),
  })),
  ...Array.from({ length: 15 }, (_, index) => ({
    ...old,
    id: `recent-${index}`,
    content: "unrelated narration ".repeat(1500),
  })),
  correction,
];
const pressure = buildFocusedNpcProfileMessages(
  crowdedHistory,
  [buried.id, ...crowdedHistory.slice(1, 16).map((m) => m.id)],
  60_000,
  ["Ann"],
);
assert.ok(
  pressure.reduce((sum, m) => sum + m.content.length, 0) <= 60_000,
  "provider evidence stays within its budget",
);
assert.equal(pressure.at(-1)?.id, correction.id, "latest correction stays last chronologically");
const finalPressure = JSON.parse(buildNpcProfileContext([], pressure, []))
  .transcript.map((m: { content: string }) => m.content)
  .join("\n");
assert.ok(
  finalPressure.includes("Ann, the archivist, carries the sealed ledger."),
  "middle-of-message historical evidence reaches provider",
);
assert.ok(finalPressure.includes(correction.content), "historical pins cannot displace the newest correction");
assert.equal(
  sourceSnapshotMatches(
    { chatId: old.chatId, messageId: old.id, swipeIndex: 1, content: old.content },
    { ...old, id: "another-message" },
  ),
  false,
);
assert.deepEqual(buildFocusedNpcProfileMessages([old, correction], [old.id], 0), []);
console.log("npc retroactive helper regression passed");
