import assert from "node:assert/strict";
import type { Lorebook } from "@marinara-engine/shared";
import { getInChatLorebookIds, planLorebookSelectionEnable } from "../../packages/client/src/lib/lorebook-selection.js";

// Covers the Lorebooks panel selection Enable/Disable planning and the
// "in this chat" dot (which lorebooks feed the open chat).

// ── Enable / Disable planning ──
{
  const enabledById = new Map([
    ["world", true],
    ["expansion", false],
    ["notes", false],
  ]);
  assert.deepEqual(
    planLorebookSelectionEnable(["world", "expansion", "notes", "gone"], enabledById, true),
    ["expansion", "notes"],
    "Enable only sends the disabled ones and skips unknown ids",
  );
  assert.deepEqual(planLorebookSelectionEnable(new Set(["world", "expansion"]), enabledById, false), ["world"]);
  assert.deepEqual(planLorebookSelectionEnable(["world"], enabledById, true), [], "nothing to flip leaves the action idle");
}

// ── In this chat ──
{
  const book = (id: string, extra: Partial<Lorebook> = {}): Lorebook =>
    ({ id, name: id, enabled: true, isGlobal: false, characterIds: [], personaIds: [], ...extra }) as Lorebook;
  const lorebooks = [
    book("pinned"),
    book("global", { isGlobal: true }),
    book("charLinked", { characterIds: ["hero"] }),
    book("personaLinked", { personaIds: ["me"] }),
    book("chatOwned", { chatId: "c1" }),
    book("off", { enabled: false, isGlobal: true }),
    book("excluded", { isGlobal: true }),
    book("otherScope", { isGlobal: true, scope: { mode: "specific", chatIds: ["c2"] } }),
    book("unrelated"),
  ];
  const chat = {
    id: "c1",
    characterIds: ["hero"],
    personaId: "me",
    metadata: JSON.stringify({ activeLorebookIds: ["pinned"], excludedLorebookIds: ["excluded"] }),
  };
  assert.deepEqual(
    [...getInChatLorebookIds(chat as never, lorebooks)].sort(),
    ["charLinked", "chatOwned", "global", "personaLinked", "pinned"],
    "pinned, global, character, persona and chat-owned books feed the chat; off, excluded and out-of-scope ones do not",
  );
  assert.equal(getInChatLorebookIds(null, lorebooks).size, 0, "no open chat, no dots");
  assert.deepEqual(
    [...getInChatLorebookIds({ id: "c9", characterIds: [], personaId: null, metadata: {} } as never, lorebooks)],
    ["global", "excluded"],
    "object metadata without pins still shows global books",
  );
}

console.log("lorebook-selection-bulk regression passed");
