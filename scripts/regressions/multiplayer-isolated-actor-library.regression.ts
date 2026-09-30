import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mock } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerationRunner } from "../../packages/server/src/routes/generate.routes.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-room-isolated-actor-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";

const prompts: string[] = [];
const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as any;
  const prompt = (body.messages ?? []).map((message: any) => message.content ?? "").join("\n");
  const rosterMatch = prompt.match(/Trusted actor roster[^:]*:\s*(\[[\s\S]*?\])/u);
  const expectedActor = prompt.match(/Expected actor ID:\s*([^\n]+)/u)?.[1]?.trim();
  const actorId = rosterMatch ? JSON.parse(rosterMatch[1])[0]?.actorId : expectedActor;
  // Background scene-timeline jobs may overlap cases; planner/actor counts stay exact.
  assert.ok(rosterMatch || expectedActor || prompt.includes('"knownCharacterNames"'), "unexpected fixture provider request");
  if (rosterMatch || expectedActor) prompts.push(prompt);
  const sceneSpeaker = prompt.match(/\[([^\]]+)\] \[main\]: "I keep watch beside the gate."/u)?.[1] ?? "Watchman";
  const content = rosterMatch
    ? JSON.stringify({
        publicScene: [{ beat: 0, text: "The watchman publicly says the eastern gate is open.", perceivedBy: actorId ? [actorId] : [] }],
        actorRequests: actorId ? [{ beat: 0, actorId }] : [],
      })
    : expectedActor
      ? JSON.stringify({ actorId, lines: [{ type: "main", text: "I keep watch beside the gate." }] })
      : JSON.stringify({ visits: [{
          location: "Eastern Gate", present: [sceneSpeaker], participants: [sceneSpeaker],
          presenceEvidence: [{ name: sceneSpeaker, quote: "[" + sceneSpeaker + '] [main]: "I keep watch beside the gate."' }],
          departures: [], facts: [],
        }] });
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }));
});

