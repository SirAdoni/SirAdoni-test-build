import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Replays a compact synthetic historical cohort through the production continuity runtime with a recorded
// provider stub. Every provider request must match a recording by its stable request key (sources + context);
// anything else fails as an unrecorded request.
// Asserts range accounting, disposition completeness, receipt uniqueness, verified status, and a per-case
// semantic checklist. No provider is called.
const root = mkdtempSync(join(tmpdir(), "marinara-continuity-corpus-replay-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { prepareContinuitySources, planContinuityTurnBatches } =
    await import("../../packages/server/src/services/game/continuity-sources.js");
  const {
    chatMetadata,
    corpusMessages,
    loadCohorts,
    requestKey,
    seedCohortChat,
    replayCohort,
    sourceIdsOf,
  } =
    await import("./fixtures/continuity-corpus/replay-support.ts");

  const cohorts = loadCohorts();
  assert.ok(cohorts.length >= 1, "at least one recorded cohort is required");

  for (const cohort of cohorts) {
    const label = `[${cohort.cohort}]`;
    // The store resolves its directories from the environment at open time, so each cohort gets its own.
    process.env.DATA_DIR = join(root, cohort.cohort);
    process.env.FILE_STORAGE_DIR = join(root, cohort.cohort, "storage");
    const db = await createFileNativeDB();
    try {
      await seedCohortChat(db, cohort);

      const unrecorded: string[] = [];
      const used = new Map<string, number>();
      const complete = async ({ stage, receipt }: { stage: string; receipt: any }) => {
        const key = requestKey(stage, receipt);
        const recorded = cohort.responses[key];
        if (!recorded) {
          const detail = `${stage} ${sourceIdsOf(receipt).join(",")} key ${key.slice(0, 12)}`;
          unrecorded.push(detail);
          throw new Error(`unrecorded request: ${detail}`);
        }
        assert.equal(recorded.stage, stage, `${label} recorded stage mismatch for ${key}`);
        used.set(key, (used.get(key) ?? 0) + 1);
        return recorded.response;
      };

      const receipts = await replayCohort(db, cohort, complete);
      assert.deepEqual(unrecorded, [], `${label} unrecorded request`);
      const drifted = {
        ...receipts[0]!,
        sources: receipts[0]!.sources.map((source: any, index: number) =>
          index === 0 ? { ...source, content: `${source.content} unexpected drift` } : source,
        ),
      };
      await assert.rejects(
        () => complete({ stage: "extract", receipt: drifted }),
        /unrecorded request/u,
        `${label} source drift must not match a recorded provider request`,
      );

      // Every recording served exactly once: no request drifted to a different key and none was replayed twice.
      const recordedKeys = Object.keys(cohort.responses).sort();
      assert.deepEqual([...used.keys()].sort(), recordedKeys, `${label} every recorded request must be used`);
      assert.ok([...used.values()].every((count) => count === 1), `${label} no recorded request is served twice`);

      // Statuses: every receipt verified on its first attempt with no error.
      assert.ok(receipts.length > 0, `${label} replay produced receipts`);
      for (const receipt of receipts) {
        assert.equal(receipt.status, "verified", `${label} receipt ${receipt.id} status`);
        assert.equal(receipt.attempts, 1, `${label} receipt ${receipt.id} attempts`);
        assert.equal(receipt.errorCode ?? null, null, `${label} receipt ${receipt.id} errorCode`);
        assert.equal(receipt.review?.findings?.length ?? 0, 0, `${label} receipt ${receipt.id} clean review`);
      }

      // No receipt missing or duplicated: exactly one receipt per planned batch, all ids distinct.
      const prepared = prepareContinuitySources(corpusMessages(cohort), chatMetadata(cohort));
      const planned = cohort.acceptedAssistantIds.flatMap((id) => planContinuityTurnBatches(prepared, id, 8000));
      const batchKey = (sources: any[]) => sources.map((s) => `${s.messageId}:${s.start}:${s.end}`).join("|");
      const plannedKeys = planned.map((batch) => batchKey(batch.sources)).sort();
      const receiptKeys = receipts.map((receipt: any) => batchKey(receipt.sources)).sort();
      assert.deepEqual(receiptKeys, plannedKeys, `${label} one receipt per planned batch`);
      assert.equal(new Set(receipts.map((r: any) => r.id)).size, receipts.length, `${label} receipt ids unique`);
      assert.equal(new Set(plannedKeys).size, plannedKeys.length, `${label} planned batches distinct`);

      // Every prepared range of every selected message appears in exactly one receipt.
      const selectedIds = new Set(cohort.sources.map((source) => source.messageId));
      const preparedById = new Map(prepared.map((message) => [message.messageId, message]));
      for (const id of selectedIds) assert.ok(preparedById.has(id), `${label} selected message ${id} is prepared`);
      const rangeOwners = new Map<string, string[]>();
      for (const receipt of receipts)
        for (const source of receipt.sources) {
          const key = `${source.messageId}:${source.start}:${source.end}`;
          rangeOwners.set(key, [...(rangeOwners.get(key) ?? []), receipt.id]);
        }
      for (const [key, owners] of rangeOwners) assert.equal(owners.length, 1, `${label} range ${key} owned once`);
      for (const message of prepared) {
        if (!selectedIds.has(message.messageId)) continue;
        const ranges = receipts
          .flatMap((receipt: any) => receipt.sources)
          .filter((source: any) => source.messageId === message.messageId)
          .map((source: any) => [source.start, source.end] as [number, number])
          .sort((a, b) => a[0] - b[0]);
        assert.ok(ranges.length > 0, `${label} message ${message.messageId} has no receipt`);
        let cursor = 0;
        for (const [start, end] of ranges) {
          assert.equal(start, cursor, `${label} message ${message.messageId} range starts at ${cursor}`);
          assert.ok(end > start, `${label} message ${message.messageId} range non-empty`);
          cursor = end;
        }
        assert.equal(cursor, message.end, `${label} message ${message.messageId} fully covered`);
        assert.equal(message.start, 0);
      }

      // Exactly one disposition per primary source with a non-empty reason, in extraction and in review.
      for (const receipt of receipts) {
        const primary = sourceIdsOf(receipt).sort();
        for (const [phase, dispositions] of [
          ["extraction", receipt.dispositions],
          ["review", receipt.review?.dispositions ?? []],
        ] as const) {
          assert.deepEqual(
            dispositions.map((d: any) => d.messageId).sort(),
            primary,
            `${label} receipt ${receipt.id} ${phase} dispositions cover each primary source once`,
          );
          for (const disposition of dispositions) {
            assert.ok(
              ["covered", "no_durable_facts", "unresolved"].includes(disposition.status),
              `${label} ${phase} disposition status`,
            );
            assert.notEqual(disposition.status, "unresolved", `${label} verified receipt has no unresolved disposition`);
            assert.ok(
              typeof disposition.reason === "string" && disposition.reason.trim().length > 0,
              `${label} receipt ${receipt.id} ${phase} disposition ${disposition.messageId} reason`,
            );
          }
        }
      }

      // Semantic checklist: actor, recipient (or its in-source alias) and a condition keyword appear in
      // verified records covering the case's sources.
      const records = receipts.flatMap((receipt: any) => receipt.records);
      for (const item of cohort.cases) {
        const covering = records.filter((record: any) =>
          record.evidence.some((evidence: any) => item.sourceIds.includes(evidence.messageId)),
        );
        assert.ok(covering.length > 0, `${label} ${item.factId} has covering records`);
        const haystack = covering
          .map((record: any) => [record.text, ...record.subjects, ...record.conditions].join(" "))
          .join("\n")
          .toLowerCase();
        assert.ok(haystack.includes(item.actor.toLowerCase()), `${label} ${item.factId} names actor ${item.actor}`);
        for (const term of item.recipientTerms)
          assert.ok(haystack.includes(term.toLowerCase()), `${label} ${item.factId} names recipient term ${term}`);
        assert.ok(
          item.conditionKeywords.some((keyword) => haystack.includes(keyword.toLowerCase())),
          `${label} ${item.factId} carries a condition keyword (${item.conditionKeywords.join(", ")})`,
        );
        // Every case source must itself be cited by a verified record (it was dispositioned covered).
        for (const sourceId of item.sourceIds)
          assert.ok(
            records.some((record: any) => record.evidence.some((evidence: any) => evidence.messageId === sourceId)),
            `${label} ${item.factId} source ${sourceId} is cited`,
          );
      }
      assert.ok(cohort.cases.length > 0, `${label} has semantic cases`);
      console.log(
        `${label} ${receipts.length} receipts, ${records.length} records, ${cohort.cases.length} cases, ${recordedKeys.length} recorded requests`,
      );
    } finally {
      await db._fileStore.close();
    }
  }
  console.log("game-continuity-corpus-replay regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
