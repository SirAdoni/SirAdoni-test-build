import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import type { GameContinuityReceipt } from "@marinara-engine/shared";

// Stage timeouts are configurable with a fixed precedence, every failure thrown out of a
// continuity stage carries a stable code, and per-stage telemetry persists append-only.
const root = mkdtempSync(join(tmpdir(), "marinara-continuity-provider-errors-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
// Deleting these would let the Engine's dotenv load a local .env override when server modules are imported;
// "0" stays set, is ignored as a timeout, and leaves every stage on its built-in default.
process.env.CONTINUITY_STAGE_TIMEOUT_MS = "0";
process.env.CONTINUITY_EXTRACT_TIMEOUT_MS = "0";
process.env.CONTINUITY_REVIEW_TIMEOUT_MS = "0";
process.env.CONTINUITY_REPAIR_TIMEOUT_MS = "0";

const server = createServer((_request, _response) => {
  /* never answers: the continuity stage timer must fire */
});
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats } = await import("../../packages/server/src/db/schema/index.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { LLMHttpError } = await import("../../packages/server/src/services/llm/base-provider.js");
  const provider = await import("../../packages/server/src/services/game/continuity-provider.js");
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const {
    CONTINUITY_ERROR_CODES,
    DEFAULT_CONTINUITY_STAGE_TIMEOUT_MS,
    completeContinuityStage,
    normalizeContinuityError,
    readContinuityConfig,
    readContinuityStageTelemetry,
    recordContinuityTelemetry,
    resolveContinuityStageTimeoutMs,
  } = provider;

  // 1. Timeout precedence: defaults, env (all stages), env (per stage), metadata number, metadata per stage.
  const resolve = (stage: "extract" | "review" | "repair", metadata: unknown, env: Record<string, string> = {}) =>
    resolveContinuityStageTimeoutMs(stage, metadata, env);
  assert.deepEqual(DEFAULT_CONTINUITY_STAGE_TIMEOUT_MS, { extract: 600_000, review: 300_000, repair: 300_000 });
  assert.equal(resolve("extract", undefined), 600_000, "extract default");
  assert.equal(resolve("review", undefined), 300_000, "review default");
  assert.equal(resolve("repair", undefined), 300_000, "repair default");
  assert.equal(resolve("extract", undefined, { CONTINUITY_STAGE_TIMEOUT_MS: "1000" }), 1000, "env all stages");
  assert.equal(
    resolve("extract", undefined, { CONTINUITY_STAGE_TIMEOUT_MS: "1000", CONTINUITY_EXTRACT_TIMEOUT_MS: "2000" }),
    2000,
    "per-stage env beats all-stage env",
  );
  assert.equal(
    resolve("review", undefined, { CONTINUITY_STAGE_TIMEOUT_MS: "1000", CONTINUITY_EXTRACT_TIMEOUT_MS: "2000" }),
    1000,
    "per-stage env only affects its stage",
  );
  assert.equal(resolve("extract", 3000, { CONTINUITY_EXTRACT_TIMEOUT_MS: "2000" }), 3000, "metadata beats env");
  assert.equal(resolve("extract", { extract: 4000 }, { CONTINUITY_EXTRACT_TIMEOUT_MS: "2000" }), 4000, "metadata map");
  assert.equal(resolve("review", { extract: 4000 }, { CONTINUITY_STAGE_TIMEOUT_MS: "1000" }), 1000, "map falls back");
  assert.equal(resolve("extract", "oops", { CONTINUITY_STAGE_TIMEOUT_MS: "nope" }), 600_000, "invalid ignored");
  assert.equal(resolve("extract", -5, { CONTINUITY_STAGE_TIMEOUT_MS: "0" }), 600_000, "non-positive ignored");

  // 2. Stable codes from representative thrown errors.
  const codeOf = (error: unknown, hints?: Parameters<typeof normalizeContinuityError>[1]) => {
    const normalized = normalizeContinuityError(error, hints);
    assert.equal(normalized.message, normalized.code, "message must equal the stable code");
    assert.match(normalized.code, /^CONTINUITY_[A-Z_]+$/u);
    return normalized;
  };
  const timeout = codeOf(new Error("This operation was aborted"), { timedOut: true });
  assert.equal(timeout.code, CONTINUITY_ERROR_CODES.TIMEOUT);
  assert.equal(timeout.detail, "This operation was aborted");
  assert.equal(codeOf(new LLMHttpError("429 rate limited", { status: 429 })).code, "CONTINUITY_PROVIDER_LIMITED");
  assert.equal(codeOf(new LLMHttpError("529 overloaded", { status: 529 })).code, "CONTINUITY_PROVIDER_LIMITED");
  assert.equal(
    codeOf(new LLMHttpError("503 bare outage", { status: 503 })).code,
    CONTINUITY_ERROR_CODES.PROVIDER_UNAVAILABLE,
  );
  assert.equal(
    codeOf(new LLMHttpError("500 internal", { status: 500 })).code,
    CONTINUITY_ERROR_CODES.PROVIDER_UNAVAILABLE,
  );
  const fetchFailed = new TypeError("fetch failed");
  (fetchFailed as Error & { cause?: unknown }).cause = Object.assign(new Error("connect ECONNRESET"), {
    code: "ECONNRESET",
  });
  assert.equal(codeOf(fetchFailed).code, CONTINUITY_ERROR_CODES.PROVIDER_UNAVAILABLE, "network cause");
  assert.equal(codeOf(new Error("terminated")).code, CONTINUITY_ERROR_CODES.PROVIDER_UNAVAILABLE, "undici terminated");
  assert.equal(
    codeOf(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }), { aborted: true }).code,
    CONTINUITY_ERROR_CODES.ABORTED,
    "runtime stop",
  );
  assert.equal(codeOf(new Error("CONTINUITY_INVALID_JSON")).code, CONTINUITY_ERROR_CODES.INVALID_JSON);
  assert.equal(codeOf(new SyntaxError("Unexpected token } in JSON")).code, CONTINUITY_ERROR_CODES.INVALID_JSON);
  const invalid = codeOf(new Error("CONTINUITY_INVALID: record temporary quote is not present in source msg-7"));
  assert.equal(invalid.code, CONTINUITY_ERROR_CODES.INVALID, "embedded ids leave the code");
  assert.equal(invalid.detail, "CONTINUITY_INVALID: record temporary quote is not present in source msg-7");
  for (const message of [
    "prompt is too long: 213462 tokens > 200000 maximum",
    "input length and `max_tokens` exceed context limit: 199000 + 4000 > 200000",
    "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
    "context_length_exceeded",
  ]) {
    assert.equal(
      codeOf(new LLMHttpError(`400 ${message}`, { status: 400 })).code,
      CONTINUITY_ERROR_CODES.CONTEXT_OVERFLOW,
      message,
    );
  }
  assert.equal(codeOf(new Error("CONTINUITY_CONTEXT_OVERFLOW")).code, CONTINUITY_ERROR_CODES.CONTEXT_OVERFLOW);
  assert.equal(codeOf(new Error("CONTINUITY_CONFIG_CHANGED")).code, "CONTINUITY_CONFIG_CHANGED", "pass-through");
  const eperm = codeOf(new Error("EPERM: operation not permitted, rename 'C:\\\\x.json.tmp-1'"));
  assert.equal(eperm.code, CONTINUITY_ERROR_CODES.STAGE_FAILED);
  assert.match(eperm.detail ?? "", /EPERM/u);
  assert.equal(codeOf("plain string").code, CONTINUITY_ERROR_CODES.STAGE_FAILED);
  const again = normalizeContinuityError(timeout);
  assert.equal(again, timeout, "already normalized errors are returned unchanged");

  // 3. Live timeout path: a stub server that never answers surfaces CONTINUITY_TIMEOUT with telemetry.
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const db = await createFileNativeDB();
  const now = new Date().toISOString();
  await db.insert(apiConnections).values({
    id: "stub",
    name: "Stub",
    provider: "openai",
    model: "stub-model",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKeyEncrypted: "dummy-secret",
    maxContext: 8192,
    createdAt: now,
    updatedAt: now,
  });
  const metadata = { gameContinuity: { mode: "shadow", extractorConnectionId: "stub", verifierConnectionId: "stub" } };
  await db.insert(chats).values({
    id: "chat-1",
    name: "Timeout chat",
    mode: "game",
    connectionId: "stub",
    metadata: JSON.stringify(metadata),
    createdAt: now,
    updatedAt: now,
  });
  const baseline = await readContinuityConfig(db, "chat-1");
  assert.deepEqual(baseline.stageTimeoutMs, DEFAULT_CONTINUITY_STAGE_TIMEOUT_MS);
  await db
    .update(chats)
    .set({
      metadata: JSON.stringify({ gameContinuity: { ...metadata.gameContinuity, stageTimeoutMs: { extract: 400 } } }),
    })
    .where(eq(chats.id, "chat-1"));
  const configured = await readContinuityConfig(db, "chat-1");
  assert.equal(configured.hash, baseline.hash, "stageTimeoutMs must stay out of the frozen config hash");
  assert.equal(configured.stageTimeoutMs.extract, 400);
  assert.equal(configured.stageTimeoutMs.review, 300_000);
  assert.equal("stageTimeoutMs" in configured.frozen, false);

  const receipt: GameContinuityReceipt = {
    id: "receipt-timeout",
    chatId: "chat-1",
    sessionNumber: 1,
    sourceHash: "source",
    sources: [],
    context: [],
    configHash: configured.hash,
    config: configured.frozen,
    status: "extracting",
    attempts: 2,
    repairAttempts: 0,
    records: [],
    dispositions: [],
    review: null,
    entryIds: [],
    createdAt: now,
    updatedAt: now,
  };
  const startedAt = Date.now();
  await assert.rejects(
    () => completeContinuityStage(db, receipt, "extract", "{}"),
    (error: any) => {
      assert.equal(error.code, CONTINUITY_ERROR_CODES.TIMEOUT);
      assert.equal(error.message, CONTINUITY_ERROR_CODES.TIMEOUT);
      assert.equal(error.telemetry?.stage, "extract");
      assert.equal(error.telemetry?.attempt, 2);
      assert.ok(error.telemetry.elapsedMs >= 350, `elapsed ${error.telemetry.elapsedMs}`);
      assert.ok(typeof error.telemetry.providerMs === "number");
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 10_000, "the configured 400 ms timeout must apply, not the default");
  const stopped = new AbortController();
  const pending = completeContinuityStage(db, { ...receipt, id: "receipt-stop" }, "extract", "{}", stopped.signal);
  setTimeout(() => stopped.abort(new Error("runtime stop")), 50);
  await assert.rejects(pending, (error: any) => error.code === CONTINUITY_ERROR_CODES.ABORTED);

  // 4. Telemetry persistence is append-only at the storage level.
  const storage = createGameContinuityStorage(db);
  const queued: GameContinuityReceipt = { ...receipt, id: "receipt-telemetry", status: "queued", attempts: 0 };
  await storage.enqueue(queued);
  const entry = (stage: string, attempt: number) => ({
    stage,
    startedAt: now,
    elapsedMs: 120,
    providerMs: 100,
    usage: { inputTokens: 10, outputTokens: 5 },
    attempt,
  });
  assert.equal(await recordContinuityTelemetry(storage, queued.id, entry("extract", 1)), true);
  assert.equal(await recordContinuityTelemetry(storage, queued.id, entry("review", 1)), true);
  assert.equal(await recordContinuityTelemetry(storage, "missing", entry("extract", 1)), false);
  assert.equal(await recordContinuityTelemetry(storage, queued.id, { stage: "" } as any), false, "invalid entry");
  // A checkpoint written from an older in-memory receipt (no telemetry field) keeps the recorded entries.
  await storage.save({ ...queued, status: "extracting", attempts: 1, updatedAt: new Date().toISOString() });
  await db._fileStore.close();
  const reopened = createGameContinuityStorage(await createFileNativeDB());
  const stored = (await reopened.get(queued.id)) as any;
  assert.equal(stored.status, "extracting");
  assert.deepEqual(
    stored.telemetry.map((item: any) => [item.stage, item.attempt, item.usage.inputTokens]),
    [
      ["extract", 1, 10],
      ["review", 1, 10],
    ],
    "telemetry survives reopen and a stale checkpoint",
  );
  await reopened.save({ ...stored, telemetry: [stored.telemetry[0]] });
  assert.equal(((await reopened.get(queued.id)) as any).telemetry.length, 2, "entries are never removed");
  await recordContinuityTelemetry(reopened, queued.id, entry("review", 1));
  assert.equal(((await reopened.get(queued.id)) as any).telemetry.length, 2, "identical entries are not duplicated");
  await recordContinuityTelemetry(reopened, queued.id, entry("review", 2));
  assert.equal(((await reopened.get(queued.id)) as any).telemetry.length, 3, "a new attempt appends");
  assert.equal(readContinuityStageTelemetry({ records: [] }), undefined);

  server.close();
  // A subscription provider can answer 200 with a throttling payload, so the refusal arrives as prose
// rather than a typed 429. It must still pause the runtime instead of spending the batch's attempts.
for (const text of [
  "Claude (Subscription) request failed (success) — You've hit your session limit · resets 8:30am (Asia/Jerusalem); rate_limit",
  "Request throttled: too many requests",
  "usage limit reached for this account",
  "quota exceeded",
]) {
  const normalized = normalizeContinuityError(new Error(text));
  assert.equal(
    normalized.message,
    "CONTINUITY_PROVIDER_LIMITED",
    `prose throttling must pause rather than fail: ${text.slice(0, 40)}`,
  );
}
// Context-length refusals mention a limit too, and must NOT be mistaken for throttling.
assert.equal(
  normalizeContinuityError(new Error("prompt is too long: 250000 tokens > 200000 maximum")).message,
  "CONTINUITY_CONTEXT_OVERFLOW",
  "a context-length refusal is not throttling",
);

console.log("continuity provider errors regression passed");
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}
