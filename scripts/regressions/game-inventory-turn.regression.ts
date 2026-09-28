/**
 * The Game Master's `[inventory:]` tags through a real turn: the generate route applies them when it
 * saves the reply, rewrites each one with what happened, saves the stacks and the journal, and tells
 * the client the chat's inventory changed. Nothing in the browser applies them any more, so a reply
 * that finished while nobody was reading it still changes the inventory.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatMessage, ChatOptions, LLMUsage } from "../../packages/server/src/services/llm/base-provider.js";

const dir = mkdtempSync(join(tmpdir(), "marinara-inventory-turn-"));
process.env.DATA_DIR = dir;
process.env.FILE_STORAGE_DIR = join(dir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { generateRoutes } = await import("../../packages/server/src/routes/generate.routes.js");
const { chatsRoutes } = await import("../../packages/server/src/routes/chats.routes.js");
const { createGameStateStorage } = await import("../../packages/server/src/services/storage/game-state.storage.js");
const { gameInventoryRoutes } = await import("../../packages/server/src/routes/game-inventory.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");
const { createGameRulesetsStorage } =
  await import("../../packages/server/src/services/storage/game-rulesets.storage.js");
const {
  normalizeGameInventoryStacks,
  gameInventoryCount,
  readResolvedInventoryTags,
  CHAT_PRESET_EXCLUDED_METADATA_KEYS,
} = await import("../../packages/shared/src/index.js");
const { ClaudeSubscriptionProvider } =
  await import("../../packages/server/src/services/llm/providers/claude-subscription.provider.js");

const prompts: ChatMessage[][] = [];
let reply = "";
async function* scriptedChat(messages: ChatMessage[], _options: ChatOptions): AsyncGenerator<string, LLMUsage> {
  prompts.push(structuredClone(messages));
  yield reply;
  return { promptTokens: 10, completionTokens: 5, totalTokens: 15, finishReason: "stop" };
}
const originalChat = ClaudeSubscriptionProvider.prototype.chat;
ClaudeSubscriptionProvider.prototype.chat = scriptedChat;

const db = await getDB();
const chats = createChatsStorage(db);
const app = Fastify();
app.decorate("db", db);
await app.register(generateRoutes, { prefix: "/api/generate" });
await app.register(chatsRoutes, { prefix: "/api/chats" });
await app.register(gameInventoryRoutes, { prefix: "/api/game/inventory" });
await app.register(gameRoutes, { prefix: "/api/game" });
try {
  const connection = await createConnectionsStorage(db).create({
    name: "Inventory fixture",
    provider: "claude_subscription",
    model: "fixture",
    apiKey: "synthetic-fixture",
    maxContext: 32768,
  });
  const chat = await chats.create({
    name: "Inventory turn",
    mode: "game",
    characterIds: [],
    connectionId: connection.id,
    promptPresetId: null,
  });
  assert.ok(chat);
  await chats.patchMetadata(chat.id, {
    enableAgents: false,
    enableTools: false,
    // Bram left the party but still carries the arrows, so the Game Master can still name him.
    gameInventory: [
      { id: "st-rope", name: "Rope", quantity: 1 },
      { id: "st-arrows", name: "Arrow", quantity: 10, holder: "Bram" },
    ],
  });
  const readInventory = async () => {
    const row = await chats.getById(chat.id);
    const meta = typeof row!.metadata === "string" ? JSON.parse(row!.metadata) : row!.metadata;
    return { stacks: normalizeGameInventoryStacks(meta.gameInventory), journal: meta.gameJournal };
  };
  const turn = async (text: string, payload: Record<string, unknown> = {}) => {
    reply = text;
    await chats.createMessage({ chatId: chat.id, role: "user", content: "I look around." });
    const response = await app.inject({
      method: "POST",
      url: "/api/generate/",
      payload: { chatId: chat.id, streaming: true, cacheGuardAcknowledged: true, ...payload },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(!response.body.includes('"type":"error"'), response.body);
    return { response, saved: (await chats.listMessages(chat.id)).at(-1)! };
  };
  const gameMasterPromptText = (sinceCall: number) => {
    const messages = prompts.slice(sinceCall).findLast((call) =>
      call.some((message) => message.content.includes("PARTY INVENTORY:") || message.content.includes("PLAYER INVENTORY:")),
    );
    assert.ok(messages, "the current turn made a Game Master provider call with inventory");
    return messages.map((message) => message.content).join("\n");
  };

  // The prompt shows who carries what, since Bram carries something.
  const firstPromptStart = prompts.length;
  const first = await turn(
    [
      `You find a lantern. [inventory: action="add" item="Lantern"]`,
      `Bram hands over two arrows. [inventory: action="give" item="Arrow" count="2" who="Bram" to="User"]`,
      `The rope snaps. [inventory: action="remove" item="Rope" result="ok"]`,
      `[inventory: action="remove" item="Crown"]`,
    ].join("\n"),
  );
  assert.match(gameMasterPromptText(firstPromptStart), /PARTY INVENTORY:\n- User: Rope\n- Bram: Arrow \u00D710/);
  const resolved = readResolvedInventoryTags(first.saved.content);
  assert.deepEqual(
    resolved.map((tag) => `${tag.action} ${tag.item} ${tag.ok ? `ok ${tag.count}->${tag.now}` : tag.reason}`),
    ["add Lantern ok 1->1", "give Arrow ok 2->2", "remove Rope ok 1->0", "remove Crown none-held"],
    "every tag is answered in the saved reply, a forged result included",
  );
  const after = await readInventory();
  assert.equal(gameInventoryCount(after.stacks, "Lantern", {}), 1);
  assert.equal(gameInventoryCount(after.stacks, "Arrow", {}), 2);
  assert.equal(gameInventoryCount(after.stacks, "Arrow", { holder: "Bram" }), 8);
  assert.equal(gameInventoryCount(after.stacks, "Rope"), 0);
  assert.deepEqual(
    (after.journal?.inventoryLog ?? []).map(
      (entry: { item: string; action: string }) => `${entry.action} ${entry.item}`,
    ),
    ["acquired Lantern", "lost Rope"],
  );
  assert.match(first.response.body, /"type":"metadata_patch","data":\{"gameInventory":/, "the client is told");

  // The next turn's prompt carries the answered tags, so the Game Master reads its own refusal.
  const secondPromptStart = prompts.length;
  const second = await turn(`Nothing else happens.`);
  assert.match(gameMasterPromptText(secondPromptStart), /item="Crown" count="1" result="refused" reason="none-held"/);
  assert.doesNotMatch(second.response.body, /"type":"metadata_patch","data":\{"gameInventory":/);
  assert.equal(normalizeGameInventoryStacks((await readInventory()).stacks).length, after.stacks.length);

  // An impersonated turn is the player writing: nothing in it is applied.
  reply = `I take the crown. [inventory: action="add" item="Crown"]`;
  const impersonated = await app.inject({
    method: "POST",
    url: "/api/generate/",
    payload: { chatId: chat.id, streaming: true, cacheGuardAcknowledged: true, impersonate: true },
  });
  assert.equal(impersonated.statusCode, 200, impersonated.body);
  assert.equal(gameInventoryCount((await readInventory()).stacks, "Crown"), 0);

  // ── Tellings of one turn never add up (#6774) ──
  {
    const swords = async () => gameInventoryCount((await readInventory()).stacks, "Sword");
    const maps = async () => gameInventoryCount((await readInventory()).stacks, "Map");
    const sword = `A blade in the grass. [inventory: action="add" item="Sword"]`;
    // The turn before carries a detailed inventory, so every telling's own row gets one too.
    const states = createGameStateStorage(db);
    const previous = (await chats.listMessages(chat.id)).filter((message) => message.role === "assistant").at(-1)!;
    await states.create({
      chatId: chat.id,
      messageId: previous.id,
      swipeIndex: previous.activeSwipeIndex ?? 0,
      date: null,
      time: null,
      location: null,
      weather: null,
      temperature: null,
      presentCharacters: [],
      recentEvents: [],
      playerStats: {
        stats: [],
        attributes: null,
        skills: {},
        inventory: [{ name: "Lantern", description: "", quantity: 1, location: "on_person" }],
        activeQuests: [],
        status: "",
      } as never,
      personaStats: null,
    });
    const rowSwords = async (swipe: number) => {
      const row = await states.getByChatAndMessage(chat.id, told.saved.id, swipe);
      const stats = row?.playerStats ? JSON.parse(row.playerStats as string) : null;
      return (stats?.inventory ?? [])
        .filter((item: { name: string }) => item.name === "Sword")
        .reduce((total: number, item: { quantity: number }) => total + item.quantity, 0);
    };
    const providerCallsBeforeSword = prompts.length;
    const told = await turn(sword);
    assert.deepEqual(
      readResolvedInventoryTags(told.saved.content).map((tag) => `${tag.action} ${tag.item} ${tag.ok ? `ok ${tag.count}->${tag.now}` : tag.reason}`),
      ["add Sword ok 1->1"],
      `the generated sword tag is applied to the saved reply; latest=${JSON.stringify(told.saved.content)}; response=${told.response.body.slice(-1500)}`,
    );
    assert.match(gameMasterPromptText(providerCallsBeforeSword), /PARTY INVENTORY:/);
    assert.equal(await swords(), 1);
    assert.equal(await rowSwords(0), 1, "the turn's own row has the sword");
    const regenerate = async (text: string) => {
      const promptStart = prompts.length;
      reply = text;
      const response = await app.inject({
        method: "POST",
        url: "/api/generate/",
        payload: { chatId: chat.id, streaming: true, cacheGuardAcknowledged: true, regenerateMessageId: told.saved.id },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(!response.body.includes('"type":"error"'), response.body);
      return gameMasterPromptText(promptStart);
    };
    const showSwipe = async (index: number) => {
      const response = await app.inject({
        method: "PUT",
        url: `/api/chats/${chat.id}/messages/${told.saved.id}/active-swipe`,
        payload: { index },
      });
      assert.equal(response.statusCode, 200, response.body);
    };

    const secondTellingPrompt = await regenerate(sword);
    assert.equal(await swords(), 1, "the second telling starts where the turn began, not where the first left it");
    // And the Game Master is shown the inventory it starts from, without the first telling's sword.
    const shown = secondTellingPrompt;
    const inventoryBlock = shown.slice(shown.search(/(PARTY|PLAYER) INVENTORY/));
    assert.match(inventoryBlock, /(PARTY|PLAYER) INVENTORY/);
    assert.doesNotMatch(inventoryBlock.split("\n\n")[0]!, /Sword/);
    assert.equal(await rowSwords(1), 1, "and so does its row, not built on the first telling's");
    await regenerate(`The grass is empty.`);
    assert.equal(await swords(), 0, "a telling with no tags leaves the turn as it began");
    assert.equal(await rowSwords(2), 0);
    // Its row carries the turn's beginning too, rather than being left to whatever it was cloned from.
    const telling2 = await states.getByChatAndMessage(chat.id, told.saved.id, 2);
    assert.deepEqual(
      JSON.parse(telling2!.playerStats as string).inventory.map((item: { name: string }) => item.name),
      ["Lantern"],
    );

    await showSwipe(0);
    assert.equal(await swords(), 1, "swiping back shows what the first telling left");
    await showSwipe(2);
    assert.equal(await swords(), 0);
    await showSwipe(1);
    assert.equal(await swords(), 1);

    // Once the player changes the inventory, nothing they did is thrown away.
    const added = await app.inject({
      method: "POST",
      url: "/api/game/inventory",
      payload: { chatId: chat.id, ops: [{ op: "add", name: "Map", count: 1 }] },
    });
    assert.equal(added.statusCode, 200, added.body);
    await showSwipe(2);
    assert.equal(await swords(), 1, "the sword stays: the stacks are no longer what that telling left");
    assert.equal(await maps(), 1);
    await regenerate(sword);
    assert.equal(await swords(), 2, "and a new telling adds on top of the player's change");
    assert.equal(await maps(), 1);

    // A continuation adds to its own telling, and its row keeps what the first part already wrote.
    reply = `A torch, too. [inventory: action="add" item="Torch"]`;
    const continued = await app.inject({
      method: "POST",
      url: "/api/generate/",
      payload: { chatId: chat.id, streaming: true, continueMessageId: told.saved.id },
    });
    assert.equal(continued.statusCode, 200, continued.body);
    assert.ok(!continued.body.includes('"type":"error"'), continued.body);
    assert.equal(gameInventoryCount((await readInventory()).stacks, "Torch"), 1);
    const active = (await chats.getMessage(told.saved.id))!.activeSwipeIndex ?? 0;
    const row = await states.getByChatAndMessage(chat.id, told.saved.id, active);
    const names = (JSON.parse(row!.playerStats as string).inventory as Array<{ name: string }>).map(
      (item) => item.name,
    );
    assert.ok(
      names.includes("Torch") && names.includes("Sword"),
      `the continued row keeps both parts: ${names.join(", ")}`,
    );
  }

  // ── Branching and deleting tellings keep each telling's result with it (#6774) ──
  {
    const gems = async (chatId = chat.id) => {
      const row = await chats.getById(chatId);
      const meta = typeof row!.metadata === "string" ? JSON.parse(row!.metadata) : row!.metadata;
      return gameInventoryCount(normalizeGameInventoryStacks(meta.gameInventory), "Gem");
    };
    const gem = (count: number) => `A gem glints. [inventory: action="add" item="Gem" count="${count}"]`;
    const told = await turn(gem(1));
    const beforeTurn = (await chats.listMessages(chat.id)).at(-2)!;
    const retell = async (count: number) => {
      reply = gem(count);
      const response = await app.inject({
        method: "POST",
        url: "/api/generate/",
        payload: { chatId: chat.id, streaming: true, cacheGuardAcknowledged: true, regenerateMessageId: told.saved.id },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(!response.body.includes('"type":"error"'), response.body);
    };
    const show = async (index: number, chatId = chat.id, messageId = told.saved.id) => {
      const response = await app.inject({
        method: "PUT",
        url: `/api/chats/${chatId}/messages/${messageId}/active-swipe`,
        payload: { index },
      });
      assert.equal(response.statusCode, 200, response.body);
    };
    const drop = async (path: string) => {
      const response = await app.inject({
        method: "DELETE",
        url: `/api/chats/${chat.id}/messages/${told.saved.id}/swipes/${path}`,
      });
      assert.equal(response.statusCode, 200, response.body);
    };
    await retell(2);
    await retell(3);
    assert.equal(await gems(), 3, "three tellings, of one, two and three gems, the last one shown");

    // A branch takes the record with its copy of the turn, so the branch's tellings still switch.
    const branch = await app.inject({ method: "POST", url: `/api/chats/${chat.id}/branch`, payload: {} });
    assert.equal(branch.statusCode, 200, branch.body);
    const branchId = branch.json().id as string;
    const branchRow = await chats.getById(branchId);
    const branchMeta = typeof branchRow!.metadata === "string" ? JSON.parse(branchRow!.metadata) : branchRow!.metadata;
    const branchTurnMessageId = branchMeta.gameInventoryTurn?.messageId;
    assert.equal(typeof branchTurnMessageId, "string", "the branch carries the inventory turn record");
    const branchMessages = await chats.listMessages(branchId);
    const branchedTurn = branchMessages.find((message) => message.id === branchTurnMessageId);
    assert.ok(
      branchedTurn,
      `the copied inventory turn record points to a message in the branch; owner=${branchTurnMessageId}; messages=${JSON.stringify(branchMessages.map((message) => ({ id: message.id, role: message.role, content: message.content.slice(0, 48) })))}`,
    );
    assert.equal(branchedTurn.role, "assistant", "the inventory turn belongs to its assistant reply");
    assert.match(branchedTurn.content, /A gem glints/, "the owner is the copied Gem turn");
    await show(0, branchId, branchTurnMessageId);
    assert.equal(await gems(branchId), 1, "the branch shows its copy of the first telling");
    assert.equal(await gems(), 3, "and the chat it came from is untouched");
    // A branch cut before the turn has no copy of it for the record to follow.
    const cut = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/branch`,
      payload: { upToMessageId: beforeTurn.id },
    });
    assert.equal(cut.statusCode, 200, cut.body);
    const cutRow = await chats.getById(cut.json().id);
    const cutMeta = typeof cutRow!.metadata === "string" ? JSON.parse(cutRow!.metadata) : cutRow!.metadata;
    assert.equal(cutMeta.gameInventoryTurn, undefined);

    // Deleting a telling that is not shown: the later ones move down with their results.
    await drop("0");
    assert.equal(await gems(), 3);
    await show(0);
    assert.equal(await gems(), 2, "the telling now first is the one that gave two");
    await show(1);
    assert.equal(await gems(), 3);
    await retell(4);
    assert.equal(await gems(), 4, "a new telling still starts where the turn began");
    // Deleting every other telling, the one shown among them: the telling kept is followed.
    await show(0);
    assert.equal(await gems(), 2);
    await drop("others/2");
    assert.equal(await gems(), 4, "the telling kept is the one that gave four");
    // Deleting the telling that is shown: the one shown next is followed.
    await retell(5);
    assert.equal(await gems(), 5);
    await drop("1");
    assert.equal(await gems(), 4);
  }

  // The next session carries every bag, but not the record of how one of this session's turns was
  // told, and a saved chat profile never takes it either.
  {
    const gameId = "inventory-turn-sessions";
    const previous = await chats.create({
      name: "Inventory turn — Session 1",
      mode: "game",
      characterIds: [],
      groupId: gameId,
    });
    assert.ok(previous);
    const stacks = [
      { id: "st-rope", name: "Rope", quantity: 2 },
      { id: "st-arrows", name: "Arrow", quantity: 10, holder: "Bram" },
    ];
    await chats.patchMetadata(previous.id, {
      gameId,
      gameSessionStatus: "concluded",
      gameSessionNumber: 1,
      gameInventory: stacks,
      gameInventoryTurn: { messageId: "session-one-turn", before: [], swipes: { "0": stacks } },
    });
    const started = await app.inject({ method: "POST", url: "/api/game/session/start", payload: { gameId } });
    assert.equal(started.statusCode, 200, started.body);
    const next = await chats.getById(started.json().sessionChat.id);
    const meta = typeof next!.metadata === "string" ? JSON.parse(next!.metadata) : next!.metadata;
    assert.deepEqual(
      normalizeGameInventoryStacks(meta.gameInventory).map(
        (stack) => `${stack.name} ${stack.quantity} ${stack.holder ?? "player"}`,
      ),
      ["Rope 2 player", "Arrow 10 Bram"],
      "every bag carries over",
    );
    assert.equal(meta.gameInventoryTurn, undefined, "the previous session's turn record stays behind");
    assert.ok(CHAT_PRESET_EXCLUDED_METADATA_KEYS.includes("gameInventoryTurn"));
  }

  // ── A ruleset's items (#6795): the route and a turn read the game's ruleset ──
  {
    const ember = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../docs/examples/rulesets/ember-roads.json", import.meta.url)), "utf8"),
    ) as Record<string, any>;
    const strict = structuredClone(ember);
    strict.id = "ember-strict";
    strict.items.freeform = "refuse";
    const rulesets = createGameRulesetsStorage(db);
    await rulesets.put({
      rulesetId: "local/ember-roads",
      version: ember.version,
      sourceKind: "local",
      definition: JSON.stringify(ember),
    });
    await rulesets.put({
      rulesetId: "local/ember-strict",
      version: strict.version,
      sourceKind: "local",
      definition: JSON.stringify(strict),
    });
    const connection = (await createConnectionsStorage(db).list())[0]!;
    const rulesetGame = async (id: string) => {
      const game = await chats.create({
        name: `Ruleset items ${id}`,
        mode: "game",
        characterIds: [],
        connectionId: connection.id,
        promptPresetId: null,
      });
      assert.ok(game);
      await chats.patchMetadata(game.id, {
        enableAgents: false,
        enableTools: false,
        gameRuleset: { id, version: ember.version, packageId: null, options: {} },
      });
      return game;
    };
    const stacksOf = async (chatId: string) => {
      const row = await chats.getById(chatId);
      const meta = typeof row!.metadata === "string" ? JSON.parse(row!.metadata) : row!.metadata;
      return normalizeGameInventoryStacks(meta.gameInventory).map(
        (stack) => `${stack.name}${stack.item ? ` <${stack.item}>` : ""} ${stack.quantity}`,
      );
    };
    const change = async (chatId: string, ops: unknown[]) => {
      const response = await app.inject({ method: "POST", url: "/api/game/inventory", payload: { chatId, ops } });
      assert.equal(response.statusCode, 200, response.body);
      return response.json().results as Array<{ ok: boolean; reason?: string }>;
    };

    // The player's typed name is the ruleset's item; one picked adds by its id; arrows stack by 20.
    const roads = await rulesetGame("local/ember-roads");
    await change(roads.id, [
      { op: "add", name: "hand AXE", count: 1 },
      { op: "add", name: "Arrows", item: "outfitter/arrows", count: 30 },
      { op: "add", name: "Rope", count: 1 },
    ]);
    assert.deepEqual(await stacksOf(roads.id), [
      "Hand axe <outfitter/hand-axe> 1",
      "Arrows <outfitter/arrows> 20",
      "Arrows <outfitter/arrows> 10",
      "Rope <plain:rope> 1",
    ]);
    // Only its own items, in a ruleset that takes nothing else.
    const strictGame = await rulesetGame("local/ember-strict");
    const refusedPlain = await change(strictGame.id, [
      { op: "add", name: "Rope", count: 1 },
      { op: "add", name: "Road rations", count: 1 },
    ]);
    assert.deepEqual(
      refusedPlain.map((result) => (result.ok ? "ok" : result.reason)),
      ["not-ruleset-item", "ok"],
    );
    assert.deepEqual(await stacksOf(strictGame.id), ["Road rations <outfitter/road-rations> 1"]);
    // Arrows the party carried before the game had its ruleset's items: a plain item of that name.
    const beforeTurn = await chats.getById(strictGame.id);
    const beforeMeta =
      typeof beforeTurn!.metadata === "string" ? JSON.parse(beforeTurn!.metadata) : beforeTurn!.metadata;
    await chats.patchMetadata(strictGame.id, {
      gameInventory: [...beforeMeta.gameInventory, { id: "st-old-arrows", name: "Arrows", quantity: 4 }],
    });

    // The Game Master's name is the ruleset's item too, stacked by 7, and its plain items still land
    // (untyped items are the native switch's, not freeform's).
    reply = `You find food. [inventory: action="add" item="Road rations" count="9"] And a lamp. [inventory: action="add" item="Lamp"] And a fresh quiver. [inventory: action="add" item="Arrows" count="2"]`;
    await chats.createMessage({ chatId: strictGame.id, role: "user", content: "I search the wagon." });
    const gmTurn = await app.inject({
      method: "POST",
      url: "/api/generate/",
      payload: { chatId: strictGame.id, streaming: true, cacheGuardAcknowledged: true },
    });
    assert.equal(gmTurn.statusCode, 200, gmTurn.body);
    const answered = readResolvedInventoryTags((await chats.listMessages(strictGame.id)).at(-1)!.content);
    assert.deepEqual(
      answered.map((tag) => `${tag.item} ${tag.ok ? `ok ${tag.count}->${tag.now}` : tag.reason}`),
      // The ruleset's arrows are another item than the old plain ones, so two are held of them.
      ["Road rations ok 9->10", "Lamp ok 1->1", "Arrows ok 2->2"],
    );
    // The answers streamed before the reply is saved already read the ruleset.
    const streamed = gmTurn.body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => {
        try {
          return JSON.parse(line.slice("data: ".length)) as { type?: string; data?: unknown };
        } catch {
          return null;
        }
      })
      .find((event) => event?.type === "content_replace");
    assert.match(String(streamed?.data ?? ""), /item="Arrows" count="2" result="ok" now="2"/);
    assert.deepEqual(await stacksOf(strictGame.id), [
      "Road rations <outfitter/road-rations> 7",
      "Arrows <plain:arrows> 4",
      "Road rations <outfitter/road-rations> 3",
      "Lamp <plain:lamp> 1",
      "Arrows <outfitter/arrows> 2",
    ]);
    // The next turn's prompt says what the ruleset's item is, and that names become its items.
    reply = "The road goes on.";
    await chats.createMessage({ chatId: strictGame.id, role: "user", content: "I walk on." });
    const nextPromptStart = prompts.length;
    const next = await app.inject({
      method: "POST",
      url: "/api/generate/",
      payload: { chatId: strictGame.id, streaming: true, cacheGuardAcknowledged: true },
    });
    assert.equal(next.statusCode, 200, next.body);
    const prompt = gameMasterPromptText(nextPromptStart);
    assert.match(
      prompt,
      /PLAYER INVENTORY: Road rations ×10 \[Provisions, Common; Bulk 1\]; Arrows ×4; Lamp; Arrows ×2 \[Ammunition, Common; Bulk 1\]/,
    );
    assert.match(prompt, /an item named exactly as one of them becomes that item/);

    // A new session brings back what only the detailed inventory still names, stacked as its item
    // allows: thirty arrows are a stack of twenty and one of ten.
    const gameId = "ruleset-items-sessions";
    const ended = await chats.create({
      name: "Ruleset items — Session 1",
      mode: "game",
      characterIds: [],
      groupId: gameId,
    });
    assert.ok(ended);
    await chats.patchMetadata(ended.id, {
      gameId,
      gameSessionStatus: "concluded",
      gameSessionNumber: 1,
      gameRuleset: { id: "local/ember-roads", version: ember.version, packageId: null, options: {} },
      gameInventory: [],
    });
    const last = await chats.createMessage({ chatId: ended.id, role: "assistant", content: "The road ends here." });
    await createGameStateStorage(db).create({
      chatId: ended.id,
      messageId: last.id,
      swipeIndex: 0,
      date: null,
      time: null,
      location: null,
      weather: null,
      temperature: null,
      presentCharacters: [],
      recentEvents: [],
      playerStats: {
        stats: [],
        attributes: null,
        skills: {},
        inventory: [{ item: "outfitter/arrows", name: "Arrows", description: "", quantity: 30, location: "on_person" }],
        activeQuests: [],
        status: "",
      } as never,
      personaStats: null,
    });
    const carried = await app.inject({ method: "POST", url: "/api/game/session/start", payload: { gameId } });
    assert.equal(carried.statusCode, 200, carried.body);
    assert.deepEqual(await stacksOf(carried.json().sessionChat.id), [
      "Arrows <outfitter/arrows> 20",
      "Arrows <outfitter/arrows> 10",
    ]);
  }

  console.info("game inventory turn regressions passed.");
} finally {
  ClaudeSubscriptionProvider.prototype.chat = originalChat;
  await app.close();
  await closeDB();
  rmSync(dir, { recursive: true, force: true });
}
