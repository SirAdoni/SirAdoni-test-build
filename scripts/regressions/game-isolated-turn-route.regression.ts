import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-isolated-route-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
type Scenario =
  | "success"
  | "introduction"
  | "invalid-plan"
  | "actor-failure"
  | "missing-usage"
  | "legacy"
  | "oversized-actor";
let scenario: Scenario = "success";
const bodies: Array<Record<string, any>> = [];
function trustedActorIds(body: Record<string, any>): string[] {
  const injection = body.messages.findLast(
    (message: any) =>
      typeof message.content === "string" && message.content.includes("Trusted actor roster (exact IDs):"),
  );
  assert.ok(injection, "planner includes an explicit trusted roster");
  const roster = JSON.parse(injection.content.split("Trusted actor roster (exact IDs): ").at(-1));
  return roster.map((actor: { actorId: string }) => actor.actorId);
}
const provider = createServer(async (_request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of _request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>;
  bodies.push(body);
  const prompt = (body.messages ?? []).map((message: any) => message.content ?? "").join("\n");
  const planner = prompt.includes("Trusted actor roster");
  const rosterMatch = prompt.match(/Trusted actor roster[^:]*:\s*(\[[\s\S]*?\])/u);
  const roster = rosterMatch ? (JSON.parse(rosterMatch[1]) as Array<{ actorId: string }>) : [];
  const expected = prompt.match(/Expected actor ID:\s*([^\n]+)/u)?.[1]?.trim();
  const actorId = roster[0]?.actorId ?? expected ?? "missing";
  const introductionFacts = [
    "Ada — household steward",
    "Mira — courier",
    "Nora — senior housemaid",
    "Pella — cook",
    "Suri — pantry cook",
    "Tavi — laundress",
    "Veya — housemaid",
    "Orla — carriage driver",
    "Brina — housemaid",
    "Celene — housemaid",
    "Tamsin — housemaid",
    "Nella — housemaid",
    "Olya — housemaid",
    "Jessa — housemaid",
    "Fara — housemaid",
    "Kessa — housemaid",
    "Leni — relief maid",
    "Hesta — head cook",
    "Ameline — resident companion",
  ];
  const oversizedScene = Array.from({ length: 24 }, (_, beat) => ({
    beat,
    text: "OBSERVABLE-" + beat + "-" + "x".repeat(3900),
    perceivedBy: roster.map(({ actorId: id }) => id),
  }));
  const content =
    scenario === "invalid-plan" && planner
      ? JSON.stringify({ publicScene: [{ beat: 0, text: "<private>leak</private>" }], actorRequests: [] })
      : planner
        ? scenario === "introduction"
          ? JSON.stringify({
              publicScene: [
                {
                  beat: 0,
                  text: "The visible household staff wait in their arranged groups.",
                  perceivedBy: roster.map(({ actorId: id }) => id),
                },
                {
                  beat: 1,
                  text: `Dorian publicly presents the visible staff by name and role: ${introductionFacts.join("; ")}.`,
                  perceivedBy: roster.length > 0 ? [roster[0]!.actorId] : [],
                },
              ],
              actorRequests: roster.length > 0 ? [{ beat: 1, actorId: roster[0]!.actorId }] : [],
            })
          : scenario === "oversized-actor"
            ? JSON.stringify({
                publicScene: oversizedScene,
                actorRequests: roster.map(({ actorId: id }) => ({ beat: 23, actorId: id })),
              })
            : JSON.stringify({
                publicScene: [
                  { beat: 0, text: "The room is quiet.", perceivedBy: roster.map(({ actorId: id }) => id) },
                  ...(roster.length > 0
                    ? [{ beat: 1, text: "ALICE_SECRET_RAW_PLAYER_PRIVATE", perceivedBy: [roster[0]!.actorId] }]
                    : []),
                ],
                actorRequests: roster.map(({ actorId: id }, index) => ({ beat: index === 0 ? 1 : 0, actorId: id })),
              })
        : scenario === "actor-failure"
          ? JSON.stringify({ actorId: "wrong-actor", lines: [{ type: "main", text: "bad" }] })
          : scenario === "introduction"
            ? JSON.stringify({
                actorId,
                lines: introductionFacts.map((fact) => ({ type: "main", text: fact })),
              })
            : JSON.stringify({ actorId, lines: [{ type: "main", text: "I watch the door." }] });
  if (scenario === "legacy" && body.stream === true) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Legacy narrative." } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: "stop" }],
      ...(scenario === "missing-usage" && !planner
        ? {}
        : {
            usage: {
              prompt_tokens: 2,
              completion_tokens: 3,
              total_tokens: 5,
              prompt_tokens_details: { cached_tokens: 1 },
            },
          }),
    }),
  );
});