let app: { ready(): Promise<void>; close(): Promise<void>; inject(options: Record<string, unknown>): Promise<any> } | undefined;
let closeDB: (() => Promise<void>) | undefined;
const spies: Array<{ mock: { restore(): void } }> = [];
try {
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
  const Fastify = requireServer("fastify") as typeof import("fastify").default;
  const { getDB } = await import("../../packages/server/src/db/connection.js");
  ({ closeDB } = await import("../../packages/server/src/db/connection.js"));
  const { generateRoutes } = await import("../../packages/server/src/routes/generate.routes.js");
  const { createGenerationEventSink } = await import("../../packages/server/src/routes/generate/sse.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
  const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
  const { createPromptsStorage } = await import("../../packages/server/src/services/storage/prompts.storage.js");
  const { characterDataSchema } = await import("../../packages/shared/dist/index.js");
  const db = await getDB();
  const fastify = Fastify();
  fastify.decorate("db", db);
  let runner: GenerationRunner | undefined;
  await fastify.register(generateRoutes, { prefix: "/api/generate", onRunnerReady: (value) => { runner = value; } });
  app = fastify;
  await app.ready();
  assert.ok(runner);

  const connection = await createConnectionsStorage(db).create({
    name: "isolated actor library fixture", provider: "custom", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "fixture", apiKey: "fixture", maxContext: 131072,
  } as any);
  const presets = createPromptsStorage(db);
  const preset = await presets.create({ name: "Room actor fixture", parameters: { maxTokens: 1024 }, wrapFormat: "xml" });
  assert.ok(preset);
  await presets.createSection({ presetId: preset.id, identifier: "history", name: "History", isMarker: true, markerConfig: { type: "chat_history" } });
  const chats = createChatsStorage(db);
  const characters = createCharactersStorage(db);
  const approved = await characters.create(characterDataSchema.parse({ name: "Approved Room Character" }));
  const libraryNpc = await characters.create(characterDataSchema.parse({ name: "Private Library Watchman", description: "LIBRARY_SECRET_CONTEXT_7D39", personality: "Observant", scenario: "The eastern gate" }));
  assert.ok(approved && libraryNpc);

  const claim = { roomId: "room_actor_fixture", epoch: "epoch_actor_fixture", operationId: "operation_actor_fixture" };
  const room = {
    version: 1, role: "host", roomId: claim.roomId, epoch: claim.epoch, generationOperationId: claim.operationId, status: "active",
    participants: [{ id: "host_actor_fixture", displayName: "Mari", persona: { name: "Mari", description: "A traveller." }, isHost: true }],
    characters: [{ id: approved.id, name: "Approved Room Character", role: "character" }],
  };
  const gameNpc = {
    id: "npc:watchman",
    characterId: libraryNpc.id,
    name: "Watchman",
    description: "A watchman stands at the eastern gate and publicly reports the gate is open.",
    observedDescription: "OBSERVED_PUBLIC_WATCHMAN_FACT_91C2: the eastern gate is open.",
  };
  const priorAssistantText = "The watchman publicly says the eastern gate is open.";
  const { sceneTurnHash } = await import("../../packages/server/src/services/game/scene-timeline-model.js");
  const makeRoomChat = async (name: string, roomState: typeof room) => {
    const fixture = await chats.create({ name, mode: "game", characterIds: [], connectionId: connection.id, promptPresetId: preset.id } as any);
    await chats.patchMetadata(fixture.id, {
      multiplayer: roomState, gameNpcKnowledgeMode: "isolated", gameNpcs: [gameNpc],
      gameJournal: { entries: [], quests: [], locations: [], npcLog: [], inventoryLog: [] },
    });
    const priorUser = await chats.createMessage({ chatId: fixture.id, role: "user", content: "I meet the watchman at the eastern gate." } as any);
    const priorAssistant = await chats.createMessage({ chatId: fixture.id, role: "assistant", content: priorAssistantText } as any);
    let timelineHash = sceneTurnHash("scene-timeline-v3", JSON.stringify([]));
    timelineHash = sceneTurnHash(timelineHash, `${priorUser.id}:0:user: ${priorUser.content}`);
    timelineHash = sceneTurnHash(timelineHash, `${priorAssistant.id}:0:assistant: ${priorAssistantText}`);
    await chats.updateMessageExtra(priorAssistant.id, {
      gameSceneTimeline: {
        visits: [{
          location: "Eastern Gate", present: ["Watchman"], participants: ["Watchman"],
          presenceEvidence: [{ name: "Watchman", quote: priorAssistantText }], departures: [], facts: [],
        }],
        hash: timelineHash,
      },
    } as any);
    return fixture;
  };
  const chat = await makeRoomChat("Shared isolated actor", room);
  const run = async (chatId: string, roomContext?: typeof claim) => {
    const events: unknown[] = [];
    let statusCode = 200;
    const sink = createGenerationEventSink({
      onEvent: (event) => events.push(event),
      onFinish: (result) => { statusCode = result.statusCode; },
    });
    await runner!({ chatId, userMessage: null, connectionId: connection.id, streaming: true }, sink, roomContext);
    return { statusCode, events };
  };

  // Observe resolved rows from real queries against the characters table.
  // This catches linked-card reads without coupling to storage factory bindings
  // or query-builder internals.
  const { characters: charactersTable } = await import("../../packages/server/src/db/schema/characters.js");
  const originalSelect = db.select;
  const libraryCardRows: unknown[] = [];
  const readSpy = mock.method(db, "select", function (this: any, ...selectArgs: any[]) {
    const builder = originalSelect.apply(this, selectArgs);
    return new Proxy(builder, {
      get(target, property, receiver) {
        if (property !== "from") return Reflect.get(target, property, receiver);
        const originalFrom = Reflect.get(target, property, target);
        return function (this: any, ...fromArgs: any[]) {
          const query = Reflect.apply(originalFrom, this, fromArgs);
          if (fromArgs[0] !== charactersTable) return query;
          const caller = new Error("characters query").stack;
          return new Proxy(query, {
            get(queryTarget, queryProperty, queryReceiver) {
              if (queryProperty !== "then") return Reflect.get(queryTarget, queryProperty, queryReceiver);
              const originalThen = Reflect.get(queryTarget, queryProperty, queryTarget);
              return function (onfulfilled: any, onrejected: any) {
                return Reflect.apply(originalThen, queryTarget, [
                  (rows: any) => {
                    if (Array.isArray(rows)) {
                      libraryCardRows.push(...rows.filter((row) => row?.id === libraryNpc.id).map((row) => ({ row, caller })));
                    }
                    return onfulfilled ? onfulfilled(rows) : rows;
                  },
                  onrejected,
                ]);
              };
            },
          });
        };
      },
    });
  });
  spies.push(readSpy);
  try {
    await chats.createMessage({ chatId: chat.id, role: "user", content: "I approach the eastern gate." } as any);
    const response = await run(chat.id, claim);
    const responseText = JSON.stringify(response.events);
    assert.equal(response.statusCode, 200, responseText);
    assert.match(responseText, /watchman publicly says the eastern gate is open/u, "observed room NPC prose contributes to the shared response");
    assert.equal(prompts.length, 2, "the planner chose a linked NPC and its actor prompt ran");
    assert.match(prompts[1]!, new RegExp(`Expected actor ID:\\s*${libraryNpc.id}`, "u"), "the test reaches deferred selected-actor resolution");
    assert.match(prompts[1]!, /OBSERVED_PUBLIC_WATCHMAN_FACT_91C2/u, "the selected actor receives the NPC's observed public description");
    assert.doesNotMatch(prompts[1]!, /LIBRARY_SECRET_CONTEXT_7D39/u, "unapproved library prose never reaches selected actor context");
    assert.deepEqual(libraryCardRows, [], "shared-room generation never reads the unapproved linked library card");
    const savedActorReply = (await chats.listMessages(chat.id)).filter((message) => message.role === "assistant").at(-1);
    assert.ok(savedActorReply);
    assert.match(savedActorReply.content, /I keep watch beside the gate/u, "the selected actor dialogue is persisted");

    // The same chat may be generated under a different room approval set while its memo is warm.
    const { readNamedCharacterIds } = await import("../../packages/server/src/services/game/named-characters.js");
    const { resolveRoomGenerationPolicy, runWithRoomGeneration } =
      await import("../../packages/server/src/services/multiplayer/generation-policy.js");
    await chats.createMessage({ chatId: chat.id, role: "user", content: "I ask Private Library Watchman to speak." } as any);
    const namesUnderApproval = (ids: string[]) => {
      const scopedRoom = { ...room, characters: ids.map((id) => ({ id, name: "Watchman", role: "character" })) };
      const policy = resolveRoomGenerationPolicy(chat.id, { multiplayer: scopedRoom }, [], claim);
      assert.ok(policy);
      return runWithRoomGeneration(policy, () => readNamedCharacterIds(db, chat.id));
    };
    libraryCardRows.length = 0;
    assert.deepEqual(await namesUnderApproval([libraryNpc.id]), [libraryNpc.id], "an approved named card is discovered");
    assert.ok(libraryCardRows.length > 0, "approved name matching reads the actual card");
    libraryCardRows.length = 0;
    assert.deepEqual(await namesUnderApproval([libraryNpc.id]), [libraryNpc.id], "the same approval scope keeps its memo");
    assert.deepEqual(libraryCardRows, [], "a warm matching scope avoids another library read");
    assert.deepEqual(await namesUnderApproval([approved.id]), [], "a narrower scope cannot reuse the approved card memo");
    assert.deepEqual(libraryCardRows, [], "the narrower scope never reads the excluded card");
    assert.deepEqual(await namesUnderApproval([]), [], "an empty room approval set discovers no library characters");
    assert.deepEqual(libraryCardRows, [], "empty approvals never read the excluded card");
    assert.deepEqual(await namesUnderApproval([libraryNpc.id]), [libraryNpc.id], "restored approval still discovers the card");
    assert.ok(libraryCardRows.length > 0, "restored approval is not stuck with the denied-scope memo");
    libraryCardRows.length = 0;
    assert.deepEqual(await readNamedCharacterIds(db, chat.id), [libraryNpc.id], "private scope retains full-library discovery");
    assert.ok(libraryCardRows.length > 0, "private scope does not reuse a room-scoped memo");
    libraryCardRows.length = 0;
    assert.deepEqual(await readNamedCharacterIds(db, chat.id), [libraryNpc.id], "private scope keeps its warm memo");
    assert.deepEqual(libraryCardRows, [], "private memo reuse avoids another library scan");

    // Positive control: approving the linked library card makes its external context available.
    const approvedRoom = { ...room, characters: [...room.characters, { id: libraryNpc.id, name: "Watchman", role: "character" }] };
    const approvedChat = await makeRoomChat("Approved shared isolated actor", approvedRoom);
    prompts.length = 0;
    libraryCardRows.length = 0;
    await chats.createMessage({ chatId: approvedChat.id, role: "user", content: "The watchman speaks again." } as any);
    const approvedResponse = await run(approvedChat.id, claim);
    assert.equal(approvedResponse.statusCode, 200, JSON.stringify(approvedResponse.events));
    assert.equal(prompts.length, 2, "the approved linked NPC also receives a deferred actor request");
    assert.match(prompts[1]!, new RegExp(`Expected actor ID:\\s*${libraryNpc.id}`, "u"));
    assert.match(prompts[1]!, /LIBRARY_SECRET_CONTEXT_7D39/u, "the positive control sends the approved external card");
    assert.ok(libraryCardRows.length > 0, "the query spy detects rows returned for the approved linked card");

    // Private isolated Game mode retains its normal linked-card lookup behavior.
    const privateChat = await chats.create({ name: "Private isolated actor", mode: "game", characterIds: [], connectionId: connection.id, promptPresetId: preset.id } as any);
    await chats.patchMetadata(privateChat.id, {
      gameNpcKnowledgeMode: "isolated", gameNpcs: [gameNpc],
      gameJournal: { entries: [], quests: [], locations: [], npcLog: [], inventoryLog: [] },
    });
    const privateUser = await chats.createMessage({ chatId: privateChat.id, role: "user", content: "I meet the watchman at the eastern gate." } as any);
    const privateAssistant = await chats.createMessage({ chatId: privateChat.id, role: "assistant", content: priorAssistantText } as any);
    let privateHash = sceneTurnHash("scene-timeline-v3", JSON.stringify([]));
    privateHash = sceneTurnHash(privateHash, `${privateUser.id}:0:user: ${privateUser.content}`);
    privateHash = sceneTurnHash(privateHash, `${privateAssistant.id}:0:assistant: ${priorAssistantText}`);
    await chats.updateMessageExtra(privateAssistant.id, {
      gameSceneTimeline: {
        visits: [{ location: "Eastern Gate", present: ["Watchman"], participants: ["Watchman"], presenceEvidence: [{ name: "Watchman", quote: priorAssistantText }], departures: [], facts: [] }],
        hash: privateHash,
      },
    } as any);
    prompts.length = 0;
    libraryCardRows.length = 0;
    await chats.createMessage({ chatId: privateChat.id, role: "user", content: "The watchman speaks again." } as any);
    const privateResponse = await run(privateChat.id);
    assert.equal(privateResponse.statusCode, 200, JSON.stringify(privateResponse.events));
    assert.equal(prompts.length, 2, "private isolated generation also reaches its selected NPC actor");
    assert.match(prompts[1]!, new RegExp(`Expected actor ID:\\s*${libraryNpc.id}`, "u"));
    assert.match(prompts[1]!, /LIBRARY_SECRET_CONTEXT_7D39/u, "private isolated actor keeps its external character context");
    assert.ok(libraryCardRows.length > 0, "the query spy detects rows returned for the private linked card");
  } finally {
    readSpy.mock.restore();
  }

  console.log("multiplayer isolated actor library regression passed");
} finally {
  for (const spy of spies) spy.mock.restore();
  if (app) await app.close();
  if (closeDB) await closeDB();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
}
