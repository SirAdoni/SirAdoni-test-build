// Scratch integration proof retained from the 2026-09-30 local review.
// Repro command is in session-recaps-handoff.md. Do not target a real provider.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.env.RECAPS_CLONE ?? resolve(fileURLToPath(new URL("../..", import.meta.url)));
const local = (path) => pathToFileURL(resolve(root, path)).href;
const dataDir = mkdtempSync(join(tmpdir(), "marinara-session-recaps-api-proof-"));
Object.assign(process.env, {
  DATA_DIR: dataDir,
  FILE_STORAGE_DIR: join(dataDir, "storage"),
  NODE_ENV: "test",
  MARINARA_LITE: "true",
  LOG_LEVEL: "silent",
});
const serverRequire = createRequire(resolve(root, "packages/server/package.json"));
const Fastify = serverRequire("fastify");
const [
  { getDB, closeDB },
  { gameRoutes },
  { createChatsStorage },
  { createConnectionsStorage },
  { resetFeatureSettingsForTests },
] = await Promise.all([
  import(local("packages/server/src/db/connection.ts")),
  import(local("packages/server/src/routes/game.routes.ts")),
  import(local("packages/server/src/services/storage/chats.storage.ts")),
  import(local("packages/server/src/services/storage/connections.storage.ts")),
  import(local("packages/server/src/services/features/feature-settings.ts")),
]);

let scenario = "valid";
let requestCount = 0;
let raceTargetChatId = "";
let raceInjected = false;
let reviewGate: { notify: () => void; released: Promise<void> } | null = null;
let lateWriteChatId = "";
let reviewResponseReadyForWrite = false;
let reviewResponseCompletedForWrite = false;
let lateWriteToggleTriggered = false;
let notifyLateWriteRead: (() => void) | null = null;
let releaseLateWriteRead: (() => void) | null = null;
let lateWriteReadReleased: Promise<void> = Promise.resolve();
const validDraft = {
  summary: {
    summary: "The fixture party reached the bridge.",
    resumePoint: "At the bridge.",
    partyDynamics: "Calm.",
    partyState: "Ready.",
    keyDiscoveries: [],
    characterMoments: [],
    littleDetails: [],
    npcUpdates: [],
    statsSnapshot: {},
  },
  storyArc: null,
  plotTwists: [],
  partyArcs: [],
  characterCards: [],
  morale: 50,
};
const restartedDraft = '{"summary":{"summary":"abandoned prefix then a new attempt ' + JSON.stringify(validDraft);
const truncatedDraft = '{"summary":{"summary":"The output stopped before its JSON closed.';
let chats;
const mockProvider = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const payload = JSON.parse(Buffer.concat(chunks).toString());
  const prompt = (payload.messages ?? []).map((message) => String(message.content ?? "")).join("\n");
  requestCount += 1;

  if (scenario === "malformed") {
    responseContent(response, "{}");
    return;
  }
  if (prompt.includes("FACTUAL REVIEW PHASE")) {
    const gate = reviewGate;
    if (gate) {
      reviewGate = null;
      gate.notify();
      await gate.released;
    }
    if (scenario === "review-late-off") {
      responseContent(
        response,
        JSON.stringify({
          corrections: [
            {
              path: ["summary", "summary"],
              before: validDraft.summary.summary,
              after: "This reviewed change must be discarded after opt-out.",
              reason: "Synthetic late-toggle proof.",
              quote: "The party reached the bridge before dusk.",
            },
          ],
          additions: [],
          decisionChecks: [],
        }),
      );
      return;
    }
    if (scenario === "review-write-late-off") {
      reviewResponseReadyForWrite = true;
      responseContent(
        response,
        JSON.stringify({
          corrections: [
            {
              path: ["summary", "summary"],
              before: validDraft.summary.summary,
              after: "This reviewed change must not persist after write-boundary opt-out.",
              reason: "Synthetic write-boundary toggle proof.",
              quote: "The party reached the bridge before dusk.",
            },
          ],
          additions: [],
          decisionChecks: [],
        }),
      );
      reviewResponseCompletedForWrite = true;
      return;
    }
    if (scenario === "review-failure") {
      responseContent(
        response,
        JSON.stringify({
          corrections: [
            {
              path: ["summary", "summary"],
              before: validDraft.summary.summary,
              after: "An invented correction.",
              reason: "Synthetic unsupported claim.",
              quote: "This phrase is absent from the transcript.",
            },
          ],
          additions: [],
          decisionChecks: [],
        }),
      );
    } else {
      responseContent(response, JSON.stringify({ corrections: [], additions: [], decisionChecks: [] }));
    }
    return;
  }
  if (scenario === "stale-write" && !raceInjected) {
    raceInjected = true;
    await chats.patchMetadata(raceTargetChatId, (metadata) => ({
      gamePreviousSessionSummaries: metadata.gamePreviousSessionSummaries.map((summary) => ({
        ...summary,
        summary: { ...summary.summary, summary: "Preserve the concurrent human edit." },
      })),
    }));
  }
  if (scenario === "restart") {
    responseContent(response, restartedDraft);
    return;
  }
  if (scenario === "truncated") {
    responseContent(response, truncatedDraft);
    return;
  }
  if (scenario === "length-restart") {
    responseContent(response, restartedDraft, "length");
    return;
  }
  responseContent(response, JSON.stringify(validDraft));
});
function responseContent(response, content, finishReason = "stop") {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      id: `local-${requestCount}`,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
    }),
  );
}

