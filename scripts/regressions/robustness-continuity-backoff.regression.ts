import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Background continuity work must never storm paid model calls:
// 1. the global hourly cap refuses automatic calls locally (connection admission and continuity stages),
// 2. a credential rejection (401, or 403 with credential wording) parks only that chat's work instead of
//    spending every receipt's attempts, and never pauses other chats; a moderation 403 stays the batch's fault,
// 3. a batch's own failure is retried after a per-item delay, not immediately, even when another path
//    re-runs it while the delay is pending, and stop() clears pending retry timers,
// 4. the panel's Retry releases a credential-parked chat at once, and the logs follow the logging pass
//    (delayMs on the job.state warn, errorCode on the park warn, one warn per window, a recovered line),
// 5. a cap refusal of historical backfill pauses backfill only: live receipts still run on the reserved
//    headroom, and stages on a local inference endpoint never book the cap.
const root = mkdtempSync(join(tmpdir(), "marinara-continuity-backoff-"));
const logDir = join(root, "logs");
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.LOG_DIR = logDir;
process.env.LOG_FILE_LEVEL = "debug";
process.env.LOG_LEVEL = "fatal";
type Line = Record<string, any>;
const logLines = (): Line[] => {
  let names: string[] = [];
  try {
    names = readdirSync(logDir).filter((name) => /^marinara-.*\.log/.test(name));
  } catch {
    return [];
  }
  return names
    .flatMap((name) => readFileSync(join(logDir, name), "utf8").split(/\r?\n/))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Line);
};

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityRuntime } = await import("../../packages/server/src/services/game/continuity-runtime.js");
  const { normalizeContinuityError, CONTINUITY_ERROR_CODES, continuityStageBooksBudget } =
    await import("../../packages/server/src/services/game/continuity-provider.js");
  const { LLMHttpError } = await import("../../packages/server/src/services/llm/base-provider.js");
  const budget = await import("../../packages/server/src/services/generation/background-call-budget.js");
  const admission = await import("../../packages/server/src/services/generation/connection-admission.js");
  const { logger } = await import("../../packages/server/src/lib/logger.js");
  const flushLogs = async () => {
    logger.flush?.();
    await new Promise((resolve) => setTimeout(resolve, 250));
    return logLines();
  };

  // --- Budget module: rolling-hour cap, local refusal, env parsing.
  budget.resetBackgroundCallBudgetForTests(2);
  const t0 = Date.UTC(2026, 8, 23, 0, 0, 0);
  assert.equal(budget.tryConsumeBackgroundCall("a", t0).allowed, true);
  assert.equal(budget.tryConsumeBackgroundCall("b", t0 + 1000).allowed, true);
  const refused = budget.tryConsumeBackgroundCall("a", t0 + 2000);
  assert.equal(refused.allowed, false, "third call in the hour is refused");
  assert.ok(!refused.allowed && refused.retryAfterMs === budget.BACKGROUND_CALL_BUDGET_WINDOW_MS - 2000);
  assert.equal(
    budget.tryConsumeBackgroundCall("a", t0 + budget.BACKGROUND_CALL_BUDGET_WINDOW_MS + 1).allowed,
    true,
    "a slot frees once the oldest call ages out",
  );
  budget.resetBackgroundCallBudgetForTests(null);
  const savedEnv = process.env.MARINARA_BACKGROUND_CALLS_PER_HOUR;
  process.env.MARINARA_BACKGROUND_CALLS_PER_HOUR = "off";
  assert.equal(budget.backgroundCallsPerHourLimit(), 0);
  process.env.MARINARA_BACKGROUND_CALLS_PER_HOUR = "nonsense";
  assert.equal(budget.backgroundCallsPerHourLimit(), budget.DEFAULT_BACKGROUND_CALLS_PER_HOUR);
  if (savedEnv === undefined) delete process.env.MARINARA_BACKGROUND_CALLS_PER_HOUR;
  else process.env.MARINARA_BACKGROUND_CALLS_PER_HOUR = savedEnv;

  // --- Connection admission: background work books the cap, foreground never does.
  budget.resetBackgroundCallBudgetForTests(1);
  admission.resetConnectionAdmissionForTests();
  let sent = 0;
  const op = async () => {
    sent += 1;
    return "ok";
  };
  await admission.withConnectionAdmission("budget-conn", { kind: "background" }, op);
  await assert.rejects(
    admission.withConnectionAdmission("budget-conn", { kind: "background" }, op),
    (error: unknown) => error instanceof admission.BackgroundConnectionBusyError && error.reason === "budget",
  );
  assert.equal(sent, 1, "a budget refusal sends no request");
  await admission.withConnectionAdmission("budget-conn", { kind: "foreground" }, op);
  assert.equal(sent, 2, "interactive calls ignore the automatic-call cap");
  admission.resetConnectionAdmissionForTests();
  budget.resetBackgroundCallBudgetForTests(null);

  // --- Error classification: credentials are a connection fault, not a batch fault.
  const code = (error: unknown) => normalizeContinuityError(error).code;
  assert.equal(code(new LLMHttpError("Unauthorized", { status: 401 })), CONTINUITY_ERROR_CODES.PROVIDER_AUTH);
  assert.equal(
    code(new LLMHttpError("Forbidden", { status: 403 })),
    CONTINUITY_ERROR_CODES.STAGE_FAILED,
    "a bare 403 is not proof of a bad key",
  );
  assert.equal(
    code(new LLMHttpError("Your input was flagged by moderation: requires moderation", { status: 403 })),
    CONTINUITY_ERROR_CODES.STAGE_FAILED,
    "a moderation 403 is the batch's own fault and spends attempts",
  );
  assert.equal(
    code(new LLMHttpError("Unauthorized: input flagged by moderation", { status: 403 })),
    CONTINUITY_ERROR_CODES.STAGE_FAILED,
    "moderation wording wins over credential wording",
  );
  assert.equal(
    code(new LLMHttpError("Invalid API key provided", { status: 403 })),
    CONTINUITY_ERROR_CODES.PROVIDER_AUTH,
  );
  assert.equal(
    code(new LLMHttpError("denied", { status: 403, providerCode: "permission_error" })),
    CONTINUITY_ERROR_CODES.PROVIDER_AUTH,
  );
  assert.equal(code(new Error("Error: invalid x-api-key")), CONTINUITY_ERROR_CODES.PROVIDER_AUTH);
  assert.equal(
    code(
      new LLMHttpError("API key not valid. Please pass a valid API key.", {
        status: 400,
        providerCode: "API_KEY_INVALID",
      }),
    ),
    CONTINUITY_ERROR_CODES.PROVIDER_AUTH,
    "a bad Gemini key (HTTP 400, API key not valid) is a credential failure",
  );
  assert.equal(
    code(new LLMHttpError("request rejected", { status: 400, providerCode: "API_KEY_INVALID" })),
    CONTINUITY_ERROR_CODES.PROVIDER_AUTH,
    "the Gemini reason code alone is enough",
  );
  assert.equal(code(new LLMHttpError("slow down", { status: 429 })), CONTINUITY_ERROR_CODES.PROVIDER_LIMITED);
  assert.equal(
    code(new LLMHttpError("You exceeded your usage limit", { status: 403 })),
    CONTINUITY_ERROR_CODES.PROVIDER_LIMITED,
    "a throttling 403 still pauses as a rate limit",
  );
  assert.equal(code(new LLMHttpError("bad request", { status: 400 })), CONTINUITY_ERROR_CODES.STAGE_FAILED);
  assert.equal(code(new LLMHttpError("down", { status: 502 })), CONTINUITY_ERROR_CODES.PROVIDER_UNAVAILABLE);

  // --- Runtime fixtures.
  const db = await createFileNativeDB();
  const t = (seconds: number) => new Date(Date.UTC(2026, 8, 15, 0, 0, seconds)).toISOString();
  await db.insert(apiConnections).values({ id: "conn", name: "Backoff test", provider: "custom", model: "test-model" });
  const addChat = async (id: string) => {
    await db.insert(chats).values({
      id,
      name: id,
      mode: "game",
      connectionId: "conn",
      metadata: JSON.stringify({
        gameContinuity: { mode: "shadow", extractionInstructions: "x", verificationInstructions: "y" },
      }),
      createdAt: t(0),
      updatedAt: t(0),
    });
    await db.insert(messages).values([
      { id: `${id}-u`, chatId: id, role: "user", content: `${id}: I swear to guard the bridge.`, createdAt: t(1) },
      { id: `${id}-a`, chatId: id, role: "assistant", content: `${id}: The guard nods.`, createdAt: t(2) },
    ]);
  };
  const clean = ({ stage, receipt }: { stage: string; receipt: any }) => {
    const dispositions = receipt.sources.map((source: any) => ({
      messageId: source.messageId,
      status: "no_durable_facts",
      reason: "nothing durable",
    }));
    return stage === "extract" ? { records: [], dispositions } : { findings: [], dispositions };
  };
  const waitUntil = async (check: () => Promise<boolean>, timeoutMs = 10_000) => {
    const started = Date.now();
    while (!(await check())) {
      if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const RESUMABLE = ["queued", "extracting", "reviewing", "repairing"];

  // 1. Credential rejection: only the chat with the bad key is parked, with every queued batch of that chat,
  // no attempt is spent, and the healthy chat still runs with no runtime-wide pause.
  await addChat("auth-bad");
  await db.insert(messages).values([
    { id: "auth-bad-u2", chatId: "auth-bad", role: "user", content: "auth-bad: I cross the bridge.", createdAt: t(3) },
    {
      id: "auth-bad-a2",
      chatId: "auth-bad",
      role: "assistant",
      content: "auth-bad: The planks creak.",
      createdAt: t(4),
    },
  ]);
  await addChat("auth-ok");
  let authCalls = 0;
  let keyFixed = false;
  // While set, a healthy chat's call hangs and holds the only worker, so a Retry can land on a credential
  // batch that was released and now waits in the queue instead of the parked set.
  let authGate: Promise<void> | null = null;
  let holdStarted = false;
  const authRuntime = createGameContinuityRuntime(db, {
    maxDrainMs: 2000,
    maxConcurrent: 1,
    providerBackoffMs: { initial: 60_000, max: 60_000 },
    complete: async (args) => {
      if (args.receipt.chatId === "auth-bad" && !keyFixed) {
        authCalls += 1;
        throw normalizeContinuityError(new LLMHttpError("Unauthorized", { status: 401 }));
      }
      if (args.receipt.chatId === "auth-hold" && authGate) {
        holdStarted = true;
        await authGate;
      }
      return clean(args);
    },
  });
  const bad1 = await authRuntime.enqueueCommittedTurn({ chatId: "auth-bad", assistantMessageId: "auth-bad-a" });
  const bad2 = await authRuntime.enqueueCommittedTurn({ chatId: "auth-bad", assistantMessageId: "auth-bad-a2" });
  const ok = await authRuntime.enqueueCommittedTurn({ chatId: "auth-ok", assistantMessageId: "auth-ok-a" });
  assert.ok(bad1 && bad2 && ok && bad1.id !== bad2.id);
  await waitUntil(async () => (await authRuntime.get(ok!.id))?.status === "verified");
  await sleep(200);
  assert.equal(authCalls, 1, `the bad key is tried once, then its chat's queued batches are parked (got ${authCalls})`);
  assert.equal((await authRuntime.get(bad1!.id))?.errorCode, "CONTINUITY_PROVIDER_AUTH");
  for (const id of [bad1!.id, bad2!.id]) {
    const receipt = await authRuntime.get(id);
    assert.equal(receipt?.attempts, 0, "a credential rejection does not spend a batch attempt");
    assert.ok(RESUMABLE.includes(String(receipt?.status)), `receipt stays resumable (got ${receipt?.status})`);
  }
  assert.equal(authRuntime.health().pausedUntil, null, "a bad key in one chat never pauses the whole runtime");
  const authQueue = authRuntime.queueStats();
  assert.equal(authQueue.parkedChats, 1);
  assert.equal(authQueue.parked, 2, "both of the bad chat's batches wait in the parked set");
  assert.equal(authQueue.retryWaiting, 0, "a credential park is not a per-item retry delay");
  assert.equal("pending" in authQueue || "active" in authQueue, false, "pending/active are left to the worker gauge");

  // The park warn: errorCode (not code) under continuity.breaker, logged once however often the chat re-parks.
  let lines = await flushLogs();
  const parkWarns = lines.filter(
    (line) =>
      line.event === "continuity.breaker" &&
      line.chatId === "auth-bad" &&
      line.errorCode === "CONTINUITY_PROVIDER_AUTH",
  );
  assert.equal(parkWarns.length, 1, `one park warn for the bad chat (got ${parkWarns.length})`);
  assert.equal(parkWarns[0]!.level, 40);
  assert.equal(parkWarns[0]!.code, undefined, "the specific code goes in errorCode, never code");
  assert.equal(typeof parkWarns[0]!.repeatKey, "string", "the park warn goes through logRepeated");

  // Re-park: Retry while the key is still bad releases the chat, the first batch fails again and the chat parks
  // again. The second park goes through logRepeated inside its window, so it is suppressed, not a second warn.
  await addChat("auth-hold");
  let openGate: () => void = () => {};
  authGate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  await authRuntime.enqueueCommittedTurn({ chatId: "auth-hold", assistantMessageId: "auth-hold-a" });
  await waitUntil(async () => holdStarted);
  const released = await authRuntime.retry("auth-bad", bad1!.id);
  assert.equal(released?.id, bad1!.id, "Retry on a parked batch releases it");
  assert.equal(authRuntime.queueStats().parked, 0, "the released chat is no longer parked");
  // The header's Retry names the first batch still showing the key error. Released, it waits in the queue
  // behind the held worker: it is not parked any more, and a second press must not read as CONTINUITY_BUSY.
  assert.equal((await authRuntime.get(bad1!.id))?.errorCode, "CONTINUITY_PROVIDER_AUTH");
  const retriedQueued = await authRuntime.retry("auth-bad", bad1!.id);
  assert.equal(retriedQueued?.id, bad1!.id, "Retry on a queued credential batch does not throw CONTINUITY_BUSY");
  openGate();
  authGate = null;
  await waitUntil(async () => authRuntime.queueStats().parked === 2);
  assert.equal(authCalls, 2, "the re-released chat is tried once more, then parked again, not retried in a loop");
  lines = await flushLogs();
  assert.equal(
    lines.filter(
      (line) =>
        line.event === "continuity.breaker" &&
        line.chatId === "auth-bad" &&
        line.errorCode === "CONTINUITY_PROVIDER_AUTH" &&
        line.level === 40,
    ).length,
    1,
    "the re-park inside the window is suppressed by logRepeated, not a second warn",
  );

  // Panel Retry on a parked batch: no CONTINUITY_BUSY, the chat's parked work runs now, and the recovered line follows.
  keyFixed = true;
  const retried = await authRuntime.retry("auth-bad", bad1!.id);
  assert.equal(
    retried?.id,
    bad1!.id,
    "Retry on a credential-parked batch releases it instead of throwing CONTINUITY_BUSY",
  );
  await waitUntil(async () =>
    (await Promise.all([bad1!.id, bad2!.id].map((id) => authRuntime.get(id)))).every((r) => r?.status === "verified"),
  );
  assert.equal(authRuntime.queueStats().parked, 0);
  lines = await flushLogs();
  const recovered = lines.find(
    (line) => line.event === "continuity.breaker" && line.chatId === "auth-bad" && line.state === "recovered",
  );
  assert.ok(recovered, "the first answered stage after the fix writes a recovered line for the park");
  assert.ok(
    Number(recovered.suppressedCount) >= 1,
    `the recovered line counts the suppressed re-park (got ${recovered.suppressedCount})`,
  );
  await authRuntime.stop();

  // 2. Hourly cap: continuity stages book the global budget; refused stages send nothing and spend nothing.
  budget.resetBackgroundCallBudgetForTests(2);
  await addChat("cap-a");
  await addChat("cap-b");
  let capCalls = 0;
  const capRuntime = createGameContinuityRuntime(db, {
    maxDrainMs: 2000,
    complete: async (args) => {
      capCalls += 1;
      return clean(args);
    },
  });
  const capA = await capRuntime.enqueueCommittedTurn({ chatId: "cap-a", assistantMessageId: "cap-a-a" });
  const capB = await capRuntime.enqueueCommittedTurn({ chatId: "cap-b", assistantMessageId: "cap-b-a" });
  assert.ok(capA && capB);
  await waitUntil(async () => capRuntime.health().pauseCode === "CONTINUITY_BACKGROUND_BUDGET");
  await sleep(300);
  assert.equal(capCalls, 2, "no model call is made once the hourly cap is spent");
  let refusedReceipts = 0;
  for (const id of [capA!.id, capB!.id]) {
    const receipt = await capRuntime.get(id);
    if (receipt?.status === "verified") continue;
    refusedReceipts += 1;
    assert.equal(receipt?.errorCode, "CONTINUITY_BACKGROUND_BUDGET");
    assert.equal(receipt?.attempts, 0, "a budget refusal does not spend a batch attempt");
    assert.ok(RESUMABLE.includes(String(receipt?.status)));
  }
  assert.ok(refusedReceipts >= 1, "at least one batch waits for the cap");
  const capHealth = capRuntime.health();
  assert.ok(
    capHealth.pausedUntil && capHealth.pausedUntil > Date.now() + 50 * 60_000,
    "the runtime waits for the oldest call to age out of the hour",
  );
  await capRuntime.stop();
  budget.resetBackgroundCallBudgetForTests(null);

  // 2b. Backfill never makes live turns wait: with the backfill share of the cap spent, the historical batch is
  // refused locally and only backfill admission pauses; a live receipt queued behind it still runs.
  budget.resetBackgroundCallBudgetForTests(5);
  for (let index = 0; index < 3; index += 1) budget.tryConsumeBackgroundCall("other-worker");
  await db.insert(chats).values({
    id: "hist",
    name: "hist",
    mode: "game",
    connectionId: "conn",
    metadata: JSON.stringify({
      gameContinuity: { mode: "off", extractionInstructions: "x", verificationInstructions: "y" },
    }),
    createdAt: t(0),
    updatedAt: t(0),
  });
  await db.insert(messages).values([
    { id: "hist-u", chatId: "hist", role: "user", content: "hist: I light the beacon.", createdAt: t(1) },
    { id: "hist-a", chatId: "hist", role: "assistant", content: "hist: The flame catches.", createdAt: t(2) },
    { id: "hist-u2", chatId: "hist", role: "user", content: "hist: I wait.", createdAt: t(3) },
  ]);
  await addChat("live-turn");
  const shareCalls: string[] = [];
  const shareRuntime = createGameContinuityRuntime(db, {
    maxDrainMs: 2000,
    backfillBudgetShare: 0.6,
    complete: async (args) => {
      shareCalls.push(args.receipt.id);
      return clean(args);
    },
  });
  const history = await shareRuntime.enqueueHistoricalRange({
    chatId: "hist",
    backfillId: "share-backfill",
    fromMessageId: "hist-u",
    toMessageId: "hist-a",
  });
  const historyIds = history.receipts.map((receipt: any) => receipt.id as string);
  assert.ok(historyIds.length > 0 && historyIds.every((id) => id.startsWith("gch_")), "backfill queued");
  await waitUntil(async () => (await shareRuntime.get(historyIds[0]!))?.errorCode === "CONTINUITY_BACKGROUND_BUDGET");
  const shareHealth = shareRuntime.health();
  assert.equal(shareHealth.pausedUntil, null, "a backfill refusal never pauses the whole runtime");
  assert.ok(shareHealth.backfillPausedUntil, "backfill admission waits for its share of the cap");
  const live = await shareRuntime.enqueueCommittedTurn({ chatId: "live-turn", assistantMessageId: "live-turn-a" });
  assert.ok(live);
  await waitUntil(async () => (await shareRuntime.get(live!.id))?.status === "verified");
  assert.equal(
    shareCalls.filter((id) => id.startsWith("gch_")).length,
    0,
    "the refused backfill sent no request while the live receipt ran",
  );
  const heldHistory = await shareRuntime.get(historyIds[0]!);
  assert.equal(heldHistory?.attempts, 0, "a backfill budget refusal does not spend an attempt");
  assert.ok(RESUMABLE.includes(String(heldHistory?.status)), "the backfill batch stays resumable");
  assert.equal(budget.backgroundCallBudgetSnapshot().used, 5, "the live receipt booked the reserved headroom");
  await shareRuntime.stop();
  budget.resetBackgroundCallBudgetForTests(null);

  // 2c. Local inference endpoints are exempt from the cap, which only guards paid calls; a remote agents
  // fallback behind a local primary books it again, since a failed local call can switch to a paid one.
  await db.insert(apiConnections).values([
    { id: "local-url", name: "Local URL", provider: "custom", model: "m", baseUrl: "http://127.0.0.1:5001/v1" },
    {
      id: "local-flag",
      name: "Local flag",
      provider: "custom",
      model: "m",
      baseUrl: "https://inference.example.com/v1",
      treatAsLocalEndpoint: "true",
    },
    { id: "remote", name: "Remote", provider: "custom", model: "m", baseUrl: "https://api.example.com/v1" },
  ]);
  const stageReceipt = (connectionId: string) =>
    ({
      id: "gcb_probe",
      config: {
        extractor: { connectionId, model: "m", provider: "custom" },
        verifier: { connectionId, model: "m", provider: "custom" },
      },
    }) as any;
  assert.equal(await continuityStageBooksBudget(db, stageReceipt("local-url"), "extract"), false);
  assert.equal(await continuityStageBooksBudget(db, stageReceipt("local-flag"), "review"), false);
  assert.equal(await continuityStageBooksBudget(db, stageReceipt("remote"), "extract"), true);
  assert.equal(await continuityStageBooksBudget(db, stageReceipt("missing"), "extract"), true, "unknown books");
  await db.insert(apiConnections).values({
    id: "paid-fallback",
    name: "Paid fallback",
    provider: "custom",
    model: "m",
    baseUrl: "https://api.example.com/v1",
    fallbackForAgents: "true",
  });
  assert.equal(
    await continuityStageBooksBudget(db, stageReceipt("local-url"), "extract"),
    true,
    "a local primary with a remote agents fallback books the cap",
  );

  // 3. Per-item backoff: a batch's own failure is retried after its delay, not straight away.
  await addChat("item");
  const extractAt: number[] = [];
  const DELAY = 300;
  const itemRuntime = createGameContinuityRuntime(db, {
    maxDrainMs: 2000,
    itemRetryDelayMs: { initial: DELAY, max: DELAY * 4 },
    complete: async (args) => {
      if (args.stage === "extract") {
        extractAt.push(Date.now());
        if (extractAt.length === 1) throw new Error("CONTINUITY_INVALID: simulated malformed extraction");
      }
      return clean(args);
    },
  });
  const item = await itemRuntime.enqueueCommittedTurn({ chatId: "item", assistantMessageId: "item-a" });
  assert.ok(item);
  await waitUntil(async () => (await itemRuntime.get(item!.id))?.status === "verified");
  assert.equal(extractAt.length, 2);
  const gap = extractAt[1]! - extractAt[0]!;
  // Jitter is +/-20%, so the first retry lands no sooner than 0.8 x the initial delay.
  assert.ok(gap >= DELAY * 0.8 - 20, `retry waited for its backoff (${gap}ms)`);
  assert.equal((await itemRuntime.get(item!.id))?.attempts, 2);
  await itemRuntime.stop();

  // 4. Bypass guard: another path (resumeChat) re-runs a batch while its retry timer is pending and the run
  // fails again. The requeue must wait for the pending timer instead of running straight away.
  await addChat("bypass");
  const bypassAt: number[] = [];
  const BYPASS_DELAY = 1500;
  const bypassRuntime = createGameContinuityRuntime(db, {
    maxDrainMs: 2000,
    itemRetryDelayMs: { initial: BYPASS_DELAY, max: BYPASS_DELAY },
    complete: async (args) => {
      if (args.stage === "extract") {
        bypassAt.push(Date.now());
        if (bypassAt.length <= 2) throw new Error("CONTINUITY_INVALID: simulated malformed extraction");
      }
      return clean(args);
    },
  });
  const bypass = await bypassRuntime.enqueueCommittedTurn({ chatId: "bypass", assistantMessageId: "bypass-a" });
  assert.ok(bypass);
  await waitUntil(async () => bypassAt.length === 1 && (await bypassRuntime.get(bypass!.id))?.attempts === 1);
  await sleep(50);
  await bypassRuntime.resumeChat("bypass");
  await waitUntil(async () => (await bypassRuntime.get(bypass!.id))?.status === "verified");
  assert.equal(bypassAt.length, 3);
  const afterSecond = bypassAt[2]! - bypassAt[1]!;
  const afterFirst = bypassAt[2]! - bypassAt[0]!;
  assert.ok(afterSecond >= 150, `the second failure did not requeue immediately (${afterSecond}ms)`);
  assert.ok(afterFirst >= BYPASS_DELAY * 0.8 - 20, `the pending timer did the requeue (${afterFirst}ms)`);
  await bypassRuntime.stop();

  // 5. stop() clears a pending per-item retry timer.
  await addChat("stopper");
  const STOP_DELAY = 4000;
  const capturedTimers: Array<{ ms: number; handle: NodeJS.Timeout }> = [];
  const realSetTimeout = globalThis.setTimeout;
  let stopExtracts = 0;
  const stopRuntime = createGameContinuityRuntime(db, {
    maxDrainMs: 2000,
    itemRetryDelayMs: { initial: STOP_DELAY, max: STOP_DELAY },
    complete: async (args) => {
      if (args.stage === "extract") {
        stopExtracts += 1;
        throw new Error("CONTINUITY_INVALID: simulated malformed extraction");
      }
      return clean(args);
    },
  });
  (globalThis as any).setTimeout = (fn: (...args: any[]) => void, ms?: number, ...rest: any[]) => {
    const handle = realSetTimeout(fn, ms, ...rest);
    capturedTimers.push({ ms: Number(ms ?? 0), handle });
    return handle;
  };
  let retryTimer: NodeJS.Timeout | undefined;
  try {
    const stopper = await stopRuntime.enqueueCommittedTurn({ chatId: "stopper", assistantMessageId: "stopper-a" });
    assert.ok(stopper);
    await waitUntil(async () => {
      retryTimer = capturedTimers.find((entry) => entry.ms >= STOP_DELAY * 0.8 && entry.ms <= STOP_DELAY * 1.2)?.handle;
      return Boolean(retryTimer);
    });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(stopExtracts, 1);
  assert.equal((retryTimer as any)._destroyed, false, "the retry timer is pending before stop()");
  assert.equal(stopRuntime.queueStats().retryWaiting, 1, "a batch waiting on its retry delay is counted");
  // Retry on a batch that waits on its own delay (not parked) is still refused as busy.
  const waitingId = (await stopRuntime.list("stopper"))[0]!.id;
  await assert.rejects(stopRuntime.retry("stopper", waitingId), /CONTINUITY_BUSY/);
  const retryWarn = (await flushLogs()).find(
    (line) => line.event === "job.state" && line.jobId === waitingId && line.willRetry === true,
  );
  assert.ok(retryWarn, "the failed attempt writes one job.state line");
  assert.equal(retryWarn.level, 40, "a scheduled retry is warn");
  assert.ok(
    retryWarn.delayMs >= STOP_DELAY * 0.8 && retryWarn.delayMs <= STOP_DELAY * 1.2,
    `the job.state warn carries the retry delay (${retryWarn.delayMs})`,
  );
  assert.equal(
    (await flushLogs()).some((line) => /retrying in/.test(String(line.msg ?? ""))),
    false,
    "no separate printf retry line",
  );
  await stopRuntime.stop();
  assert.equal((retryTimer as any)._destroyed, true, "stop() clears the pending retry timer");

  // 6. The memory panel names both new codes instead of the generic "Something went wrong". The panel's
  // classification rules are replayed in source order against the receipt texts the runtime writes.
  const panelPath = join(import.meta.dirname, "../../packages/client/src/components/game/GameContinuityPanel.tsx");
  const panel = readFileSync(panelPath, "utf8");
  const body = panel.slice(panel.indexOf("function problemKind("), panel.indexOf("function problemText("));
  const rules = [...body.matchAll(/if \(\/(.+?)\/([a-z]*)\.test\(value\)\) return "(\w+)";/g)].map(
    ([, source, flags, kind]) => ({ pattern: new RegExp(source!, flags), kind: kind! }),
  );
  assert.ok(rules.length >= 10, "the panel's problemKind rules were found");
  const classify = (errorCode: string, error: string) =>
    rules.find((rule) => rule.pattern.test(`${errorCode} ${error}`))?.kind ?? "generic";
  const runtimeSource = readFileSync(
    join(import.meta.dirname, "../../packages/server/src/services/game/continuity-runtime.ts"),
    "utf8",
  );
  const authText = /"(The extraction or review connection rejected its credentials[^"]*)"/.exec(runtimeSource)?.[1];
  const capText = /"(Automatic model calls reached the hourly cap[^"]*)"/.exec(runtimeSource)?.[1];
  assert.ok(authText && capText, "the runtime's receipt texts were found");
  assert.equal(classify("CONTINUITY_PROVIDER_AUTH", authText!), "credentials");
  assert.equal(classify("CONTINUITY_BACKGROUND_BUDGET", capText!), "budget");
  assert.equal(classify("CONTINUITY_STAGE_FAILED", "request failed"), "requestFailed", "older codes keep their kind");
  // A credential-parked batch is resumable, so the row shows Retry for it, and the header offers Retry too.
  assert.match(
    panel,
    /activeStatuses\.has\(batch\.status\) &&\s*problemKind\(batch\.errorCode, batch\.error\) === "credentials"/,
  );
  assert.match(panel, /health === "credentials" && blockingProblem\.credentialsBatchId/);
  const locale = JSON.parse(
    readFileSync(join(import.meta.dirname, "../../packages/client/src/localization/locales/en.json"), "utf8"),
  );
  for (const key of ["problem", "health", "explain"])
    for (const kind of ["credentials", "budget"])
      assert.equal(typeof locale[`ui.game.continuityPanel.${key}.${kind}`], "string", `${key}.${kind} is translated`);

  console.log("robustness continuity backoff regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