let app: {
  ready(): Promise<void>;
  close(): Promise<void>;
  inject(options: Record<string, unknown>): Promise<any>;
} | null = null;
try {
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const { buildApp } = await import("../../packages/server/src/app.js");
  const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
  const { createConnectionsStorage } =
    await import("../../packages/server/src/services/storage/connections.storage.js");
  const { createGameStateStorage } = await import("../../packages/server/src/services/storage/game-state.storage.js");
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const db = await getDB();
  app = await buildApp();
  await app.ready();
  const originalInject = app.inject.bind(app);
  const npcSyncRequests: Array<Record<string, unknown>> = [];
  const pendingNpcSyncRequests = new Set<Promise<unknown>>();
  app.inject = (async (options: Record<string, unknown>) => {
    const isNpcSync = typeof options.url === "string" && options.url === "/api/game/npc-characters/sync";
    if (isNpcSync) {
      npcSyncRequests.push(options);
    }
    const request = originalInject(options);
    if (isNpcSync) {
      pendingNpcSyncRequests.add(request);
      request.then(
        () => pendingNpcSyncRequests.delete(request),
        () => pendingNpcSyncRequests.delete(request),
      );
    }
    return request;
  }) as typeof app.inject;
  const chats = createChatsStorage(db);
  const characters = createCharactersStorage(db);
  const states = createGameStateStorage(db);
  const memory = createCampaignMemoryStorage(db);
  const connections = createConnectionsStorage(db);
  const connection = await connections.create({
    name: "isolated route fake",
    provider: "custom",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "test",
    model: "fake",
    fallbackForMain: true,
    treatAsLocalEndpoint: true,
  } as any);
  const makeChat = async (mode: "isolated" | "legacy" | "empty") => {
    if (mode === "empty") {
      const chat = await chats.create({ name: "narrator only", mode: "game", characterIds: [] } as any);
      await chats.updateMetadata(chat.id, {
        gameNpcKnowledgeMode: "isolated",
        gameNpcs: [],
        gameJournal: { entries: [], quests: [], locations: [], npcLog: [], inventoryLog: [] },
      } as any);
      const prior = await chats.createMessage({ chatId: chat.id, role: "user", content: "I enter." } as any);
      await states.create({
        chatId: chat.id,
        messageId: prior.id,
        swipeIndex: 0,
        date: "",
        time: "",
        location: "",
        weather: "",
        temperature: "",
        worldCustomFields: [],
        presentCharacters: [],
        recentEvents: [],
        playerStats: null,
        personaStats: null,
      } as any);
      return { chat, alice: "", bob: "" };
    }
    const makeCharacter = async (name: string) =>
      (await characters.create({ name, description: `${name} card`, personality: "steady", scenario: "Inn" } as any))!
        .id;
    const alice = await makeCharacter("Alice Route");
    const bob = await makeCharacter("Bob Route");
    const chat = await chats.create({ name: `isolated ${mode}`, mode: "game", characterIds: [alice, bob] } as any);
    await chats.updateMetadata(chat.id, {
      ...(mode === "isolated" ? { gameNpcKnowledgeMode: "isolated" } : {}),
      gameNpcs: [],
      gameJournal: { entries: [], quests: [], locations: [], npcLog: [], inventoryLog: [] },
    } as any);
    const prior = await chats.createMessage({ chatId: chat.id, role: "user", content: "I enter." } as any);
    await states.create({
      chatId: chat.id,
      messageId: prior.id,
      swipeIndex: 0,
      date: "",
      time: "",
      location: "",
      weather: "",
      temperature: "",
      worldCustomFields: [],
      presentCharacters: [{ characterId: alice }, { characterId: bob }],
      recentEvents: [],
      playerStats: null,
      personaStats: null,
    } as any);
    const entity = await memory.createEntity({
      entityId: `${chat.id}-alice-memory`,
      chatId: chat.id,
      kind: "character",
      owner: { type: "existing", store: "characters", recordId: alice },
      aliases: ["Alice Route"],
      tags: [],
      attributes: {},
      status: "active",
      manualLock: false,
      provenance: { source: "test", sourceRevision: "test", actor: "user" },
      summary: "ALICE_PRIVATE_MEMORY",
    });
    const fact = await memory.createFact({
      chatId: chat.id,
      subjectEntityId: entity.entityId,
      predicate: "remembers",
      value: "ALICE_PRIVATE_MEMORY",
      conditions: [],
      status: "verified",
      sourceRevision: "test",
      evidence: [],
      author: "user",
      provenance: { source: "test", sourceRevision: "test", actor: "user" },
      manualLock: false,
    });
    await memory.createKnowledge({
      chatId: chat.id,
      holderEntityId: entity.entityId,
      factId: fact.factId,
      epistemicState: "knows",
      learnedFrom: [],
      provenance: { source: "test", sourceRevision: "test", actor: "user" },
      manualLock: false,
    });
    return { chat, alice, bob };
  };
  const makeSceneLibraryChat = async (
    mode: "present" | "empty" | "departure" | "incomplete" | "duplicate" | "persona" = "present",
  ) => {
    const makeLibraryCharacter = async (name: string) =>
      (await characters.create({
        name,
        description: `${name} stable library card`,
        personality: "steady",
        scenario: "Archive Hall",
      } as any))!.id;
    const firstGuestName = `Mara Reed (${mode})`;
    const secondGuestName = `Nora Pike (${mode})`;
    const firstGuest = await makeLibraryCharacter(firstGuestName);
    const secondGuest = await makeLibraryCharacter(secondGuestName);
    if (mode === "duplicate") await makeLibraryCharacter(firstGuestName);
    const chat = await chats.create({
      name: "scene library admission",
      mode: "game",
      characterIds: [],
      ...(mode === "persona" ? { personaCharacterId: firstGuest } : {}),
    } as any);
    await chats.updateMetadata(chat.id, {
      gameNpcKnowledgeMode: "isolated",
      gameNpcs: [{ id: "npc:steward", name: "Steward Scene", observedDescription: "steward" }],
      gameJournal: { entries: [], quests: [], locations: [], npcLog: [], inventoryLog: [] },
    } as any);
    const user = await chats.createMessage({
      chatId: chat.id,
      role: "user",
      content: "Steward Scene, introduce the two women waiting in the archive hall.",
    } as any);
    const assistantContent = "The two women wait in the archive hall with the steward.";
    const assistant = await chats.createMessage({
      chatId: chat.id,
      role: "assistant",
      content: assistantContent,
    } as any);
    if (mode !== "incomplete") {
      const { sceneTurnHash } = await import("../../packages/server/src/services/game/scene-timeline-model.js");
      let hash = sceneTurnHash("scene-timeline-v3", JSON.stringify([]));
      hash = sceneTurnHash(hash, `${user.id}:0:user: ${user.content}`);
      hash = sceneTurnHash(hash, `${assistant.id}:0:assistant: ${assistantContent}`);
      const present =
        mode === "present"
          ? ["Steward Scene", firstGuestName, secondGuestName]
          : mode === "empty"
            ? []
            : ["duplicate", "persona"].includes(mode)
              ? ["Steward Scene", firstGuestName]
              : ["Steward Scene"];
      await chats.updateMessageExtra(assistant.id, {
        gameSceneTimeline: {
          visits: [
            {
              location: "Archive Hall",
              present,
              participants: present,
              presenceEvidence: present.map((name) => ({
                name,
                quote: "The two women wait in the archive hall with the steward.",
              })),
              departures:
                mode === "departure"
                  ? [
                      { name: firstGuestName, quote: `${firstGuestName} leaves the archive hall.` },
                      { name: secondGuestName, quote: `${secondGuestName} leaves the archive hall.` },
                    ]
                  : [],
              facts: [],
            },
          ],
          hash,
        },
      } as any);
    }
    if (mode === "incomplete" || mode === "empty") {
      await states.create({
        chatId: chat.id,
        messageId: assistant.id,
        swipeIndex: 0,
        date: "",
        time: "",
        location: "Archive Hall",
        weather: "",
        temperature: "",
        worldCustomFields: [],
        presentCharacters: [{ characterId: firstGuest }],
        recentEvents: [],
        playerStats: null,
        personaStats: null,
      } as any);
    }
    return { chat, firstGuest, secondGuest, firstGuestName };
  };
  const generate = (chatId: string, userMessage = "I enter.") =>
    app!.inject({
      method: "POST",
      url: "/api/generate",
      payload: { chatId, userMessage, connectionId: connection.id, streaming: true },
    });

  const isolated = await makeChat("isolated");
  bodies.length = 0;
  scenario = "success";
  const success = await generate(isolated.chat.id);
  assert.equal(success.statusCode, 200, success.body);
  assert.match(success.body, /The room is quiet/u);
  assert.match(success.body, /I watch the door/u);
  assert.equal(bodies.length, 3, "planner plus one request per actor");
  const plannerText = bodies[0]!.messages.map((message: any) => message.content).join("\n");
  assert.match(plannerText, new RegExp(isolated.alice));
  assert.match(plannerText, new RegExp(isolated.bob));
  const actorTexts = bodies.slice(1).map((body) => body.messages.map((message: any) => message.content).join("\n"));
  assert.equal(actorTexts.filter((text) => text.includes("ALICE_PRIVATE_MEMORY")).length, 1);
  assert.equal(actorTexts.filter((text) => text.includes("ALICE_SECRET_RAW_PLAYER_PRIVATE")).length, 1);
  assert.ok(actorTexts.every((text) => /Expected actor ID:\s*\S+/u.test(text)));
  assert.equal(
    (await chats.listMessages(isolated.chat.id)).filter((message: any) => message.role === "assistant").length,
    1,
  );
  const isolatedAssistant = (await chats.listMessages(isolated.chat.id)).find(
    (message: any) => message.role === "assistant",
  );
  const isolatedExtra = JSON.parse(isolatedAssistant.extra);
  assert.equal(isolatedExtra.isolatedGameTurn.promptRequests.length, 3);
  assert.deepEqual(
    isolatedExtra.isolatedGameTurn.promptRequests[0].messages,
    bodies[0].messages.map((message: any) => ({ role: message.role, content: message.content })),
    "Persisted planner request is the actual provider request",
  );
  assert.deepEqual(
    isolatedExtra.isolatedGameTurn.promptRequests
      .slice(1)
      .map((request: any) => request.actorId)
      .sort(),
    [isolated.alice, isolated.bob].sort(),
  );
  assert.equal(isolatedExtra.isolatedGameTurn.promptRequests[0].memoryProjection, undefined);
  for (const request of isolatedExtra.isolatedGameTurn.promptRequests.slice(1)) {
    assert.ok(request.memoryProjection);
    assert.ok(Number.isSafeInteger(request.memoryProjection.includedCount));
    assert.ok(Number.isSafeInteger(request.memoryProjection.excludedCount));
    assert.equal(typeof request.memoryProjection.degraded, "boolean");
    assert.ok(Array.isArray(request.memoryProjection.exclusions));
  }
  assert.ok(bodies.every((body) => !JSON.stringify(body.messages).includes("memoryProjection")));
  assert.deepEqual(
    isolatedExtra.isolatedGameTurn.promptRequests.find((request: any) => request.actorId === isolated.alice)
      .memoryProjection,
    { includedCount: 2, excludedCount: 0, degraded: false, exclusions: [] },
    "A valid holder reports its included entity and knowledge without a false degradation warning",
  );
  assert.deepEqual(
    isolatedExtra.isolatedGameTurn.promptRequests.find((request: any) => request.actorId === isolated.bob)
      .memoryProjection,
    {
      includedCount: 0,
      excludedCount: 1,
      degraded: true,
      exclusions: [{ reason: "character memory holder is unresolved", count: 1 }],
    },
    "An unresolved holder is visible without exposing another character's memory",
  );
  assert.ok(bodies.every((body) => !JSON.stringify(body.messages).includes("character memory holder is unresolved")));
  const peek = await app!.inject({
    method: "POST",
    url: "/api/chats/" + isolated.chat.id + "/peek-prompt",
    payload: {},
  });
  assert.equal(peek.statusCode, 200, peek.body);
  const peekBody = JSON.parse(peek.body);
  assert.equal(peekBody.exact, true);
  assert.deepEqual(peekBody.promptRequests, isolatedExtra.isolatedGameTurn.promptRequests);
  assert.equal(JSON.parse(isolatedAssistant.extra).generationInfo.tokensPrompt, 6);
  assert.equal(JSON.parse(isolatedAssistant.extra).generationInfo.tokensCompletion, 9);
  assert.equal(
    JSON.parse(isolatedAssistant.extra).generationInfo.tokensCachedPrompt,
    3,
    "Known cache reads survive when this provider does not report cache writes",
  );

  const introduction = await makeChat("isolated");
  bodies.length = 0;
  npcSyncRequests.length = 0;
  scenario = "introduction";
  const introductionResponse = await generate(
    introduction.chat.id,
    "Dorian, please introduce the visible household staff by name and role.",
  );
  assert.equal(introductionResponse.statusCode, 200, introductionResponse.body);
  assert.match(introductionResponse.body, /Ada — household steward/u);
  assert.match(introductionResponse.body, /Ameline — resident companion/u);
  assert.equal(bodies.length, 2, "introduction uses the planner plus the requested actor only");
  const introductionPlannerPrompt = bodies[0]!.messages.map((message: any) => message.content).join("\n");
  assert.match(introductionPlannerPrompt, /explicit request authorizes naming/u);
  const introductionActorPrompt = bodies[1]!.messages.map((message: any) => message.content).join("\n");
  assert.match(introductionActorPrompt, /Ada — household steward; Mira — courier/u);
  assert.doesNotMatch(introductionActorPrompt, /GM PRIVATE PLOT|BOB PRIVATE MARKER/u);
  assert.doesNotMatch(introductionResponse.body, /will introduce|prepare to read|opening name/u);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(npcSyncRequests.length, 1, "accepted isolated response schedules exactly one NPC sync");

  const impersonated = await makeChat("isolated");
  const syncsBeforeImpersonated = npcSyncRequests.length;
  const impersonatedResponse = await app!.inject({
    method: "POST",
    url: "/api/generate",
    payload: {
      chatId: impersonated.chat.id,
      userMessage: "I write the next action.",
      connectionId: connection.id,
      streaming: true,
      impersonate: true,
    },
  });
  assert.equal(impersonatedResponse.statusCode, 200, impersonatedResponse.body);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(npcSyncRequests.length, syncsBeforeImpersonated, "impersonated/unsaved turn does not schedule NPC sync");

  const sceneLibrary = await makeSceneLibraryChat();
  bodies.length = 0;
  scenario = "success";
  const sceneLibraryResponse = await generate(sceneLibrary.chat.id, "Please continue the scene.");
  assert.equal(sceneLibraryResponse.statusCode, 200, sceneLibraryResponse.body);
  assert.equal(bodies.length, 4, "complete scene evidence admits the steward and both library NPCs");
  assert.deepEqual(
    new Set(trustedActorIds(bodies[0]!)),
    new Set(["npc:steward", sceneLibrary.firstGuest, sceneLibrary.secondGuest]),
  );
  assert.equal(
    bodies
      .slice(1)
      .map((body) => body.messages.map((message: any) => message.content).join("\n"))
      .filter((text) => text.includes("Expected actor ID:")).length,
    3,
    "planner actor requests are wired to all admitted scene identities",
  );
  const sceneMetadata = await chats.getById(sceneLibrary.chat.id);
  assert.match(sceneMetadata.metadata, /npc:steward/u);
  assert.doesNotMatch(sceneMetadata.metadata, new RegExp(sceneLibrary.firstGuest + "|" + sceneLibrary.secondGuest));

  for (const mode of ["empty", "departure", "duplicate", "persona"] as const) {
    const negative = await makeSceneLibraryChat(mode);
    bodies.length = 0;
    const response = await generate(
      negative.chat.id,
      `${negative.firstGuestName}, please respond from the archive hall.`,
    );
    assert.equal(response.statusCode, 200, response.body);
    const roster = trustedActorIds(bodies[0]!);
    assert.deepEqual(roster, mode === "empty" ? [] : ["npc:steward"]);
    assert.ok(!roster.includes(negative.firstGuest));
    if (mode === "empty" || mode === "departure") {
      assert.ok(!roster.includes(negative.secondGuest));
      assert.equal(
        bodies.length,
        mode === "empty" ? 1 : 2,
        `${mode}: complete scene overrides stale snapshot presence and current user mentions`,
      );
    } else if (mode === "duplicate") {
      assert.ok(!roster.includes(negative.secondGuest));
      assert.equal(bodies.length, 2, "duplicate complete scene omits the ambiguous library identity");
    } else {
      assert.ok(!roster.includes(negative.secondGuest));
      assert.equal(bodies.length, 2, "persona identity is excluded from the trusted roster");
    }
  }

  const incomplete = await makeSceneLibraryChat("incomplete");
  bodies.length = 0;
  const incompleteResponse = await generate(
    incomplete.chat.id,
    `${incomplete.firstGuestName}, continue only if the snapshot supports you.`,
  );
  assert.equal(incompleteResponse.statusCode, 200, incompleteResponse.body);
  assert.deepEqual(trustedActorIds(bodies[0]!), [incomplete.firstGuest]);
  assert.equal(bodies.length, 2, "incomplete timeline uses only the snapshot actor ID");

  const narratorOnly = await makeChat("empty");
  bodies.length = 0;
  scenario = "success";
  const narratorResponse = await generate(narratorOnly.chat.id);
  assert.equal(narratorResponse.statusCode, 200, narratorResponse.body);
  assert.match(narratorResponse.body, /The room is quiet/u);
  assert.equal(bodies.length, 1, "narrator-only isolated turn uses only the planner");

  const invalid = await makeChat("isolated");
  bodies.length = 0;
  scenario = "invalid-plan";
  const invalidResponse = await generate(invalid.chat.id);
  assert.equal(invalidResponse.statusCode, 200);
  assert.doesNotMatch(invalidResponse.body, /type.:.token/u);
  assert.equal(
    (await chats.listMessages(invalid.chat.id)).some((message: any) => message.role === "assistant"),
    false,
  );

  const failed = await makeChat("isolated");
  bodies.length = 0;
  scenario = "actor-failure";
  const failedResponse = await generate(failed.chat.id);
  assert.match(failedResponse.body, /actor_output_unavailable/u);
  assert.doesNotMatch(failedResponse.body, /wrong-actor/u);
  assert.match(failedResponse.body, /The room is quiet/u);

  const missingUsage = await makeChat("isolated");
  bodies.length = 0;
  scenario = "missing-usage";
  const missingUsageResponse = await generate(missingUsage.chat.id);
  assert.equal(missingUsageResponse.statusCode, 200);
  const missingAssistant = (await chats.listMessages(missingUsage.chat.id)).find(
    (message: any) => message.role === "assistant",
  );
  assert.equal(JSON.parse(missingAssistant.extra).generationInfo.usageIncomplete, true);
  assert.equal(
    JSON.parse(missingAssistant.extra).generationInfo.tokensPrompt,
    null,
    "A planner-only subtotal is not presented as full turn usage",
  );
  assert.equal(JSON.parse(missingAssistant.extra).generationInfo.tokensCachedPrompt, null);

  const legacy = await makeChat("legacy");
  bodies.length = 0;
  scenario = "legacy";
  const legacyResponse = await generate(legacy.chat.id);
  assert.equal(legacyResponse.statusCode, 200);
  assert.equal(bodies.length, 1, "legacy mode keeps the existing single provider request");
  assert.doesNotMatch(legacyResponse.body, /type.:.error/u);
  assert.match(legacyResponse.body, /Legacy narrative/u);
  assert.equal(
    (await chats.listMessages(legacy.chat.id)).some((message: any) => message.role === "assistant"),
    true,
  );

  // Main GM path (non-isolated): regenerate/continue receive the campaign-memory block
  // projected at the regenerated message's cutoff: earlier facts stay, later ones are excluded.
  const { readCampaignMemorySources } =
    await import("../../packages/server/src/services/game/campaign-memory-sources.js");
  const cutoffChat = await makeChat("legacy");
  scenario = "legacy";
  await generate(cutoffChat.chat.id);
  const cutoffTarget = (await chats.listMessages(cutoffChat.chat.id)).find(
    (message: any) => message.role === "assistant",
  );
  assert.ok(cutoffTarget);
  const cutoffPrior = (await chats.listMessages(cutoffChat.chat.id)).find((message: any) => message.role === "user");
  assert.ok(cutoffPrior);
  const cutoffLaterUser = await chats.createMessage({
    chatId: cutoffChat.chat.id,
    role: "user",
    content: "LATER_LEGACY_FUTURE",
  } as any);
  await chats.createMessage({
    chatId: cutoffChat.chat.id,
    role: "assistant",
    content: "Later legacy response.",
  } as any);
  const cutoffSources = await readCampaignMemorySources(db, { chatId: cutoffChat.chat.id });
  const cutoffEntity = await memory.createEntity({
    chatId: cutoffChat.chat.id,
    kind: "character",
    owner: { type: "existing", store: "characters", recordId: cutoffChat.alice },
    aliases: ["Alice Route"],
    tags: [],
    attributes: {},
    status: "active",
    manualLock: false,
    provenance: { source: "test", sourceRevision: "test", actor: "user" },
  });
  const cutoffFact = (messageId: string, value: string) => {
    const source = cutoffSources.get(messageId);
    assert.ok(source?.captureOrder, "regression sources must carry a capture order");
    return memory.createFact({
      chatId: cutoffChat.chat.id,
      subjectEntityId: cutoffEntity.entityId,
      predicate: "established",
      value,
      conditions: [],
      status: "verified",
      validFromOrder: source.captureOrder,
      sourceRevision: "test",
      evidence: [{ messageId, quote: source.content.slice(0, 8), sourceHash: source.sourceHash }],
      author: "user",
      provenance: { source: "test", sourceRevision: "test", actor: "user" },
      manualLock: false,
    });
  };
  await cutoffFact(cutoffPrior.id, "EARLY_VERIFIED_MEMORY");
  await cutoffFact(cutoffLaterUser.id, "LATE_VERIFIED_MEMORY");
  for (const payload of [{ regenerateMessageId: cutoffTarget.id }, { continueMessageId: cutoffTarget.id }]) {
    bodies.length = 0;
    const response = await app!.inject({
      method: "POST",
      url: "/api/generate",
      payload: { chatId: cutoffChat.chat.id, connectionId: connection.id, streaming: true, ...payload },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(bodies.length, 1);
    const prompt = bodies[0]!.messages.map((message: any) => message.content).join("\n");
    const label = Object.keys(payload)[0];
    assert.match(prompt, /<campaign_memory audience="gm">/u, `${label} receives the GM campaign-memory block`);
    assert.match(prompt, /EARLY_VERIFIED_MEMORY/u, `${label} keeps a fact established before the target`);
    assert.doesNotMatch(prompt, /LATE_VERIFIED_MEMORY/u, `${label} excludes facts established after the target`);
  }

  const regen = await makeChat("isolated");
  scenario = "success";
  await generate(regen.chat.id);
  const target = (await chats.listMessages(regen.chat.id)).find((message: any) => message.role === "assistant");
  assert.ok(target);
  await chats.updateMessageContent(target.id, "ORIGINAL_TARGET_MARKER");
  const laterUser = await chats.createMessage({
    chatId: regen.chat.id,
    role: "user",
    content: "LATER_PRIVATE_FUTURE",
  } as any);
  await chats.createMessage({
    chatId: regen.chat.id,
    role: "assistant",
    content: "Later response.",
    extra: { encryptedReasoning: ["ENCRYPTED_FUTURE_MARKER"] },
  } as any);
  const bobEntity = await memory.createEntity({
    chatId: regen.chat.id,
    kind: "character",
    owner: { type: "existing", store: "characters", recordId: regen.bob },
    aliases: ["Bob Route"],
    tags: [],
    attributes: {},
    status: "active",
    manualLock: false,
    provenance: { source: "test", sourceRevision: "test", actor: "user" },
    summary: "LATER_CANONICAL_PRIVATE",
  });
  const bobFact = await memory.createFact({
    chatId: regen.chat.id,
    subjectEntityId: bobEntity.entityId,
    predicate: "knows",
    value: "LATER_CANONICAL_PRIVATE",
    conditions: [],
    status: "verified",
    sourceRevision: "test",
    evidence: [{ messageId: laterUser.id, quote: "LATER_PRIVATE_FUTURE" }],
    author: "user",
    provenance: { source: "test", sourceRevision: "test", actor: "user" },
    manualLock: false,
  });
  await memory.createKnowledge({
    chatId: regen.chat.id,
    holderEntityId: bobEntity.entityId,
    factId: bobFact.factId,
    epistemicState: "knows",
    learnedFrom: [{ messageId: laterUser.id, quote: "LATER_PRIVATE_FUTURE" }],
    provenance: { source: "test", sourceRevision: "test", actor: "user" },
    manualLock: false,
  });
  bodies.length = 0;
  const regenerated = await app!.inject({
    method: "POST",
    url: "/api/generate",
    payload: { chatId: regen.chat.id, regenerateMessageId: target.id, connectionId: connection.id, streaming: true },
  });
  assert.equal(regenerated.statusCode, 200, regenerated.body);
  const regenerationPrompt = bodies
    .map((body) => body.messages.map((message: any) => message.content).join("\n"))
    .join("\n");
  assert.doesNotMatch(
    regenerationPrompt,
    /LATER_PRIVATE_FUTURE|LATER_CANONICAL_PRIVATE|ENCRYPTED_FUTURE_MARKER|ORIGINAL_TARGET_MARKER/u,
  );
  const regenerationSwipes = await chats.getSwipes(target.id);
  assert.equal(regenerationSwipes.length, 2, "regeneration adds one swipe to the target");
  assert.equal(regenerationSwipes[0]?.content, "ORIGINAL_TARGET_MARKER");
  assert.equal(
    (await chats.listMessages(regen.chat.id)).filter((message: any) => message.role === "assistant").length,
    2,
  );

  const regenInvalid = await makeChat("isolated");
  scenario = "success";
  await generate(regenInvalid.chat.id);
  const invalidTarget = (await chats.listMessages(regenInvalid.chat.id)).find(
    (message: any) => message.role === "assistant",
  );
  assert.ok(invalidTarget);
  await chats.updateMessageContent(invalidTarget.id, "INVALID_REGEN_ORIGINAL");
  const beforeInvalid = await chats.getSwipes(invalidTarget.id);
  const beforeInvalidActiveSwipe = (await chats.getMessage(invalidTarget.id)).activeSwipeIndex;
  scenario = "invalid-plan";
  const invalidRegen = await app!.inject({
    method: "POST",
    url: "/api/generate",
    payload: {
      chatId: regenInvalid.chat.id,
      regenerateMessageId: invalidTarget.id,
      connectionId: connection.id,
      streaming: true,
    },
  });
  assert.doesNotMatch(invalidRegen.body, /type.:.token/u);
  assert.equal((await chats.getSwipes(invalidTarget.id)).length, beforeInvalid.length);
  assert.equal((await chats.getMessage(invalidTarget.id)).content, "INVALID_REGEN_ORIGINAL");
  assert.equal((await chats.getMessage(invalidTarget.id)).activeSwipeIndex, beforeInvalidActiveSwipe);

  const continuation = await makeChat("isolated");
  scenario = "success";
  await generate(continuation.chat.id);
  const continuationTarget = (await chats.listMessages(continuation.chat.id)).find(
    (message: any) => message.role === "assistant",
  );
  assert.ok(continuationTarget);
  await chats.updateMessageContent(continuationTarget.id, "ORIGINAL_CONTINUE_MARKER");
  const laterContinuationUser = await chats.createMessage({
    chatId: continuation.chat.id,
    role: "user",
    content: "LATER_CONTINUE_FUTURE",
  } as any);
  const laterContinuationAssistant = await chats.createMessage({
    chatId: continuation.chat.id,
    role: "assistant",
    content: "Later continue response.",
    extra: { encryptedReasoning: ["ENCRYPTED_CONTINUE_FUTURE"] },
  } as any);
  const laterContinuationEntity = await memory.createEntity({
    chatId: continuation.chat.id,
    kind: "character",
    owner: { type: "existing", store: "characters", recordId: continuation.bob },
    aliases: ["Bob Route"],
    tags: [],
    attributes: {},
    status: "active",
    manualLock: false,
    provenance: { source: "test", sourceRevision: "test", actor: "user" },
    summary: "LATER_CONTINUE_CANONICAL_PRIVATE",
  });
  const laterContinuationFact = await memory.createFact({
    chatId: continuation.chat.id,
    subjectEntityId: laterContinuationEntity.entityId,
    predicate: "knows",
    value: "LATER_CONTINUE_CANONICAL_PRIVATE",
    conditions: [],
    status: "verified",
    sourceRevision: "test",
    evidence: [{ messageId: laterContinuationUser.id, quote: "LATER_CONTINUE_FUTURE" }],
    author: "user",
    provenance: { source: "test", sourceRevision: "test", actor: "user" },
    manualLock: false,
  });
  await memory.createKnowledge({
    chatId: continuation.chat.id,
    holderEntityId: laterContinuationEntity.entityId,
    factId: laterContinuationFact.factId,
    epistemicState: "knows",
    learnedFrom: [{ messageId: laterContinuationUser.id, quote: "LATER_CONTINUE_FUTURE" }],
    provenance: { source: "test", sourceRevision: "test", actor: "user" },
    manualLock: false,
  });
  await states.create({
    chatId: continuation.chat.id,
    messageId: laterContinuationAssistant.id,
    swipeIndex: 0,
    date: "",
    time: "",
    location: "",
    weather: "",
    temperature: "",
    worldCustomFields: [{ key: "future", value: "LATER_CONTINUE_SNAPSHOT" }],
    presentCharacters: [{ characterId: continuation.alice }, { characterId: continuation.bob }],
    recentEvents: [],
    playerStats: null,
    personaStats: null,
  } as any);
  const continuationBefore = await chats.getMessage(continuationTarget.id);
  bodies.length = 0;
  const continued = await app!.inject({
    method: "POST",
    url: "/api/generate",
    payload: {
      chatId: continuation.chat.id,
      continueMessageId: continuationTarget.id,
      connectionId: connection.id,
      streaming: true,
    },
  });
  assert.equal(continued.statusCode, 200, continued.body);
  const continuationPrompt = bodies
    .map((body) => body.messages.map((message: any) => message.content).join("\n"))
    .join("\n");
  assert.doesNotMatch(
    continuationPrompt,
    /LATER_CONTINUE_FUTURE|LATER_CONTINUE_CANONICAL_PRIVATE|LATER_CONTINUE_SNAPSHOT|ENCRYPTED_CONTINUE_FUTURE/u,
  );
  const actorContinuationPrompt = bodies
    .slice(1)
    .map((body) => body.messages.map((message: any) => message.content).join("\n"))
    .join("\n");
  assert.doesNotMatch(actorContinuationPrompt, /Continue the preceding|ORIGINAL_CONTINUE_MARKER/u);
  const continuationAfter = await chats.getMessage(continuationTarget.id);
  assert.equal(continuationAfter.id, continuationBefore.id);
  assert.equal(continuationAfter.activeSwipeIndex, continuationBefore.activeSwipeIndex);
  assert.match(continuationAfter.content, /ORIGINAL_CONTINUE_MARKER/u);
  assert.equal((continuationAfter.content.match(/ORIGINAL_CONTINUE_MARKER/gu) ?? []).length, 1);
  assert.equal((await chats.getSwipes(continuationTarget.id)).length, 1);
  assert.equal(
    (await chats.listMessages(continuation.chat.id)).filter((message: any) => message.role === "assistant").length,
    2,
  );

  const continuationInvalid = await makeChat("isolated");
  scenario = "success";
  await generate(continuationInvalid.chat.id);
  const continuationInvalidTarget = (await chats.listMessages(continuationInvalid.chat.id)).find(
    (message: any) => message.role === "assistant",
  );
  assert.ok(continuationInvalidTarget);
  await chats.updateMessageContent(continuationInvalidTarget.id, "INVALID_CONTINUE_ORIGINAL");
  const continuationInvalidBefore = await chats.getMessage(continuationInvalidTarget.id);
  scenario = "invalid-plan";
  const invalidContinuation = await app!.inject({
    method: "POST",
    url: "/api/generate",
    payload: {
      chatId: continuationInvalid.chat.id,
      continueMessageId: continuationInvalidTarget.id,
      connectionId: connection.id,
      streaming: true,
    },
  });
  assert.doesNotMatch(invalidContinuation.body, /type.:.token/u);
  const continuationInvalidAfter = await chats.getMessage(continuationInvalidTarget.id);
  assert.equal(continuationInvalidAfter.content, continuationInvalidBefore.content);
  assert.equal(continuationInvalidAfter.activeSwipeIndex, continuationInvalidBefore.activeSwipeIndex);

  const eviction = await makeChat("isolated");
  scenario = "success";
  await generate(eviction.chat.id);
  await generate(eviction.chat.id);
  await generate(eviction.chat.id);
  const evictionAssistants = (await chats.listMessages(eviction.chat.id)).filter(
    (message: any) => message.role === "assistant",
  );
  assert.equal(evictionAssistants.length, 3);
  const evictedExtra = JSON.parse(evictionAssistants[0]!.extra);
  assert.equal(evictedExtra.isolatedGameTurn.promptRequests, null);
  assert.equal(Array.isArray(evictedExtra.isolatedGameTurn.actorDiagnostics), true);
  const retainedExtra = JSON.parse(evictionAssistants[2]!.extra);
  assert.equal(retainedExtra.isolatedGameTurn.promptRequests.length, 3);
  const evictedBeforeRepeat = await chats.getMessage(evictionAssistants[0]!.id);
  await generate(eviction.chat.id);
  const evictedAfterRepeat = await chats.getMessage(evictionAssistants[0]!.id);
  assert.equal(
    evictedAfterRepeat.updatedAt,
    evictedBeforeRepeat.updatedAt,
    "Already-evicted isolated prompt bodies are not rewritten on every later generation",
  );

  const swipeGuard = await makeChat("isolated");
  scenario = "success";
  await generate(swipeGuard.chat.id);
  const swipeTarget = (await chats.listMessages(swipeGuard.chat.id)).find(
    (message: any) => message.role === "assistant",
  );
  assert.ok(swipeTarget);
  const regeneratedSwipe = await app!.inject({
    method: "POST",
    url: "/api/generate",
    payload: {
      chatId: swipeGuard.chat.id,
      regenerateMessageId: swipeTarget.id,
      connectionId: connection.id,
      streaming: true,
    },
  });
  assert.equal(regeneratedSwipe.statusCode, 200, regeneratedSwipe.body);
  const swipeRows = await chats.getSwipes(swipeTarget.id);
  assert.ok(swipeRows.length >= 2);
  const activeSwipe = await chats.getMessage(swipeTarget.id);
  const activeSwipeExtra = JSON.parse(activeSwipe.extra);
  await chats.updateSwipeExtra(swipeTarget.id, activeSwipe.activeSwipeIndex, {
    cachedPrompt: null,
    isolatedGameTurn: {
      mode: "isolated",
      promptRequests: null,
      actorDiagnostics: activeSwipeExtra.isolatedGameTurn.actorDiagnostics,
    },
  });
  await chats.updateMessageExtra(swipeTarget.id, {
    cachedPrompt: null,
    isolatedGameTurn: {
      mode: "isolated",
      promptRequests: null,
      actorDiagnostics: activeSwipeExtra.isolatedGameTurn.actorDiagnostics,
    },
  });
  const selectedSwipePeek = await app!.inject({
    method: "POST",
    url: "/api/chats/" + swipeGuard.chat.id + "/peek-prompt",
    payload: { messageId: swipeTarget.id },
  });
  assert.equal(selectedSwipePeek.statusCode, 404, selectedSwipePeek.body);

  const tooSmallPlanner = await makeChat("isolated");
  await connections.update(connection.id, { maxContext: 128 } as any);
  bodies.length = 0;
  scenario = "success";
  const tooSmallPlannerResponse = await generate(tooSmallPlanner.chat.id);
  assert.equal(tooSmallPlannerResponse.statusCode, 200);
  assert.equal(bodies.length, 0, "Planner context overflow fails before any provider request");
  assert.equal(
    (await chats.listMessages(tooSmallPlanner.chat.id)).some((message: any) => message.role === "assistant"),
    false,
  );

  const oversizedActor = await makeChat("isolated");
  await connections.update(connection.id, { maxContext: 10_000 } as any);
  bodies.length = 0;
  scenario = "oversized-actor";
  const oversizedActorResponse = await generate(oversizedActor.chat.id);
  assert.equal(oversizedActorResponse.statusCode, 200);
  assert.equal(bodies.length, 1, "Only the planner provider request occurs before actor context rejection");
  assert.equal(
    (await chats.listMessages(oversizedActor.chat.id)).some((message: any) => message.role === "assistant"),
    false,
  );

  await Promise.allSettled([...pendingNpcSyncRequests]);
  await closeDB();
  console.log("game isolated turn route regression passed");
} finally {
  if (app) await app.close();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
}
