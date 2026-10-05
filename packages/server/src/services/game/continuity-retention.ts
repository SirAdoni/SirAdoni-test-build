import type {
  GameContinuityContextSource,
  GameContinuityExtraction,
  GameContinuityReceipt,
  GameContinuityRecord,
  GameContinuitySource,
} from "@marinara-engine/shared";
import { createGameContinuityRecordId } from "./continuity-review.js";
import type { GameContinuityHistorySnapshot } from "../storage/game-continuity.storage.js";
import { continuityReceiptCovers } from "./continuity-retirement.js";

type EvidenceSource = GameContinuitySource | GameContinuityContextSource;

/** Only the old same-text replacement journal is eligible for recovery. Source-change retirements stay excluded. */
export function isRecoverableReplacementReceipt(
  receipt: Pick<GameContinuityReceipt, "status" | "errorCode" | "error">,
): boolean {
  return (
    receipt.status === "published" ||
    (receipt.status === "stale" &&
      receipt.errorCode === "CONTINUITY_SOURCE_RETIRED" &&
      /^Replaced by receipt [^,]+, which read the same text\.$/u.test(receipt.error ?? ""))
  );
}

export function replacementReceiptId(receipt: Pick<GameContinuityReceipt, "error">): string | null {
  return receipt.error?.match(/^Replaced by receipt ([^,]+), which read the same text\.$/u)?.[1] ?? null;
}

/** Identity of a reviewed claim without the receipt-local record id. */
export function continuityRecordFingerprint(record: GameContinuityRecord): string {
  const { id: _id, ...claim } = record;
  return JSON.stringify(claim);
}

function sourceIdentity(source: EvidenceSource): string {
  return JSON.stringify([source.messageId, source.swipeIndex, source.hash, source.role]);
}

function evidenceIsCurrent(
  record: GameContinuityRecord,
  receipt: GameContinuityReceipt,
  sources: readonly GameContinuitySource[],
  context: readonly GameContinuityContextSource[],
): boolean {
  const available = [...sources, ...context];
  const priorSources = [...receipt.sources, ...receipt.context];
  return record.evidence.every((evidence) =>
    priorSources.some((prior) => {
      return (
        prior.messageId === evidence.messageId &&
        available.some(
          (current) => sourceIdentity(current) === sourceIdentity(prior) && current.content.includes(evidence.quote),
        )
      );
    }),
  );
}

/**
 * Carry claims from a same-source published read into the next review. A model omission is not a correction;
 * the reviewer must see the previous claim before it can be withheld. Claims whose citations are not in the
 * current source/context are excluded so an old context cannot resurrect stale knowledge.
 */
export function retainPublishedContinuityRecords(
  extraction: GameContinuityExtraction,
  prior: readonly GameContinuityReceipt[],
  sources: readonly GameContinuitySource[],
  context: readonly GameContinuityContextSource[],
  blockedRecordKeys: ReadonlySet<string> = new Set(),
  batchId?: string,
): GameContinuityExtraction {
  const records = [...extraction.records];
  const fingerprints = new Set(records.map(continuityRecordFingerprint));
  const citedPrimary = new Set(records.flatMap((record) => record.evidence.map((evidence) => evidence.messageId)));
  for (const receipt of prior) {
    for (const record of receipt.records) {
      const fingerprint = continuityRecordFingerprint(record);
      if (
        fingerprints.has(fingerprint) ||
        blockedRecordKeys.has(`${receipt.id}\u0000${record.id}`) ||
        !evidenceIsCurrent(record, receipt, sources, context)
      )
        continue;
      if (!record.evidence.some((evidence) => sources.some((source) => source.messageId === evidence.messageId)))
        continue;
      records.push(batchId ? { ...record, id: createGameContinuityRecordId(batchId, record) } : record);
      fingerprints.add(fingerprint);
      for (const evidence of record.evidence) citedPrimary.add(evidence.messageId);
    }
  }
  const dispositions = extraction.dispositions.map((disposition) =>
    citedPrimary.has(disposition.messageId) && disposition.status !== "covered"
      ? { ...disposition, status: "covered" as const, reason: "retained published record cites this source" }
      : disposition,
  );
  return { records, dispositions };
}

/** Retire an older receipt only after every one of its reviewed claims is present in the replacement. */
export function replacementContainsAllRecords(
  replacement: GameContinuityReceipt,
  older: GameContinuityReceipt,
  correctedClaims: ReadonlySet<string> = new Set(),
): boolean {
  const withheld = replacement.review?.withheld;
  const explicitlyWithheld = withheld
    ? withheld.records
        .filter((record) => withheld.findings.some((finding) => finding.recordIds.includes(record.id)))
        .map(continuityRecordFingerprint)
    : [];
  const fingerprints = new Set([...replacement.records.map(continuityRecordFingerprint), ...explicitlyWithheld]);
  return older.records.every((record) => {
    const fingerprint = continuityRecordFingerprint(record);
    return fingerprints.has(fingerprint) || correctedClaims.has(fingerprint);
  });
}

