import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Settings > Features "Cache-friendly prompt layout" (cacheFriendlyPromptLayout): stable lore order for selectively
// activated lorebook entries. On: the first order is lorebook id, entry order, position, id; later turns keep the
// entries sent last turn in place, append new ones at the end and let dropped ones linger (chat metadata
// `stableLoreLingerTurns`, default 2) while they pass every non-keyword gate and the budget has room. An entry whose
// linger ran out is held until a turn whose order changes anyway. The state is per chat and scope in
// `stableLoreOrder`, keyed by the turn, so a regenerate of the same turn sends the same order, and a branch drops it.
// Off: entry order with scan order as the tie breaker, as upstream.
//
// The fixture chat scans only the current player message, so keywords flicker in and out from turn to turn. Each
// turn is laid out as preamble, lore block, history, current message, and compared with the previous turn's prompt:
// shared prefix and rewritten characters (length minus shared prefix), switch off vs on.
const dir = mkdtempSync(join(tmpdir(), "marinara-stable-lore-"));
process.env.DATA_DIR = dir;
process.env.FILE_STORAGE_DIR = join(dir, "storage");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { chatsRoutes } = await import("../../packages/server/src/routes/chats.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createLorebooksStorage } = await import("../../packages/server/src/services/storage/lorebooks.storage.js");
const { processLorebooks } = await import("../../packages/server/src/services/lorebook/index.js");
const { processActivatedEntries } = await import("../../packages/server/src/services/lorebook/prompt-injector.js");
const { buildStableLoreOrderRequest, persistLorebookRuntimeState } =
  await import("../../packages/server/src/services/generation/lorebook-generation-runtime.js");
const { splitGameLorePrompt } = await import("../../packages/server/src/services/generation/game-lore-prompt.js");
const { resetFeatureSettingsForTests } =
  await import("../../packages/server/src/services/features/feature-settings.js");
const stable = await import("../../packages/server/src/services/lorebook/stable-lore-order.js");
const { AnthropicProvider, resolveStableLoreSystemBreakpoint } =
  await import("../../packages/server/src/services/llm/providers/anthropic.provider.js");
type ChatMessage = import("../../packages/server/src/services/llm/base-provider.js").ChatMessage;
type ActivatedEntry = import("../../packages/server/src/services/lorebook/keyword-scanner.js").ActivatedEntry;
type LorebookEntry = import("../../packages/shared/src/types/lorebook.js").LorebookEntry;

const filler = (label: string, size: number): string => {
  const words = ["amber", "lantern", "quay", "rope", "brine", "gull", "ledger", "tide", "anchor", "cinder"];
  let text = `${label}:`;
  for (let index = 0; text.length < size; index += 1) text += ` ${words[(index * 7 + label.length) % words.length]}`;
  return text.slice(0, size);
};

const db = await getDB();
const chats = createChatsStorage(db);
const lorebooks = createLorebooksStorage(db);
const app = Fastify();
app.decorate("db", db);
await app.register(chatsRoutes, { prefix: "/api/chats" });

try {
  // ── Pure ordering ──
  const fake = (id: string, lorebookId: string, order: number, extra: Partial<LorebookEntry> = {}): ActivatedEntry => ({
    entry: {
      id,
      lorebookId,
      order,
      position: 0,
      depth: 4,
      role: "system",
      content: `<${id}>`,
      ...extra,
    } as LorebookEntry,
    matchedKeys: [id],
    activationSources: ["keyword"],
    injectionOrder: order,
  });
  const ids = (list: ActivatedEntry[]) => list.map((activation) => activation.entry.id);
  const first = stable.orderActivatedEntriesStably({
    selected: [fake("e3", "book-b", 1), fake("e2", "book-a", 20), fake("e1", "book-a", 20), fake("e0", "book-a", 5)],
    prior: { o: [] },
    lingerTurns: 2,
  });
  assert.deepEqual(ids(first.ordered), ["e0", "e1", "e2", "e3"], "first order: book, then order, then id");
  const second = stable.orderActivatedEntriesStably({
    selected: [fake("e9", "book-a", 1), fake("e3", "book-b", 1), fake("e0", "book-a", 5)],
    prior: first.snapshot,
    lingerTurns: 2,
    lingerEntry: (id) => (id === "e1" ? fake("e1", "book-a", 20) : null),
  });
  assert.deepEqual(ids(second.ordered), ["e0", "e1", "e3", "e9"], "kept in place, e1 lingers, e2 dropped, e9 appended");
  assert.deepEqual(second.snapshot, { o: ["e0", "e1", "e3", "e9"], l: { e1: 1 } });
  const third = stable.orderActivatedEntriesStably({
    selected: [fake("e0", "book-a", 5)],
    prior: second.snapshot,
    lingerTurns: 2,
    lingerEntry: (id) => fake(id, "book-a", 50),
  });
  assert.deepEqual(third.snapshot.l, { e1: 0, e3: 1, e9: 1 }, "an entry lingers at most lingerTurns turns");
  const fourth = stable.orderActivatedEntriesStably({
    selected: [fake("e0", "book-a", 5)],
    prior: third.snapshot,
    lingerTurns: 2,
    lingerEntry: (id) => fake(id, "book-a", 50),
  });
  assert.deepEqual(ids(fourth.ordered), ["e0", "e1", "e3", "e9"], "e1 ran out but is held: nothing else changed");
  assert.deepEqual(fourth.held, ["e1"]);
  assert.deepEqual(fourth.snapshot.l, { e1: -1, e3: 0, e9: 0 });
  const fifth = stable.orderActivatedEntriesStably({
    selected: [fake("e0", "book-a", 5), fake("e5", "book-a", 1)],
    prior: fourth.snapshot,
    lingerTurns: 2,
    lingerEntry: (id) => fake(id, "book-a", 50),
  });
  assert.deepEqual(ids(fifth.ordered), ["e0", "e5"], "held entries go on a turn whose order changes anyway");
  const oneFails = stable.orderActivatedEntriesStably({
    selected: [fake("e0", "book-a", 5)],
    prior: fourth.snapshot,
    lingerTurns: 2,
    lingerEntry: (id) => (id === "e3" ? null : fake(id, "book-a", 50)),
  });
  assert.deepEqual(ids(oneFails.ordered), ["e0"], "one held entry failing its gate changes the block, so all go");
  const capped = stable.orderActivatedEntriesStably({
    selected: [fake("e0", "book-a", 5)],
    prior: { o: ["e0", "e1"], l: { e1: -stable.MAX_STABLE_LORE_HELD_TURNS } },
    lingerTurns: 2,
    lingerEntry: (id) => fake(id, "book-a", 50),
  });
  assert.deepEqual(ids(capped.ordered), ["e0"], "an entry is held at most MAX_STABLE_LORE_HELD_TURNS turns");
  // Entries a location, constant, decision or timing alone brought in are listed as not lingering.
  const located = stable.orderActivatedEntriesStably({
    selected: [
      { ...fake("loc", "book-a", 1), activationSources: ["current_location"] },
      { ...fake("both", "book-a", 2), activationSources: ["keyword", "current_location"] },
      { ...fake("timed", "book-a", 3), activationSources: ["sticky"], sticky: true },
      fake("kw", "book-a", 4),
    ],
    prior: { o: [] },
    lingerTurns: 2,
  });
  assert.deepEqual(located.snapshot.x, ["loc", "both", "timed"]);
  const travelled = stable.orderActivatedEntriesStably({
    selected: [],
    prior: located.snapshot,
    lingerTurns: 2,
    lingerEntry: (id) => fake(id, "book-a", 50),
  });
  assert.deepEqual(ids(travelled.ordered), ["kw"], "only the keyword match lingers");
  const noLinger = stable.orderActivatedEntriesStably({
    selected: [fake("e0", "book-a", 5)],
    prior: first.snapshot,
    lingerTurns: 0,
    lingerEntry: (id) => fake(id, "book-a", 50),
  });
  assert.deepEqual(ids(noLinger.ordered), ["e0"], "linger 0 removes dropped entries at once");

  // Regenerate or swipe of the same turn starts from the same order; a new turn starts from what was sent.
  let metadata = stable.nextStableLoreOrderMetadata(undefined, {
    scopeKey: "scope",
    turnKey: "msg-1",
    prior: { o: ["e0"] },
    snapshot: { o: ["e0", "e1"] },
  });
  assert.deepEqual(stable.priorStableLoreOrder(metadata, "scope", "msg-1"), { o: ["e0"] });
  assert.deepEqual(stable.priorStableLoreOrder(metadata, "scope", "msg-2"), { o: ["e0", "e1"] });
  assert.deepEqual(stable.priorStableLoreOrder(metadata, "other", "msg-2"), { o: [] });
  assert.deepEqual(stable.priorStableLoreOrder({ v: 2 }, "scope", "msg-2"), { o: [] }, "unknown shape reads as none");
  assert.deepEqual(
    stable.priorStableLoreOrder(
      { v: 1, n: 1, scopes: { scope: { t: "m", b: { o: [] }, o: ["e0"], n: 1 } } },
      "scope",
      "x",
    ),
    { o: [] },
    "state from another version reads as none",
  );
  for (let index = 0; index < 12; index += 1) {
    metadata = stable.nextStableLoreOrderMetadata(metadata, {
      scopeKey: `scope-${index}`,
      turnKey: "msg-3",
      prior: { o: [] },
      snapshot: { o: [`x${index}`] },
    });
  }
  assert.equal(Object.keys(metadata.scopes).length, 8, "at most 8 scopes per chat");
  assert.ok(metadata.scopes["scope-11"] && !metadata.scopes.scope, "the least recently written scope goes first");
  assert.equal(stable.stableLoreTurnKey([{ id: "a" }, { id: "b" }, {}]), "b");
  assert.equal(stable.stableLoreTurnKey([]), stable.STABLE_LORE_FIRST_TURN_KEY);
  assert.equal(stable.stableLoreScopeKey(["c2", "c1", "c2"], "p"), "c1,c2|p");
  assert.equal(stable.resolveStableLoreLingerTurns({}), 2);
  assert.equal(stable.resolveStableLoreLingerTurns({ stableLoreLingerTurns: 0 }), 0);
  assert.equal(stable.resolveStableLoreLingerTurns({ stableLoreLingerTurns: 99 }), 8);

  // Explicit depth wins over the stable order; the stable order only decides the order inside one depth.
  const depthProcessed = processActivatedEntries(
    [
      fake("d-late", "book-a", 1, { position: 2, depth: 1 }),
      fake("d-deep", "book-a", 2, { position: 2, depth: 4 }),
      fake("d-early", "book-a", 0, { position: 2, depth: 1 }),
    ],
    0,
    { preserveOrder: true },
  );
  assert.deepEqual(
    depthProcessed.depthEntries.map((entry) => [entry.content, entry.depth]),
    [
      ["<d-late>", 1],
      ["<d-early>", 1],
      ["<d-deep>", 4],
    ],
  );
  const depthUpstream = processActivatedEntries(
    [fake("d-late", "book-a", 1, { position: 2, depth: 1 }), fake("d-early", "book-a", 0, { position: 2, depth: 1 })],
    0,
  );
  assert.deepEqual(
    depthUpstream.depthEntries.map((entry) => entry.content),
    ["<d-early>", "<d-late>"],
    "without the stable order, entry order decides",
  );

  // Game fallback split keeps the scan's stable order instead of re-sorting by entry order.
  const stored = new Map([
    ["g1", { content: "late", alwaysLoaded: false, order: 9, position: 0 as const }],
    ["g2", { content: "early", alwaysLoaded: false, order: 1, position: 0 as const }],
  ]);
  const gameScan = {
    worldInfoBefore: "",
    worldInfoAfter: "",
    activatedEntries: [
      { id: "g1", content: "late", matchedKeys: [], activationSources: [], matchType: "keyword" as const },
      { id: "g2", content: "early", matchedKeys: [], activationSources: [], matchType: "keyword" as const },
    ],
  };
  assert.equal(splitGameLorePrompt({ ...gameScan, stableOrder: true }, stored).runtime, "late\n\nearly");
  assert.equal(splitGameLorePrompt(gameScan, stored).runtime, "early\n\nlate");

  // Anthropic: one more cache marker just before a separate stable lore block (3 of the 4 allowed).
  const marked = { providerMetadata: { marinaraStableLoreBlock: true } };
  assert.equal(resolveStableLoreSystemBreakpoint([{}, {}, marked]), 1);
  assert.equal(resolveStableLoreSystemBreakpoint([{}, marked, {}]), 0);
  assert.equal(resolveStableLoreSystemBreakpoint([marked, {}]), -1, "nothing before the block");
  assert.equal(resolveStableLoreSystemBreakpoint([{}, {}]), -1, "no stable lore block");
  assert.deepEqual(stable.stableLoreBlockMetadata({ stableOrder: true }), marked);
  assert.deepEqual(stable.stableLoreBlockMetadata({}), {});

  // The built Anthropic request: a local stub server records the body (no network, no paid call).
  const anthropicBodies: Array<Record<string, any>> = [];
  const stub = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    anthropicBodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        content: [{ type: "text", text: "Done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  try {
    const address = stub.address();
    assert.ok(address && typeof address === "object");
    const provider = new AnthropicProvider(`http://127.0.0.1:${address.port}/anthropic`, "test");
    const conversation = (withMarker: boolean): ChatMessage[] => [
      { role: "system", content: "Preamble and character" },
      { role: "system", content: "<lore>entries</lore>", ...(withMarker ? marked : {}) },
      { role: "system", content: "Author note" },
      { role: "user", content: "Earlier user" },
      { role: "assistant", content: "Earlier reply" },
      { role: "user", content: "Latest user" },
    ];
    const markers = (body: Record<string, any>) => JSON.stringify(body).split('"cache_control"').length - 1;
    // chatComplete builds its own body only for tool rounds; without tools it goes through chat().
    const tools = [
      {
        type: "function" as const,
        function: { name: "probe", description: "Probe", parameters: { type: "object", properties: {} } },
      },
    ];
    for (const path of ["tools", "chat"] as const) {
      for (const withMarker of [true, false]) {
        const options = { model: "claude-sonnet-4-20250514", stream: false, enableCaching: true };
        if (path === "tools") await provider.chatComplete(conversation(withMarker), { ...options, tools });
        else for await (const _ of provider.chat(conversation(withMarker), options));
        const body = anthropicBodies.at(-1)!;
        assert.ok(Array.isArray(body.system) && body.system.length === 3, `${path}: system blocks`);
        assert.equal(Boolean(body.system[0].cache_control), withMarker, `${path}: marker before the lore block`);
        assert.equal(body.system[1].cache_control, undefined, `${path}: none on the lore block itself`);
        assert.ok(body.system[2].cache_control, `${path}: system end keeps its marker`);
        assert.ok(markers(body) <= 4, `${path}: at most 4 cache markers`);
        assert.equal(markers(body), withMarker ? 3 : 2, `${path}: the lore marker is the third`);
      }
    }
    await provider.chatComplete(conversation(true), { model: "claude-sonnet-4-20250514", stream: false });
    assert.equal(markers(anthropicBodies.at(-1)!), 0, "no marker when caching is off");
  } finally {
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }

  // ── Fixture chat with flickering keywords, through processLorebooks and chat metadata ──
  // The first order sorts by lorebook id, and ids are random; give the lower id the "harbour" role so the
  // measured numbers are the same on every run.
  const [harbour, marsh] = [await lorebooks.create({ name: "Lore one" }), await lorebooks.create({ name: "Lore two" })]
    .map((book) => {
      assert.ok(book);
      return book;
    })
    .sort((left, right) => (left.id < right.id ? -1 : 1));
  assert.ok(harbour && marsh);
  const specs = [
    { book: harbour.id, key: "harbourmaster", order: 5 },
    { book: harbour.id, key: "ferry", order: 10 },
    { book: harbour.id, key: "lighthouse", order: 20 },
    { book: harbour.id, key: "market", order: 30 },
    { book: marsh.id, key: "tollgate", order: 5 },
    { book: marsh.id, key: "reedbed", order: 15 },
    { book: marsh.id, key: "cinderworks", order: 25 },
  ];
  for (const spec of specs) {
    await lorebooks.createEntry({
      lorebookId: spec.book,
      name: spec.key,
      content: filler(`lore ${spec.key}`, 700),
      keys: [spec.key],
      order: spec.order,
    });
  }
  const depthEntry = await lorebooks.createEntry({
    lorebookId: harbour.id,
    name: "quay depth",
    content: "The quay floods at high tide.",
    keys: ["quay"],
    order: 1,
    position: 2,
    depth: 3,
  });
  assert.ok(depthEntry);
  const activeLorebookIds = [harbour.id, marsh.id];
  const turns = [
    "ferry lighthouse",
    "ferry market",
    "lighthouse ferry tollgate",
    "ferry",
    "market reedbed quay",
    "ferry market",
    "harbourmaster ferry",
    "market",
    "ferry market reedbed",
    "cinderworks ferry quay",
    "market ferry",
    "ferry market",
  ];
  const preamble = filler("system prompt and character", 4000);

  const runChat = async (label: string, switchOn: boolean, meta: Record<string, unknown> = {}) => {
    resetFeatureSettingsForTests(switchOn ? {} : { cacheFriendlyPromptLayout: false });
    const chat = await chats.create({ name: `Fixture ${label}`, mode: "roleplay", characterIds: [] });
    assert.ok(chat);
    await chats.patchMetadata(chat.id, { activeLorebookIds, ...meta });
    const prompts: string[] = [];
    const orders: string[][] = [];
    const names: string[][] = [];
    const history: string[] = [];
    let previousMessageId = "";
    for (const [index, text] of turns.entries()) {
      const message = await chats.createMessage({ chatId: chat.id, role: "user", characterId: null, content: text });
      assert.ok(message);
      previousMessageId = message.id;
      const chatMeta = JSON.parse((await chats.getById(chat.id))!.metadata) as Record<string, unknown>;
      const result = await processLorebooks(db, [{ role: "user", content: text }], null, {
        chatId: chat.id,
        characterIds: [],
        personaId: null,
        activeLorebookIds,
        stableLoreOrder: buildStableLoreOrderRequest({
          chatMeta,
          turnKey: stable.stableLoreTurnKey([{ id: previousMessageId }]),
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
      orders.push(result.activatedEntryIds);
      names.push(result.activatedEntries.map((entry) => entry.name ?? ""));
      prompts.push([preamble, `<lore>\n${result.worldInfoBefore}\n</lore>`, ...history, text].join("\n\n"));
      history.push(text, filler(`narrator ${index}`, 1500));
      const reply = await chats.createMessage({
        chatId: chat.id,
        role: "assistant",
        characterId: null,
        content: history.at(-1)!,
      });
      assert.ok(reply);
      if (index === 4) {
        // Depth entries keep their explicit depth under the stable order.
        assert.deepEqual(
          result.depthEntries.map((entry) => entry.depth),
          [3],
        );
      }
    }
    const shared = (left: string, right: string) => {
      let index = 0;
      while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
      return index;
    };
    let sharedTotal = 0;
    let rewrittenTotal = 0;
    // Turns whose whole lore block (and so the history behind it) is still shared with the previous turn.
    let loreUnchangedTurns = 0;
    const perTurn: number[] = [];
    for (let index = 1; index < prompts.length; index += 1) {
      const common = shared(prompts[index - 1]!, prompts[index]!);
      sharedTotal += common;
      rewrittenTotal += prompts[index]!.length - common;
      perTurn.push(prompts[index]!.length - common);
      if (common > prompts[index - 1]!.indexOf("</lore>")) loreUnchangedTurns += 1;
    }
    const promptTotal = prompts.slice(1).reduce((sum, prompt) => sum + prompt.length, 0);
    return {
      chat,
      orders,
      names,
      prompts,
      sharedTotal,
      rewrittenTotal,
      perTurn,
      promptTotal,
      loreUnchangedTurns,
      turns: prompts.length - 1,
    };
  };

  const before = await runChat("before", false);
  const stickyOnly = await runChat("sticky", true, { stableLoreLingerTurns: 0 });
  const after = await runChat("after", true);

  // Off keeps the upstream order and writes no state.
  const beforeMeta = JSON.parse((await chats.getById(before.chat.id))!.metadata);
  assert.equal(beforeMeta.stableLoreOrder, undefined, "switch off: no state in chat metadata");
  const specOrder = new Map(specs.map((spec) => [spec.key, spec.order]));
  for (const turnNames of before.names) {
    const entryOrders = turnNames.filter((name) => specOrder.has(name)).map((name) => specOrder.get(name)!);
    assert.deepEqual(
      entryOrders,
      [...entryOrders].sort((a, b) => a - b),
      "switch off: sorted by entry order",
    );
  }

  // On: every turn keeps the previous turn's entries in the same relative order and appends new ones at the end.
  for (const run of [stickyOnly, after]) {
    for (let index = 1; index < run.orders.length; index += 1) {
      const previous = run.orders[index - 1]!;
      const current = run.orders[index]!;
      const kept = current.filter((id) => previous.includes(id));
      assert.deepEqual(
        kept,
        previous.filter((id) => current.includes(id)),
        `turn ${index}: kept order unchanged`,
      );
      assert.deepEqual(current.slice(0, kept.length), kept, `turn ${index}: new entries only at the end`);
    }
  }
  const afterMeta = JSON.parse((await chats.getById(after.chat.id))!.metadata);
  const scope = stable.readStableLoreOrderMetadata(afterMeta.stableLoreOrder)!.scopes[
    stable.stableLoreScopeKey([], null)
  ];
  assert.ok(scope, "state stored per chat and scope");
  assert.deepEqual(scope.o, after.orders.at(-1), "state holds the order sent");
  assert.ok(JSON.stringify(afterMeta.stableLoreOrder).length < 1000, "state stays small (ids and counters)");

  assert.ok(after.sharedTotal > before.sharedTotal, "stable order shares more prefix");
  assert.ok(after.rewrittenTotal < before.rewrittenTotal, "stable order rewrites fewer characters");
  assert.ok(stickyOnly.rewrittenTotal <= before.rewrittenTotal, "sticky order alone never rewrites more");
  assert.equal(stickyOnly.promptTotal, before.promptTotal, "linger 0 sends the same amount of lore");
  // A turn is judged on its own too: an entry leaving an otherwise unchanged block would resend the whole history.
  assert.ok(Math.max(...after.perTurn) <= Math.max(...before.perTurn), "linger never makes the worst turn worse");
  const oneEntry = 720;
  after.perTurn.forEach((chars, index) => {
    assert.ok(
      chars <= before.perTurn[index]! + oneEntry,
      `turn ${index + 1}: linger rewrites at most one lore entry more than the switch off (${chars} vs ${before.perTurn[index]})`,
    );
  });

  // Regenerate of the last turn: same turn key, same starting order, same lore block, even after another write.
  resetFeatureSettingsForTests();
  const regenerate = async (text: string) => {
    const chatMeta = JSON.parse((await chats.getById(after.chat.id))!.metadata) as Record<string, unknown>;
    const messages = await chats.listMessages(after.chat.id);
    const turnKey = stable.stableLoreTurnKey(messages.filter((message) => message.role === "user").slice(-1));
    const result = await processLorebooks(db, [{ role: "user", content: text }], null, {
      chatId: after.chat.id,
      characterIds: [],
      personaId: null,
      activeLorebookIds,
      stableLoreOrder: buildStableLoreOrderRequest({ chatMeta, turnKey, characterIds: [], personaId: null }),
    });
    await persistLorebookRuntimeState({
      db,
      chats,
      chatId: after.chat.id,
      fallbackMeta: chatMeta,
      stableLoreOrder: result.stableLoreOrderUpdate,
    });
    return result;
  };
  const swipeA = await regenerate(turns.at(-1)!);
  const swipeB = await regenerate(turns.at(-1)!);
  assert.deepEqual(swipeA.activatedEntryIds, after.orders.at(-1), "regenerate sends the order the turn sent");
  assert.equal(swipeB.worldInfoBefore, swipeA.worldInfoBefore, "a second swipe sends the same block");

  // Linger only while the budget has room: a budget of one entry leaves no room for the entry that dropped out.
  const budgetChat = await chats.create({ name: "Fixture budget", mode: "roleplay", characterIds: [] });
  assert.ok(budgetChat);
  const budgetTurn = async (text: string, key: string) => {
    const chatMeta = JSON.parse((await chats.getById(budgetChat.id))!.metadata) as Record<string, unknown>;
    const result = await processLorebooks(db, [{ role: "user", content: text }], null, {
      chatId: budgetChat.id,
      characterIds: [],
      personaId: null,
      activeLorebookIds,
      tokenBudget: 200,
      stableLoreOrder: buildStableLoreOrderRequest({ chatMeta, turnKey: key, characterIds: [], personaId: null }),
    });
    await persistLorebookRuntimeState({
      db,
      chats,
      chatId: budgetChat.id,
      fallbackMeta: chatMeta,
      stableLoreOrder: result.stableLoreOrderUpdate,
    });
    return result;
  };
  await budgetTurn("ferry", "b1");
  const tight = await budgetTurn("market", "b2");
  assert.equal(tight.activatedEntryIds.length, 1, "no linger past the lore token budget");
  const roomy = await processLorebooks(db, [{ role: "user", content: "market" }], null, {
    chatId: budgetChat.id,
    characterIds: [],
    personaId: null,
    activeLorebookIds,
    stableLoreOrder: {
      state: { v: 2, n: 1, scopes: { s: { t: "x", b: { o: [] }, o: tight.activatedEntryIds.concat(), n: 1 } } },
      turnKey: "y",
      scopeKey: "s",
      lingerTurns: 2,
    },
  });
  assert.equal(roomy.activatedEntryIds.length, 1, "the same entry, still active, is not duplicated");

  // Linger re-runs every non-keyword gate against this turn's game state, and never keeps location or
  // limited-use entries.
  const gateBook = await lorebooks.create({ name: "Gate lore" });
  assert.ok(gateBook);
  const gateEntry = async (name: string, extra: Record<string, unknown>) => {
    const entry = await lorebooks.createEntry({
      lorebookId: gateBook.id,
      name,
      content: `About the ${name}.`,
      ...extra,
    });
    assert.ok(entry);
    return entry.id;
  };
  const gate = {
    plain: await gateEntry("gullcry", { keys: ["gullcry"], order: 1 }),
    night: await gateEntry("lantern", {
      keys: ["lantern"],
      order: 2,
      schedule: { activeTimes: ["night"], activeDates: [], activeLocations: [] },
    }),
    placed: await gateEntry("bellrope", {
      keys: ["bellrope"],
      order: 3,
      schedule: { activeTimes: [], activeDates: [], activeLocations: ["Quay Row"] },
    }),
    condition: await gateEntry("tidegate", {
      keys: ["tidegate"],
      order: 4,
      activationConditions: [{ field: "location", operator: "equals", value: "Quay Row" }],
    }),
    limited: await gateEntry("driftwood", { keys: ["driftwood"], order: 5, ephemeral: 3 }),
    location: await gateEntry("row houses", { keys: [], order: 6 }),
  };
  const gateLorebookIds = [gateBook.id];
  const gateTurn = async (
    chatId: string,
    text: string,
    turnKey: string,
    gameState: Record<string, unknown>,
    forcedEntryIds: string[] = [],
  ) => {
    const chatMeta = JSON.parse((await chats.getById(chatId))!.metadata) as Record<string, unknown>;
    const result = await processLorebooks(db, [{ role: "user", content: text }], gameState, {
      chatId,
      characterIds: [],
      personaId: null,
      activeLorebookIds: gateLorebookIds,
      forcedEntryIds,
      entryStateOverrides: chatMeta.entryStateOverrides as Record<string, { ephemeral?: number | null }> | undefined,
      entryTimingStates: chatMeta.entryTimingStates as never,
      stableLoreOrder: buildStableLoreOrderRequest({ chatMeta, turnKey, characterIds: [], personaId: null }),
    });
    await persistLorebookRuntimeState({
      db,
      chats,
      chatId,
      fallbackMeta: chatMeta,
      entryStateOverrides: result.updatedEntryStateOverrides,
      entryTimingStates: result.updatedEntryTimingStates,
      stableLoreOrder: result.stableLoreOrderUpdate,
    });
    return result;
  };
  const nightOnTheRow = { time: "night", location: "Quay Row" };
  const allKeys = "gullcry lantern bellrope tidegate driftwood";
  for (const [label, nextState, expected] of [
    // The party travels at dawn: the scan drops the night, place and condition entries, and so must linger.
    ["travelled", { time: "dawn", location: "Mill Lane" }, [gate.plain]],
    // Nothing moved: the same entries still pass their gates and linger; location and limited-use ones never do.
    ["stayed", nightOnTheRow, [gate.plain, gate.night, gate.placed, gate.condition]],
  ] as const) {
    const gateChat = await chats.create({ name: `Gate ${label}`, mode: "roleplay", characterIds: [] });
    assert.ok(gateChat);
    await chats.patchMetadata(gateChat.id, { activeLorebookIds: gateLorebookIds });
    const firstTurn = await gateTurn(gateChat.id, allKeys, "g1", nightOnTheRow, [gate.location]);
    assert.deepEqual(
      [...firstTurn.activatedEntryIds].sort(),
      Object.values(gate).sort(),
      `${label}: every gate entry active on the first turn`,
    );
    const quiet = await gateTurn(gateChat.id, "the crew rests", "g2", { ...nextState });
    assert.deepEqual(quiet.activatedEntryIds, expected, `${label}: lingering entries`);
    const overrides = JSON.parse((await chats.getById(gateChat.id))!.metadata).entryStateOverrides;
    assert.equal(overrides?.[gate.limited]?.ephemeral, 2, `${label}: the limited-use entry counted one real use`);
  }

  // A branch starts without the source chat's order.
  const branched = await app.inject({ method: "POST", url: `/api/chats/${after.chat.id}/branch`, payload: {} });
  assert.equal(branched.statusCode, 200, branched.body);
  const branchId = (JSON.parse(branched.body) as { id: string }).id;
  const branchMeta = JSON.parse((await chats.getById(branchId))!.metadata);
  assert.equal(branchMeta.stableLoreOrder, undefined, "branch drops stableLoreOrder");
  assert.deepEqual(branchMeta.activeLorebookIds, activeLorebookIds, "branch keeps the rest of the metadata");

  const report = (name: string, run: typeof before) =>
    `${name}: shared prefix ${run.sharedTotal} chars, rewritten ${run.rewrittenTotal} chars, ` +
    `lore block unchanged on ${run.loreUnchangedTurns} of ${run.turns} turns, prompt total ${run.promptTotal} chars, ` +
    `worst turn ${Math.max(...run.perTurn)}, per turn [${run.perTurn.join(",")}]`;
  console.log(report("switch off (entry order)", before));
  console.log(report("stable order, linger 0", stickyOnly));
  console.log(report("stable order, linger 2", after));
  console.log(
    `saved ${before.rewrittenTotal - after.rewrittenTotal} rewritten chars (${(
      (100 * (before.rewrittenTotal - after.rewrittenTotal)) /
      before.rewrittenTotal
    ).toFixed(1)}%)`,
  );
  console.log("stable-lore-order regression passed");
} finally {
  resetFeatureSettingsForTests();
  await app.close();
  await closeDB();
  rmSync(dir, { recursive: true, force: true });
}