const db = await getDB();
chats = createChatsStorage(db);
const wrapReadQuery = (query: any): any =>
  new Proxy(query, {
    get(target, property) {
      if (property === "then" && typeof target.then === "function") {
        return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          target.then(async (rows: unknown) => {
            if (reviewResponseReadyForWrite && lateWriteChatId) {
              reviewResponseReadyForWrite = false;
              lateWriteToggleTriggered = true;
              if (!notifyLateWriteRead || !releaseLateWriteRead) throw new Error("Late-write gate was not armed");
              notifyLateWriteRead();
              await lateWriteReadReleased;
            }
            return resolve(rows);
          }, reject);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? (...args: unknown[]) => wrapReadQuery(value.apply(target, args)) : value;
    },
  });
const appDb = new Proxy(db, {
  get(target, property) {
    const value = Reflect.get(target, property, target);
    if (property === "select" && typeof value === "function") {
      return (...args: unknown[]) => wrapReadQuery(value.apply(target, args));
    }
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const app = Fastify({ logger: false });
app.decorate("db", appDb);
try {
  await new Promise((resolveListen, rejectListen) =>
    mockProvider.listen(0, "127.0.0.1", (error) => (error ? rejectListen(error) : resolveListen())),
  );
  const address = mockProvider.address();
  assert.ok(address && typeof address === "object");
  const connection = await createConnectionsStorage(db).create({
    name: "Local synthetic fixture",
    provider: "custom",
    model: "fixture",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "fixture-only",
  });
  await app.register(gameRoutes, { prefix: "/api/game" });
  const newChat = async (name) => {
    const chat = await chats.create({ name, mode: "game", connectionId: connection.id, characterIds: [] });
    await chats.createMessage({
      chatId: chat.id,
      role: "user",
      characterId: null,
      content: "The party reached the bridge before dusk.",
    });
    return chat;
  };

  // The registry's missing-value default is off: all four operations keep their baseline
  // behavior without spending a second provider request on factual review.
  resetFeatureSettingsForTests({});
  scenario = "valid";
  const optOutConclusionChat = await newChat("Synthetic factual-review opt-out conclusion");
  requestCount = 0;
  const optOutConclusion = await app.inject({
    method: "POST",
    url: "/api/game/session/conclude",
    payload: { chatId: optOutConclusionChat.id, connectionId: connection.id, streaming: false, nextSessionRequest: "" },
  });
  assert.equal(optOutConclusion.statusCode, 200, optOutConclusion.body);
  assert.equal(requestCount, 1, "opt-out keeps conclusion generation and skips factual review");

  requestCount = 0;
  const optOutRegeneration = await app.inject({
    method: "POST",
    url: "/api/game/session/regenerate-conclusion",
    payload: { chatId: optOutConclusionChat.id, connectionId: connection.id, sessionNumber: 1, streaming: false },
  });
  assert.equal(optOutRegeneration.statusCode, 200, optOutRegeneration.body);
  assert.equal(requestCount, 1, "opt-out keeps regeneration and skips factual review");

  scenario = "malformed";
  const optOutRepairChat = await newChat("Synthetic factual-review opt-out repair");
  requestCount = 0;
  const optOutRepairDraft = await app.inject({
    method: "POST",
    url: "/api/game/session/conclude",
    payload: { chatId: optOutRepairChat.id, connectionId: connection.id, streaming: false, nextSessionRequest: "" },
  });
  assert.equal(optOutRepairDraft.statusCode, 422, optOutRepairDraft.body);
  assert.equal(requestCount, 1, "malformed baseline output still returns a repair draft without factual review");
  scenario = "valid";
  requestCount = 0;
  const optOutRepairApply = await app.inject({
    method: "POST",
    url: "/api/game/session/conclude/apply-json",
    payload: { ...optOutRepairDraft.json().jsonRepair.applyBody, rawJson: JSON.stringify(validDraft) },
  });
  assert.equal(optOutRepairApply.statusCode, 200, optOutRepairApply.body);
  assert.equal(requestCount, 0, "apply-json uses no provider when factual review is off");

  scenario = "malformed";
  const optOutRegenerationRepairDraft = await app.inject({
    method: "POST",
    url: "/api/game/session/regenerate-conclusion",
    payload: { chatId: optOutConclusionChat.id, connectionId: connection.id, sessionNumber: 1, streaming: false },
  });
  assert.equal(optOutRegenerationRepairDraft.statusCode, 422, optOutRegenerationRepairDraft.body);
  requestCount = 0;
  scenario = "valid";
  const optOutRegenerationRepairApply = await app.inject({
    method: "POST",
    url: "/api/game/session/regenerate-conclusion/apply-json",
    payload: { ...optOutRegenerationRepairDraft.json().jsonRepair.applyBody, rawJson: JSON.stringify(validDraft) },
  });
  assert.equal(optOutRegenerationRepairApply.statusCode, 200, optOutRegenerationRepairApply.body);
  assert.equal(requestCount, 0, "regenerate apply-json uses no provider when factual review is off");

  // Enabling the one registry flag preserves current factual-review behavior. If it turns off
  // while the extra request is pending, discard only the optional reviewed result and apply the
  // original baseline draft instead.
  resetFeatureSettingsForTests({ recapFactualReview: true });
  scenario = "review-late-off";
  requestCount = 0;
  const lateOptOutChat = await newChat("Synthetic late factual-review opt-out");
  let notifyReviewStarted!: () => void;
  let releaseReview!: () => void;
  const reviewStarted = new Promise<void>((resolve) => {
    notifyReviewStarted = resolve;
  });
  const reviewReleased = new Promise<void>((resolve) => {
    releaseReview = resolve;
  });
  reviewGate = { notify: notifyReviewStarted, released: reviewReleased };
  const pendingLateOptOut = app.inject({
    method: "POST",
    url: "/api/game/session/conclude",
    payload: { chatId: lateOptOutChat.id, connectionId: connection.id, streaming: false, nextSessionRequest: "" },
  });
  await reviewStarted;
  resetFeatureSettingsForTests({ recapFactualReview: false });
  releaseReview();
  const lateOptOut = await pendingLateOptOut;
  assert.equal(lateOptOut.statusCode, 200, lateOptOut.body);
  assert.equal(requestCount, 2, "an already-running baseline generation is not cancelled by late opt-out");
  assert.equal(
    JSON.parse((await chats.getById(lateOptOutChat.id)).metadata).gamePreviousSessionSummaries[0].summary,
    validDraft.summary.summary,
    "the optional review result is discarded after the setting turns off",
  );

  resetFeatureSettingsForTests({ recapFactualReview: true });
  scenario = "review-write-late-off";
  requestCount = 0;
  reviewResponseReadyForWrite = false;
  reviewResponseCompletedForWrite = false;
  lateWriteToggleTriggered = false;
  const writeBoundaryOptOutChat = await newChat("Synthetic write-boundary factual-review opt-out");
  lateWriteChatId = writeBoundaryOptOutChat.id;
  const lateWriteReadStarted = new Promise<void>((resolve) => {
    notifyLateWriteRead = resolve;
  });
  lateWriteReadReleased = new Promise<void>((resolve) => {
    releaseLateWriteRead = resolve;
  });
  const pendingWriteBoundaryOptOut = app.inject({
    method: "POST",
    url: "/api/game/session/conclude",
    payload: {
      chatId: writeBoundaryOptOutChat.id,
      connectionId: connection.id,
      streaming: false,
      nextSessionRequest: "",
    },
  });
  await lateWriteReadStarted;
  resetFeatureSettingsForTests({ recapFactualReview: false });
  releaseLateWriteRead();
  const completedWriteBoundaryOptOut = await pendingWriteBoundaryOptOut;
  lateWriteChatId = "";
  assert.equal(completedWriteBoundaryOptOut.statusCode, 200, completedWriteBoundaryOptOut.body);
  assert.equal(reviewResponseCompletedForWrite, true, "the mock review response completed before the write boundary");
  assert.equal(lateWriteToggleTriggered, true, "the flag turns off immediately before metadata mutation");
  assert.equal(
    requestCount,
    2,
    "late write-boundary opt-out does not cancel baseline generation or review already sent",
  );
  assert.equal(
    JSON.parse((await chats.getById(writeBoundaryOptOutChat.id)).metadata).gamePreviousSessionSummaries[0].summary,
    validDraft.summary.summary,
    "a completed review correction is discarded when opt-out occurs before persistence",
  );

  resetFeatureSettingsForTests({ recapFactualReview: true });

  const conclusionChat = await newChat("Synthetic conclusion");
  scenario = "valid";
  requestCount = 0;
  const conclusion = await app.inject({
    method: "POST",
    url: "/api/game/session/conclude",
    payload: { chatId: conclusionChat.id, connectionId: connection.id, streaming: false, nextSessionRequest: "" },
  });
  assert.equal(conclusion.statusCode, 200, conclusion.body);
  assert.equal(requestCount, 2, "one conclusion generation and one factual review");
  const savedConclusion = JSON.parse((await chats.getById(conclusionChat.id)).metadata);
  assert.equal(savedConclusion.gamePreviousSessionSummaries[0].summary, validDraft.summary.summary);

  scenario = "restart";
  requestCount = 0;
  const restartedConclusionChat = await newChat("Synthetic restarted conclusion");
  const restartedConclusion = await app.inject({
    method: "POST",
    url: "/api/game/session/conclude",
    payload: {
      chatId: restartedConclusionChat.id,
      connectionId: connection.id,
      streaming: false,
      nextSessionRequest: "",
    },
  });
  assert.equal(restartedConclusion.statusCode, 200, restartedConclusion.body);
  assert.equal(requestCount, 2, "the restarted conclusion is salvaged and reviewed");

  scenario = "restart";
  requestCount = 0;
  const restartedRegeneration = await app.inject({
    method: "POST",
    url: "/api/game/session/regenerate-conclusion",
    payload: { chatId: conclusionChat.id, connectionId: connection.id, sessionNumber: 1, streaming: false },
  });
  assert.equal(restartedRegeneration.statusCode, 200, restartedRegeneration.body);
  assert.equal(requestCount, 2, "the restarted regeneration is salvaged and reviewed");

  scenario = "truncated";
  const truncatedConclusionChat = await newChat("Synthetic truncated conclusion");
  const truncatedConclusion = await app.inject({
    method: "POST",
    url: "/api/game/session/conclude",
    payload: {
      chatId: truncatedConclusionChat.id,
      connectionId: connection.id,
      streaming: false,
      nextSessionRequest: "",
    },
  });
  assert.equal(truncatedConclusion.statusCode, 422, truncatedConclusion.body);
  assert.equal(truncatedConclusion.json().jsonRepair, undefined, "truly truncated output is rejected, not repairable");

  scenario = "length-restart";
  const lengthRegeneration = await app.inject({
    method: "POST",
    url: "/api/game/session/regenerate-conclusion",
    payload: { chatId: conclusionChat.id, connectionId: connection.id, sessionNumber: 1, streaming: false },
  });
  assert.equal(lengthRegeneration.statusCode, 422, lengthRegeneration.body);
  assert.equal(
    lengthRegeneration.json().jsonRepair,
    undefined,
    "length-finished output is rejected even after restart salvage",
  );

  scenario = "stale-write";
  requestCount = 0;
  raceInjected = false;
  raceTargetChatId = conclusionChat.id;
  const regenerated = await app.inject({
    method: "POST",
    url: "/api/game/session/regenerate-conclusion",
    payload: { chatId: conclusionChat.id, connectionId: connection.id, sessionNumber: 1, streaming: false },
  });
  assert.equal(regenerated.statusCode, 409, regenerated.body);
  const savedConcurrentEdit = JSON.parse((await chats.getById(conclusionChat.id)).metadata);
  assert.equal(
    savedConcurrentEdit.gamePreviousSessionSummaries[0].summary.summary,
    "Preserve the concurrent human edit.",
  );

  scenario = "malformed";
  const malformedChat = await newChat("Synthetic malformed conclusion");
  const malformed = await app.inject({
    method: "POST",
    url: "/api/game/session/conclude",
    payload: { chatId: malformedChat.id, connectionId: connection.id, streaming: false, nextSessionRequest: "" },
  });
  assert.equal(malformed.statusCode, 422, malformed.body);
  assert.ok(malformed.json().jsonRepair);

  scenario = "review-failure";
  const repairedAfterReviewFailure = await app.inject({
    method: "POST",
    url: "/api/game/session/conclude/apply-json",
    payload: { ...malformed.json().jsonRepair.applyBody, rawJson: JSON.stringify(validDraft) },
  });
  assert.equal(repairedAfterReviewFailure.statusCode, 422, repairedAfterReviewFailure.body);
  assert.equal(repairedAfterReviewFailure.json().jsonRepair, undefined, "edited JSON cannot bypass factual review");
  assert.equal(JSON.parse((await chats.getById(malformedChat.id)).metadata).gamePreviousSessionSummaries, undefined);

  scenario = "valid";
  requestCount = 0;
  const repairedConclusion = await app.inject({
    method: "POST",
    url: "/api/game/session/conclude/apply-json",
    payload: { ...malformed.json().jsonRepair.applyBody, rawJson: JSON.stringify(validDraft) },
  });
  assert.equal(repairedConclusion.statusCode, 200, repairedConclusion.body);
  assert.equal(requestCount, 1, "a syntax repair still receives factual review before it saves");
  assert.equal(
    JSON.parse((await chats.getById(malformedChat.id)).metadata).gamePreviousSessionSummaries[0].summary,
    validDraft.summary.summary,
  );

  scenario = "review-failure";
  const rejectedChat = await newChat("Synthetic factual review rejection");
  const rejected = await app.inject({
    method: "POST",
    url: "/api/game/session/conclude",
    payload: { chatId: rejectedChat.id, connectionId: connection.id, streaming: false, nextSessionRequest: "" },
  });
  assert.equal(rejected.statusCode, 422, rejected.body);
  assert.equal(rejected.json().jsonRepair, undefined, "review failures do not open syntax repair");
  assert.equal(JSON.parse((await chats.getById(rejectedChat.id)).metadata).gamePreviousSessionSummaries, undefined);

  scenario = "malformed";
  const rejectedRegenerationRepair = await app.inject({
    method: "POST",
    url: "/api/game/session/regenerate-conclusion",
    payload: {
      chatId: restartedConclusionChat.id,
      connectionId: connection.id,
      sessionNumber: 1,
      streaming: false,
    },
  });
  assert.equal(rejectedRegenerationRepair.statusCode, 422, rejectedRegenerationRepair.body);
  const rejectedRegenerationRepairBody = rejectedRegenerationRepair.json().jsonRepair.applyBody;
  assert.match(rejectedRegenerationRepairBody.summaryFingerprint, /^[a-f0-9]{64}$/u);
  const summaryBeforeRejectedRegenerationRepair = JSON.parse((await chats.getById(restartedConclusionChat.id)).metadata)
    .gamePreviousSessionSummaries[0];
  scenario = "review-failure";
  const rejectedRegenerationRepairApply = await app.inject({
    method: "POST",
    url: "/api/game/session/regenerate-conclusion/apply-json",
    payload: { ...rejectedRegenerationRepairBody, rawJson: JSON.stringify(validDraft) },
  });
  assert.equal(rejectedRegenerationRepairApply.statusCode, 422, rejectedRegenerationRepairApply.body);
  assert.equal(
    rejectedRegenerationRepairApply.json().jsonRepair,
    undefined,
    "regenerated JSON repair cannot bypass factual review",
  );
  assert.match(JSON.stringify(rejectedRegenerationRepairApply.json()), /factual review failed/u);
  assert.deepEqual(
    JSON.parse((await chats.getById(restartedConclusionChat.id)).metadata).gamePreviousSessionSummaries[0],
    summaryBeforeRejectedRegenerationRepair,
    "a rejected regenerated repair preserves the previous target summary",
  );

  scenario = "malformed";
  const staleRepair = await app.inject({
    method: "POST",
    url: "/api/game/session/regenerate-conclusion",
    payload: { chatId: conclusionChat.id, connectionId: connection.id, sessionNumber: 1, streaming: false },
  });
  assert.equal(staleRepair.statusCode, 422, staleRepair.body);
  const staleRepairBody = staleRepair.json().jsonRepair.applyBody;
  assert.equal(typeof staleRepairBody.summaryFingerprint, "string");
  await chats.patchMetadata(conclusionChat.id, (metadata) => ({
    gamePreviousSessionSummaries: metadata.gamePreviousSessionSummaries.map((summary) => ({
      ...summary,
      summary: { ...summary.summary, summary: "Preserve the edit made while repair was open." },
    })),
  }));
  scenario = "valid";
  requestCount = 0;
  const staleRepairApply = await app.inject({
    method: "POST",
    url: "/api/game/session/regenerate-conclusion/apply-json",
    payload: { ...staleRepairBody, rawJson: JSON.stringify(validDraft) },
  });
  assert.equal(staleRepairApply.statusCode, 409, staleRepairApply.body);
  assert.equal(requestCount, 0, "stale repair is rejected before another factual-review provider call");
  assert.equal(
    JSON.parse((await chats.getById(conclusionChat.id)).metadata).gamePreviousSessionSummaries[0].summary.summary,
    "Preserve the edit made while repair was open.",
  );

  process.stdout.write(
    JSON.stringify({
      conclusionStatus: conclusion.statusCode,
      conclusionProviderCalls: 2,
      optOutConclusionProviderCalls: 1,
      optOutRepairProviderCalls: 0,
      lateOptOutRejectedReview: true,
      lateWriteBoundaryOptOutRejectedReview: true,
      staleRegenerationStatus: regenerated.statusCode,
      restartedConclusionStatus: restartedConclusion.statusCode,
      restartedRegenerationStatus: restartedRegeneration.statusCode,
      truncatedConclusionStatus: truncatedConclusion.statusCode,
      lengthRegenerationStatus: lengthRegeneration.statusCode,
      concurrentSummaryPreserved: true,
      malformedOutputStatus: malformed.statusCode,
      factualReviewRejectionStatus: rejected.statusCode,
      repairedFactualReviewRejectionStatus: repairedAfterReviewFailure.statusCode,
      repairedRegenerationReviewRejectionStatus: rejectedRegenerationRepairApply.statusCode,
      repairedConclusionStatus: repairedConclusion.statusCode,
      staleRepairStatus: staleRepairApply.statusCode,
      rejectedSummaryPersisted: false,
    }) + "\n",
  );
} finally {
  resetFeatureSettingsForTests({});
  await app.close();
  await new Promise((resolveClose) => mockProvider.close(resolveClose));
  await closeDB();
  rmSync(dataDir, { recursive: true, force: true });
}
