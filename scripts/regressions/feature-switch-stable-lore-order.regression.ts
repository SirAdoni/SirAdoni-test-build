import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Settings > Features "Stable lore order" (stableLoreOrder, number stableLoreLingerTurns). ON (default) keeps the
// scanned lore entries in an append-only order (stable-lore-order.regression.ts covers that). OFF must be upstream,
// byte for byte: the blocks, depth entries and Outlets come out in entry order with scan order as the tie breaker,
// exactly as the pre-change prompt injector built them, whatever order state the chat still holds, and no
// `stableLoreOrder` state is written. The linger turns come from the Features number; a chat's own metadata
// `stableLoreLingerTurns` wins over it.
const dir = mkdtempSync(join(tmpdir(), "marinara-stable-lore-switch-"));
process.env.DATA_DIR = dir;
process.env.FILE_STORAGE_DIR = join(dir, "storage");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createLorebooksStorage } = await import("../../packages/server/src/services/storage/lorebooks.storage.js");
const { processLorebooks } = await import("../../packages/server/src/services/lorebook/index.js");
const { buildStableLoreOrderRequest, persistLorebookRuntimeState } =
  await import("../../packages/server/src/services/generation/lorebook-generation-runtime.js");
const { resetFeatureSettingsForTests, isFeatureEnabled, getFeatureNumber } =
  await import("../../packages/server/src/services/features/feature-settings.js");
const { normalizeFeatureSettings } = await import("../../packages/shared/src/index.js");
const stable = await import("../../packages/server/src/services/lorebook/stable-lore-order.js");
type LorebookEntry = import("../../packages/shared/src/types/lorebook.js").LorebookEntry;

// The pre-change prompt injector (parent of the stable lore order commit), copied verbatim in behaviour: blocks,
// depth entries and Outlets sorted by entry order; Array.prototype.sort is stable, so scan order breaks ties.
type RefEntry = Pick<LorebookEntry, "content" | "order" | "position" | "depth" | "role" | "outletName">;
function upstreamLore(scanOrder: RefEntry[]) {
  const sorted = [...scanOrder].sort((a, b) => a.order - b.order);
  const before = sorted.filter((entry) => entry.position <= 0).map((entry) => entry.content);
  const after = sorted.filter((entry) => entry.position === 1).map((entry) => entry.content);
  const depthEntries = scanOrder
    .filter((entry) => entry.position === 2 && entry.depth >= 0)
    .map((entry) => ({ content: entry.content, role: entry.role, depth: entry.depth, order: entry.order }))
    .sort((a, b) => (a.depth === b.depth ? a.order - b.order : a.depth - b.depth));
  const outletParts = new Map<string, string[]>();
  for (const entry of sorted) {
    if (entry.position !== 7 || !entry.outletName) continue;
    outletParts.set(entry.outletName, [...(outletParts.get(entry.outletName) ?? []), entry.content]);
  }
  return {
    worldInfoBefore: before.join("\n\n"),
    worldInfoAfter: after.join("\n\n"),
    depthEntries,
    outlets: Object.fromEntries(Array.from(outletParts, ([name, parts]) => [name, parts.join("\n")])),
  };
}

// The prompt text the fixture's lore path produces: preamble, both blocks, depth entries, Outlets, the turn.
const promptText = (lore: ReturnType<typeof upstreamLore>, turn: string): string =>
  [
    "System prompt.",
    `<before>\n${lore.worldInfoBefore}\n</before>`,
    `<after>\n${lore.worldInfoAfter}\n</after>`,
    ...lore.depthEntries.map((entry) => `<depth ${entry.depth} ${entry.role}>${entry.content}</depth>`),
    ...Object.entries(lore.outlets).map(([name, content]) => `<outlet ${name}>${content}</outlet>`),
    turn,
  ].join("\n\n");

const db = await getDB();
const chats = createChatsStorage(db);
const lorebooks = createLorebooksStorage(db);