/**
 * A correction is durable only when a published review lineage explicitly flagged the exact old record id,
 * a later repair attempt removed or changed that claim, and publication followed. Failed attempts and omissions
 * alone never authorize retirement.
 */
export function explicitlyCorrectedContinuityClaims(
  history: readonly GameContinuityHistorySnapshot[],
  publishedLifecycleObserved = false,
): Set<string> {
  const last = history.at(-1);
  const final =
    [...history].reverse().find((snapshot) => snapshot.status === "published") ??
    (publishedLifecycleObserved && last?.status !== "failed" && last?.status !== "unresolved" ? last : undefined);
  if (!final) return new Set();
  const finalIds = new Set(final.records.map((record) => record.id));
  const finalClaims = new Set(final.records.map(continuityRecordFingerprint));
  // A later attempt starts a new correction epoch. Findings from a failed attempt cannot authorize
  // retirement after a retry, even when a provider pause caused the attempt counter to be returned.
  let successfulAttemptStart = history.length - 1;
  while (successfulAttemptStart > 0) {
    const prior = history[successfulAttemptStart - 1]!;
    const current = history[successfulAttemptStart]!;
    if (
      prior.attempts !== current.attempts ||
      prior.status === "failed" ||
      prior.status === "unresolved" ||
      prior.status === "stale"
    )
      break;
    successfulAttemptStart -= 1;
  }
  const corrections = new Set<string>();
  for (let reviewedAt = successfulAttemptStart; reviewedAt < history.length; reviewedAt += 1) {
    const reviewed = history[reviewedAt]!;
    if (!reviewed.review || reviewed.attempts !== final.attempts) continue;
    const flagged = new Set(reviewed.review.findings.flatMap((finding) => finding.recordIds));
    if (flagged.size === 0) continue;
    for (let repairedAt = reviewedAt + 1; repairedAt < history.length; repairedAt += 1) {
      const repaired = history[repairedAt]!;
      const repairCompleted =
        repaired.repairAttempts > reviewed.repairAttempts ||
        (reviewed.status === "repairing" && repaired.repairAttempts === reviewed.repairAttempts);
      if (repaired.attempts !== reviewed.attempts || !repairCompleted) continue;
      // `repairing` is a reservation checkpoint written before the provider call. It still contains
      // the old records and is not evidence that the attempted correction survived review.
      if (repaired.status === "repairing") continue;
      if (repaired.status !== "reviewing" && repaired.status !== "verified" && repaired.status !== "published")
        continue;
      const survivingIds = new Set(repaired.records.map((record) => record.id));
      const survivingClaims = new Set(repaired.records.map(continuityRecordFingerprint));
      for (const record of reviewed.records) {
        if (
          flagged.has(record.id) &&
          !finalIds.has(record.id) &&
          !finalClaims.has(continuityRecordFingerprint(record)) &&
          !survivingIds.has(record.id) &&
          !survivingClaims.has(continuityRecordFingerprint(record))
        ) {
          corrections.add(continuityRecordFingerprint(record));
        }
      }
    }
  }
  return corrections;
}

/** Exact claim dispositions from a same-source replacement chain, scoped to each retired ancestor. */
export function lineageDispositionRetentionKeys(
  ancestors: readonly GameContinuityReceipt[],
  receipts: readonly GameContinuityReceipt[],
  histories: ReadonlyMap<string, readonly GameContinuityHistorySnapshot[]>,
): Set<string> {
  const byId = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  const keys = new Set<string>();
  for (const ancestor of ancestors) {
    if (ancestor.status !== "stale") continue;
    const visited = new Set<string>([ancestor.id]);
    let descendant = ancestor;
    const disposedClaims = new Set<string>();
    while (true) {
      const nextId = replacementReceiptId(descendant);
      const next = nextId ? byId.get(nextId) : undefined;
      if (!next || visited.has(next.id) || !continuityReceiptCovers(next, descendant)) break;
      visited.add(next.id);
      descendant = next;
      const history = histories.get(descendant.id) ?? [];
      for (const claim of explicitlyCorrectedContinuityClaims(history, isRecoverableReplacementReceipt(descendant)))
        disposedClaims.add(claim);
      const withheld = descendant.review?.withheld;
      if (withheld) {
        const flagged = new Set(withheld.findings.flatMap((finding) => finding.recordIds));
        for (const record of withheld.records) {
          if (flagged.has(record.id)) disposedClaims.add(continuityRecordFingerprint(record));
        }
      }
    }
    for (const record of ancestor.records)
      if (disposedClaims.has(continuityRecordFingerprint(record))) keys.add(`${ancestor.id}\u0000${record.id}`);
  }
  return keys;
}
