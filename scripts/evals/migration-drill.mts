/** Isolated migration drill (audit task 9). Never touches live storage.
 * Copies packages/server/data/storage into a temp DATA_DIR, boots an in-process Fastify app with a
 * stubbed continuity runtime (no provider calls), records counts, runs the campaign-memory legacy
 * owner registration (import preview + apply) for every game chat, verifies invariants, exercises the
 * compensation path, writes .tmp/v3-execution/migration-drill.result.json and deletes the temp copy.
 * Run from the repo root, e.g.
 *   NODE_OPTIONS=--max-old-space-size=16384 node node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/cli.mjs scripts/evals/migration-drill.mts
 * Optional: MIGRATION_DRILL_SOURCE=<storage dir> to drill a different copy.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const startedAt = Date.now();
const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const sourceStorage = resolve(process.env.MIGRATION_DRILL_SOURCE ?? join(repoRoot, "packages/server/data/storage"));
const resultPath = join(repoRoot, ".tmp/v3-execution/migration-drill.result.json");
if (!existsSync(join(sourceStorage, "manifest.json"))) throw new Error(`No storage manifest under ${sourceStorage}`);

const root = mkdtempSync(join(tmpdir(), "marinara-migration-drill-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";

const timings: Record<string, number> = {};
const time = async <T>(label: string, work: () => Promise<T> | T): Promise<T> => {
  const t0 = Date.now();
  try {
    return await work();
  } finally {
    timings[label] = Date.now() - t0;
  }
};
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const fingerprint = (rows: Array<Record<string, unknown>>, keys: string[]) =>
  sha(
    rows
      .map((row) => keys.map((key) => `${key}=${String(row[key] ?? "")}`).join(String.fromCharCode(31)))
      .sort()
      .join("\n"),
  );

const requireServer = createRequire(join(repoRoot, "packages/server/package.json"));
const Fastify = requireServer("fastify");

const report: Record<string, unknown> = { drill: "migration-drill", startedAt: new Date(startedAt).toISOString(), sourceStorage, tempDataDir: root };
let closeDB: (() => Promise<void>) | null = null;
let app: { close(): Promise<void>; inject(options: Record<string, unknown>): Promise<any> } | null = null;

try {
  // 1. Isolated copy. Primaries only: .bak/.prepaint shadows and writer-lease dirs are not data.
  await time("copyMs", () => {
    cpSync(sourceStorage, process.env.FILE_STORAGE_DIR!, {
      recursive: true,
      filter: (src) => {
        const name = basename(src);
        return !name.endsWith(".bak") && !name.endsWith(".prepaint") && !name.startsWith(".writer-lease");
      },
    });
  });

  const { getDB, closeDB: close } = await import("../../packages/server/src/db/connection.js");
  closeDB = close;
  const schema = await import("../../packages/server/src/db/schema/index.js");
  const { chatsRoutes } = await import("../../packages/server/src/routes/chats.routes.js");
  const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");
  const { campaignMemoryRoutes } = await import("../../packages/server/src/routes/campaign-memory.routes.js");
  const { campaignMemoryWriteRoutes } = await import("../../packages/server/src/routes/campaign-memory-write.routes.js");

  const db = await time("bootDbMs", () => getDB());

  // Stubbed continuity runtime: satisfies the game route wiring without any provider or queue activity.
  const stubbedRuntime = {
    config: async () => ({ mode: "off" as const }),
    get: async () => null,
    retry: async () => {
      throw new Error("continuity runtime is stubbed in the migration drill");
    },
    reconcileChat: async () => ({ reconciled: 0 }),
    resumeChat: async () => ({ resumed: 0 }),
    enqueueCommittedTurn: async () => null,
    isIncrementalActive: async () => false,
    start: async () => undefined,
    stop: async () => undefined,
  };
  let sessionSummaryRefresh: unknown = null;
  app = await time("bootAppMs", async () => {
    const instance = Fastify();
    instance.decorate("db", db);
    instance.decorate("gameContinuity", stubbedRuntime);
    instance.decorate("sessionSummaryRefresh", {
      getter: () => sessionSummaryRefresh,
      setter: (value: unknown) => {
        sessionSummaryRefresh = value;
      },
    });
    await instance.register(chatsRoutes, { prefix: "/api/chats" });
    await instance.register(gameRoutes, { prefix: "/api/game" });
    await instance.register(campaignMemoryRoutes, { prefix: "/api/game" });
    await instance.register(campaignMemoryWriteRoutes, { prefix: "/api/game" });
    await instance.ready();
    return instance;
  });

  const snapshot = async () => {
    const chatRows = await db.select().from(schema.chats);
    const messageRows = await db.select().from(schema.messages);
    const receiptRows = await db.select().from(schema.gameContinuityBatches);
    const entityRows = await db.select().from(schema.campaignMemoryEntities);
    const factRows = await db.select().from(schema.campaignMemoryFacts);
    const journalRows = await db.select().from(schema.campaignMemoryMutationJournal);
    return {
      counts: {
        chats: chatRows.length,
        gameChats: chatRows.filter((row: any) => row.mode === "game").length,
        messages: messageRows.length,
        receipts: receiptRows.length,
        entities: entityRows.length,
        facts: factRows.length,
        journal: journalRows.length,
      },
      fingerprints: {
        chats: fingerprint(chatRows, ["id", "name", "mode", "characterIds", "metadata", "updatedAt"]),
        messages: fingerprint(messageRows, ["id", "chatId", "role", "content", "activeSwipeIndex", "extra", "createdAt"]),
        receipts: fingerprint(receiptRows, ["id", "chatId", "status", "records", "dispositions", "entryIds", "updatedAt"]),
        facts: fingerprint(factRows, ["factId", "chatId", "status", "value", "revision"]),
      },
      gameChatIds: chatRows.filter((row: any) => row.mode === "game").map((row: any) => row.id as string),
      entityIds: new Set(entityRows.map((row: any) => row.entityId as string)),
    };
  };

  const before = await time("snapshotBeforeMs", snapshot);
  report.before = before.counts;

  // 2. Owner registration for every game chat: the existing legacy import (preview, then apply).
  const registrations: Array<Record<string, unknown>> = [];
  const createdByChat = new Map<string, string[]>();
  await time("registrationMs", async () => {
    for (const chatId of before.gameChatIds) {
      const operationId = `migration-drill:${chatId}`;
      const preview = await app!.inject({ method: "POST", url: `/api/game/${chatId}/memory/import/preview`, payload: { operationId } });
      if (preview.statusCode !== 200) {
        registrations.push({ chatId, previewStatus: preview.statusCode, error: preview.json() });
        continue;
      }
      const plan = preview.json();
      const apply = await app!.inject({
        method: "POST",
        url: `/api/game/${chatId}/memory/import`,
        payload: { operationId, expectedSourceHash: plan.manifest.legacySourceHash },
      });
      const body = apply.json();
      registrations.push({
        chatId,
        previewStatus: preview.statusCode,
        applyStatus: apply.statusCode,
        operationId,
        counts: body?.manifest?.counts ?? plan.manifest.counts,
        held: body?.heldEntityIds?.length ?? plan.heldEntityIds.length,
        skippedExisting: body?.skippedExistingEntityIds?.length ?? plan.skippedExistingEntityIds.length,
        created: body?.createdEntityIds?.length ?? 0,
        ...(apply.statusCode !== 200 ? { error: body } : {}),
      });
      if (apply.statusCode === 200) createdByChat.set(chatId, body.createdEntityIds as string[]);
    }
  });
  report.registrations = registrations;
  const failed = registrations.filter((row) => row.applyStatus !== 200);
  assert.equal(failed.length, 0, `registration failed for ${failed.map((row) => row.chatId).join(", ")}`);

  // Idempotence: re-applying the first registration replays rather than creating.
  const firstChat = before.gameChatIds[0];
  if (firstChat) {
    const operationId = `migration-drill:${firstChat}`;
    const preview = await app.inject({ method: "POST", url: `/api/game/${firstChat}/memory/import/preview`, payload: { operationId } });
    const replay = await app.inject({
      method: "POST",
      url: `/api/game/${firstChat}/memory/import`,
      payload: { operationId, expectedSourceHash: preview.json().manifest.legacySourceHash },
    });
    assert.equal(replay.statusCode, 200);
    report.replay = { chatId: firstChat, counts: replay.json().manifest.counts };
    assert.equal(replay.json().manifest.counts.created, 0, "replay must not create entities");
  }

  // 3. Invariants.
  const after = await time("snapshotAfterMs", snapshot);
  report.after = after.counts;
  assert.equal(after.counts.chats, before.counts.chats, "chat count changed");
  assert.equal(after.counts.messages, before.counts.messages, "message count changed");
  assert.equal(after.counts.receipts, before.counts.receipts, "receipt count changed");
  assert.equal(after.fingerprints.chats, before.fingerprints.chats, "chat rows changed");
  assert.equal(after.fingerprints.messages, before.fingerprints.messages, "message rows changed");
  assert.equal(after.fingerprints.receipts, before.fingerprints.receipts, "receipt rows changed");
  assert.equal(after.fingerprints.facts, before.fingerprints.facts, "fact rows changed");
  assert.ok(after.counts.entities >= before.counts.entities, "entity count decreased");
  const createdTotal = [...createdByChat.values()].reduce((sum, ids) => sum + ids.length, 0);
  assert.equal(after.counts.entities - before.counts.entities, createdTotal, "entity delta must equal created ids");
  for (const ids of createdByChat.values()) for (const id of ids) assert.ok(after.entityIds.has(id), `created entity ${id} missing`);
  report.invariants = {
    chatsUnchanged: true,
    messagesUnchanged: true,
    receiptsUnchanged: true,
    factsUnchanged: true,
    entityDelta: after.counts.entities - before.counts.entities,
    journalDelta: after.counts.journal - before.counts.journal,
  };

  // 4. Compensation path on one registration operation.
  const target =
    [...createdByChat.entries()].find(([, ids]) => ids.length > 0) ??
    (await (async () => {
      for (const chatId of before.gameChatIds) {
        const list = await app!.inject({ method: "GET", url: `/api/game/${chatId}/memory/entities?limit=1` });
        if (list.statusCode === 200 && list.json().items.length) return [chatId, [list.json().items[0].entityId as string]] as const;
      }
      return null;
    })());
  assert.ok(target, "no entity available for the compensation drill");
  const [chatId, [entityId, secondEntityId]] = target;
  // Create compensation is CAS-protected against the create's own result revision, so it targets an entity
  // that has not been mutated since registration (the second created id when available).
  const createTargetId = secondEntityId ?? entityId;
  const compensation: Record<string, unknown> = { chatId, updateEntityId: entityId, createEntityId: createTargetId };
  await time("compensationMs", async () => {
    // 4a. Journaled update on the registered entity, then compensate it and prove the record reverts.
    const read = async () => {
      const response = await app!.inject({ method: "GET", url: `/api/game/${chatId}/memory/entities/${entityId}` });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      return (body.entity ?? body) as Record<string, any>;
    };
    const original = await read();
    const comparable = (entity: Record<string, any>) => ({
      aliases: entity.aliases,
      tags: entity.tags,
      summary: entity.summary,
      attributes: entity.attributes,
      status: entity.status,
      manualLock: entity.manualLock,
    });
    const updateOperationId = `migration-drill:${entityId}:update`;
    const update = await app!.inject({
      method: "POST",
      url: `/api/game/${chatId}/memory/mutations`,
      payload: {
        operationId: updateOperationId,
        action: "update",
        recordType: "entity",
        recordId: entityId,
        expectedRevision: original.revision,
        reason: "migration drill: reversible tag",
        patch: { tags: [...(original.tags ?? []), "migration-drill"] },
      },
    });
    assert.equal(update.statusCode, 200, JSON.stringify(update.json()));
    const updated = await read();
    assert.ok(updated.tags.includes("migration-drill"));
    assert.equal(updated.revision, original.revision + 1);
    const undo = await app!.inject({
      method: "POST",
      url: `/api/game/${chatId}/memory/mutations/compensate`,
      payload: { operationId: `${updateOperationId}:compensate`, originalOperationId: updateOperationId, reason: "migration drill: revert tag" },
    });
    assert.equal(undo.statusCode, 200, JSON.stringify(undo.json()));
    const reverted = await read();
    assert.deepEqual(comparable(reverted), comparable(original), "compensation did not restore the original fields");
    assert.equal(reverted.revision, original.revision + 2);
    // The audit route pages at 100 rows; the drill chat holds thousands, so read the journal table directly.
    const journalRows = await db.select().from(schema.campaignMemoryMutationJournal);
    const journalRow = journalRows.find((row: any) => row.chatId === chatId && row.operationId === `${updateOperationId}:compensate`);
    assert.ok(journalRow, "compensation journal row missing");
    assert.equal(journalRow.compensationOperationId, updateOperationId);
    compensation.updateCompensation = {
      updateOperationId,
      revisions: { original: original.revision, updated: updated.revision, reverted: reverted.revision },
      fieldsRestored: true,
      journaled: true,
    };
    // 4b. Direct compensation of the registration create itself (journaled create): storage has no delete, so the entity is neutralised as archived.
    const createOperationId = `migration-drill:${chatId}:entity:${createTargetId}`;
    const direct = await app!.inject({
      method: "POST",
      url: `/api/game/${chatId}/memory/mutations/compensate`,
      payload: { operationId: `${createOperationId}:compensate`, originalOperationId: createOperationId, reason: "migration drill: retract registration" },
    });
    const directBody = direct.json();
    compensation.createCompensation = {
      status: direct.statusCode,
      entityId: createTargetId,
      resultStatus: directBody?.status ?? directBody?.entity?.status,
      resultRevision: directBody?.revision ?? directBody?.entity?.revision,
      ...(direct.statusCode !== 200 ? { error: directBody } : {}),
    };
    const stillThere = await app!.inject({ method: "GET", url: `/api/game/${chatId}/memory/entities/${createTargetId}` });
    compensation.createCompensationEntityStatus = stillThere.statusCode === 200 ? stillThere.json().entity?.status ?? stillThere.json().status : stillThere.statusCode;
    assert.equal(direct.statusCode, 200, JSON.stringify(directBody));
    assert.equal(compensation.createCompensationEntityStatus, "archived", "create compensation must archive the registered entity");
    // Replaying the same compensation is idempotent (same operationId), and a create whose record moved on is refused by CAS.
    const replayed = await app!.inject({
      method: "POST",
      url: `/api/game/${chatId}/memory/mutations/compensate`,
      payload: { operationId: `${createOperationId}:compensate`, originalOperationId: createOperationId, reason: "migration drill: retract registration" },
    });
    assert.equal(replayed.statusCode, 200, JSON.stringify(replayed.json()));
    if (createTargetId !== entityId) {
      const movedOn = await app!.inject({
        method: "POST",
        url: `/api/game/${chatId}/memory/mutations/compensate`,
        payload: { operationId: `migration-drill:${chatId}:entity:${entityId}:compensate`, originalOperationId: `migration-drill:${chatId}:entity:${entityId}`, reason: "migration drill: expected CAS refusal" },
      });
      compensation.createCompensationAfterLaterMutation = { status: movedOn.statusCode, code: movedOn.json()?.error?.code };
      assert.equal(movedOn.statusCode, 409, "create compensation after later mutations must be refused by CAS");
    }

  });
  report.compensation = compensation;

  const finalCounts = (await snapshot()).counts;
  report.final = finalCounts;
  assert.equal(finalCounts.messages, before.counts.messages);
  assert.equal(finalCounts.receipts, before.counts.receipts);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
  process.exitCode = 1;
} finally {
  try {
    await app?.close();
  } catch {
    /* ignore */
  }
  try {
    await closeDB?.();
  } catch {
    /* ignore */
  }
  await time("cleanupMs", () => rmSync(root, { recursive: true, force: true }));
  timings.totalMs = Date.now() - startedAt;
  report.timings = timings;
  report.tempCopyDeleted = !existsSync(root);
  mkdirSync(join(repoRoot, ".tmp/v3-execution"), { recursive: true });
  writeFileSync(resultPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, resultPath, before: report.before, after: report.after, timings, error: report.error }, null, 2));
}