try {
  // ── Settings: default ON, linger number 2 (0..8), stored like the other Features numbers ──
  resetFeatureSettingsForTests();
  assert.equal(isFeatureEnabled("stableLoreOrder"), true, "ON by default");
  assert.equal(stable.isStableLoreOrderEnabled(), true);
  assert.equal(getFeatureNumber("stableLoreLingerTurns"), 2, "linger defaults to 2");
  assert.deepEqual(normalizeFeatureSettings({ stableLoreOrder: false, stableLoreLingerTurns: 0 }), {
    stableLoreOrder: false,
    stableLoreLingerTurns: 0,
  });
  assert.deepEqual(normalizeFeatureSettings({ stableLoreLingerTurns: 9 }), {}, "above 8 falls back to the default");
  assert.deepEqual(normalizeFeatureSettings({ stableLoreLingerTurns: -1 }), {}, "below 0 falls back to the default");
  resetFeatureSettingsForTests({ stableLoreOrder: false });
  assert.equal(stable.isStableLoreOrderEnabled(), false, "the lore order follows its own switch");
  resetFeatureSettingsForTests({ cacheFriendlyPromptLayout: false });
  assert.equal(stable.isStableLoreOrderEnabled(), true, "the cache-friendly layout switch no longer decides it");

  // ── The number drives linger; a chat's own metadata wins over it ──
  const lingerFor = (meta: Record<string, unknown>) =>
    buildStableLoreOrderRequest({ chatMeta: meta, turnKey: "t", characterIds: [], personaId: null }).lingerTurns;
  resetFeatureSettingsForTests();
  assert.equal(lingerFor({}), 2);
  resetFeatureSettingsForTests({ stableLoreLingerTurns: 0 });
  assert.equal(lingerFor({}), 0, "the Features number sets linger");
  assert.equal(lingerFor({ stableLoreLingerTurns: 3 }), 3, "chat metadata wins over the Features number");
  resetFeatureSettingsForTests({ stableLoreLingerTurns: 5 });
  assert.equal(lingerFor({}), 5);
  assert.equal(lingerFor({ stableLoreLingerTurns: 0 }), 0, "chat metadata 0 wins over a global 5");
  assert.equal(lingerFor({ stableLoreLingerTurns: 99 }), 8, "chat metadata is clamped to 8");
  assert.equal(lingerFor({ stableLoreLingerTurns: "4" }), 5, "a malformed chat value falls back to the number");

  // ── Fixture: two books whose id order disagrees with entry order, ties, every automatic position ──
  const [bookLow, bookHigh] = [
    await lorebooks.create({ name: "Book one" }),
    await lorebooks.create({ name: "Book two" }),
  ]
    .map((book) => {
      assert.ok(book);
      return book;
    })
    .sort((left, right) => (left.id < right.id ? -1 : 1));
  assert.ok(bookLow && bookHigh);
  const specs: Array<{ book: string; key: string; order: number; extra?: Record<string, unknown> }> = [
    { book: bookHigh.id, key: "anvil", order: 1 },
    { book: bookLow.id, key: "bramble", order: 40 },
    { book: bookLow.id, key: "cobble", order: 10 },
    { book: bookHigh.id, key: "dovecote", order: 10 },
    { book: bookLow.id, key: "eyrie", order: 10, extra: { position: 1 } },
    { book: bookHigh.id, key: "fennel", order: 3, extra: { position: 1 } },
    { book: bookHigh.id, key: "gantry", order: 7, extra: { position: 2, depth: 2 } },
    { book: bookLow.id, key: "hollow", order: 7, extra: { position: 2, depth: 2 } },
    { book: bookLow.id, key: "inlet", order: 2, extra: { position: 2, depth: 0, role: "user" } },
    { book: bookHigh.id, key: "juniper", order: 9, extra: { position: 7, outletName: "Notes" } },
    { book: bookLow.id, key: "kestrel", order: 4, extra: { position: 7, outletName: "Notes" } },
  ];
  for (const spec of specs) {
    const created = await lorebooks.createEntry({
      lorebookId: spec.book,
      name: spec.key,
      content: `Lore about the ${spec.key}.`,
      keys: [spec.key],
      order: spec.order,
      ...spec.extra,
    });
    assert.ok(created);
  }
  const stored = new Map<string, LorebookEntry>();
  for (const book of [bookLow, bookHigh]) {
    for (const entry of await lorebooks.listEntries(book.id)) stored.set(entry.id, entry as LorebookEntry);
  }
  const activeLorebookIds = [bookLow.id, bookHigh.id];
  const everything = specs.map((spec) => spec.key).join(" ");
  const turns = [
    everything,
    "dovecote cobble anvil fennel eyrie gantry hollow kestrel juniper inlet",
    "bramble gantry",
    "cobble dovecote juniper",
    "hollow gantry inlet eyrie fennel",
    everything,
  ];

  const runChat = async (label: string, settings: Parameters<typeof resetFeatureSettingsForTests>[0], meta = {}) => {
    resetFeatureSettingsForTests(settings);
    const chat = await chats.create({ name: `Fixture ${label}`, mode: "roleplay", characterIds: [] });
    assert.ok(chat);
    await chats.patchMetadata(chat.id, { activeLorebookIds, ...meta });
    const outputs: Array<{ result: Awaited<ReturnType<typeof processLorebooks>>; prompt: string; turn: string }> = [];
    for (const turn of turns) {
      const message = await chats.createMessage({ chatId: chat.id, role: "user", characterId: null, content: turn });
      assert.ok(message);
      const chatMeta = JSON.parse((await chats.getById(chat.id))!.metadata) as Record<string, unknown>;
      const result = await processLorebooks(db, [{ role: "user", content: turn }], null, {
        chatId: chat.id,
        characterIds: [],
        personaId: null,
        activeLorebookIds,
        stableLoreOrder: buildStableLoreOrderRequest({
          chatMeta,
          turnKey: stable.stableLoreTurnKey([{ id: message.id }]),
          characterIds: [],
          personaId: null,
        }),
      });
      await persistLorebookRuntimeState({
        db,
        chats,
        chatId: chat.id,
        fallbackMeta: chatMeta,
        entryStateOverrides: result.updatedEntryStateOverrides,
        entryTimingStates: result.updatedEntryTimingStates,
        stableLoreOrder: result.stableLoreOrderUpdate,
      });
      outputs.push({ result, prompt: promptText(result, turn), turn });
    }
    return { chat, outputs };
  };

  // ── OFF: byte-identical to the pre-change sort, whatever state the chat holds, and nothing written ──
  const reversed = [...stored.keys()].sort().reverse();
  const staleState = {
    v: 2,
    n: 3,
    scopes: { [stable.stableLoreScopeKey([], null)]: { o: reversed, t: "old", b: { o: reversed }, n: 3 } },
  };
  const off = await runChat("off", { stableLoreOrder: false });
  const offWithState = await runChat("off with state", { stableLoreOrder: false }, { stableLoreOrder: staleState });
  for (const [index, { result, prompt, turn }] of off.outputs.entries()) {
    const label = `OFF turn ${index + 1}`;
    assert.equal(result.stableOrder, undefined, `${label}: not marked stable`);
    assert.equal(result.stableLoreOrderUpdate, undefined, `${label}: no state to persist`);
    const scanOrder = result.activatedEntries.map((activation) => {
      const entry = stored.get(activation.id);
      assert.ok(entry, `${label}: stored entry ${activation.id}`);
      return { ...entry, content: activation.content };
    });
    assert.ok(scanOrder.length > 0, `${label}: the fixture activates entries`);
    const expected = upstreamLore(scanOrder);
    assert.equal(result.worldInfoBefore, expected.worldInfoBefore, `${label}: before block`);
    assert.equal(result.worldInfoAfter, expected.worldInfoAfter, `${label}: after block`);
    assert.deepEqual(result.depthEntries, expected.depthEntries, `${label}: depth entries`);
    assert.deepEqual(result.outlets, expected.outlets, `${label}: Outlets`);
    assert.equal(prompt, promptText(expected, turn), `${label}: prompt text byte-identical`);
    const withState = offWithState.outputs[index]!.result;
    assert.deepEqual(
      { ...withState, updatedEntryTimingStates: undefined, updatedEntryStateOverrides: undefined },
      { ...result, updatedEntryTimingStates: undefined, updatedEntryStateOverrides: undefined },
      `${label}: stored order state is ignored`,
    );
    assert.equal(offWithState.outputs[index]!.prompt, prompt, `${label}: same prompt with stale state`);
  }
  const offMeta = JSON.parse((await chats.getById(off.chat.id))!.metadata);
  assert.equal(offMeta.stableLoreOrder, undefined, "OFF: no stableLoreOrder state written");
  const offStateMeta = JSON.parse((await chats.getById(offWithState.chat.id))!.metadata);
  assert.deepEqual(offStateMeta.stableLoreOrder, staleState, "OFF: existing state is left untouched");

  // ── ON: the fixture is sensitive (the order differs) and state is written ──
  const on = await runChat("on", {});
  assert.notEqual(
    on.outputs[0]!.result.worldInfoBefore,
    off.outputs[0]!.result.worldInfoBefore,
    "ON orders the first block by the stable key (lorebook id first), unlike OFF",
  );
  assert.equal(on.outputs[0]!.result.stableOrder, true);
  assert.ok(JSON.parse((await chats.getById(on.chat.id))!.metadata).stableLoreOrder, "ON: state written");

  // ── The Features number drives linger end to end ──
  const lingering = (run: Awaited<ReturnType<typeof runChat>>) =>
    run.outputs[2]!.result.activatedEntries.some((activation) => activation.name === "cobble");
  assert.equal(lingering(await runChat("linger 2", {})), true, "linger 2: a dropped keyword entry lingers");
  assert.equal(lingering(await runChat("linger 0", { stableLoreLingerTurns: 0 })), false, "linger 0: dropped at once");
  assert.equal(
    lingering(await runChat("chat wins", { stableLoreLingerTurns: 0 }, { stableLoreLingerTurns: 2 })),
    true,
    "chat metadata linger wins over the Features number",
  );
  assert.equal(
    lingering(await runChat("off never lingers", { stableLoreOrder: false, stableLoreLingerTurns: 8 })),
    false,
    "OFF: no linger whatever the number",
  );
} finally {
  resetFeatureSettingsForTests();
  await closeDB();
  rmSync(dir, { recursive: true, force: true });
}

console.log("feature-switch-stable-lore-order regression passed");
