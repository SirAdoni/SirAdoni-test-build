import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

const root = mkdtempSync(join(tmpdir(), "marinara-pending-opt-in-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
const { campaignMemoryMutationJournal } = await import("../../packages/server/src/db/schema/index.js");
const { and, eq } = await import("../../packages/server/src/db/file-query.js");
const { campaignMemoryTransitionId } =
  await import("../../packages/server/src/services/game/campaign-memory-transitions.js");
const { requireCampaignOptIn } = await import("../../packages/server/src/services/features/campaign-opt-in.js");
const { applyFeatureSettingsValue } = await import("../../packages/server/src/services/features/feature-settings.js");
const source = readFileSync(
  new URL("../../packages/server/src/services/game/continuity-memory-publication.ts", import.meta.url),
  "utf8",
);
const helper = source.match(/^async function journalPendingTransition\([\s\S]*?^}/m)?.[0];
assert.ok(helper, "Exercise the actual pending-transition write helper");
const js = ts.transpileModule(helper, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const pending = new Function(
  "campaignMemoryTransitionId",
  "campaignMemoryMutationJournal",
  "and",
  "eq",
  "randomUUID",
  "hash",
  "requireCampaignOptIn",
  `${js}\nreturn journalPendingTransition;`,
)(
  campaignMemoryTransitionId,
  campaignMemoryMutationJournal,
  and,
  eq,
  randomUUID,
  (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex"),
  requireCampaignOptIn,
);
const enabled = (value: boolean) => applyFeatureSettingsValue(JSON.stringify({ campaignMemory: value }));
const db = await createFileNativeDB();
try {
  const command = {
    chatId: "pending-opt-in",
    class: "event",
    key: "unresolved-event",
    participantEntityIds: [],
    source: { messageId: "synthetic-message" },
    actor: "continuity",
    reason: "missing participant",
    evidence: [],
  };
  const capture = { sourceHash: "synthetic-source", order: "0001" };
  const reasons = ["missing participant"];
  const rows = () => db.select().from(campaignMemoryMutationJournal);
  enabled(true);
  const first = await pending(db, command, capture, reasons);
  assert.equal(first.status, "pending");
  assert.equal(first.replayed, false);
  assert.equal((await pending(db, command, capture, reasons)).replayed, true);
  const saved = await rows();
  assert.equal(saved.length, 1);
  // Intercept only the awaited duplicate lookup; reads/writes remain real file-backed DB operations.
  const delayedRead = new Proxy(db, {
    get(target, key) {
      if (key !== "select") return Reflect.get(target, key);
      return (...args: unknown[]) => {
        const query = (target.select as Function)(...args);
        const from = query.from.bind(query);
        query.from = (...tables: unknown[]) => {
          const selection = from(...tables);
          const limit = selection.limit.bind(selection);
          selection.limit = async (count: number) => {
            const found = await limit(count);
            enabled(false);
            return found;
          };
          return selection;
        };
        return query;
      };
    },
  });
  await assert.rejects(
    pending(delayedRead, { ...command, key: "late-off-event" }, capture, reasons),
    /FEATURE_DISABLED:campaignMemory/,
  );
  assert.deepEqual(await rows(), saved, "Late OFF must not append a pending journal record or alter saved history");
  enabled(false);
  await assert.rejects(
    pending(db, { ...command, key: "already-off-event" }, capture, reasons),
    /FEATURE_DISABLED:campaignMemory/,
  );
  enabled(true);
  assert.equal((await pending(db, command, capture, reasons)).replayed, true);
  assert.deepEqual(await rows(), saved);
  console.info("Pending journal real DB ON/idempotence/late-OFF/retention/re-enable PASS");
} finally {
  await db._fileStore.close();
  assert.ok(root.startsWith(join(tmpdir(), "marinara-pending-opt-in-")));
  rmSync(root, { recursive: true, force: true });
}
