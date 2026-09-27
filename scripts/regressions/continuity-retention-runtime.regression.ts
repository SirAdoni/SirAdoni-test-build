import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const root = mkdtempSync(join(tmpdir(), "marinara-continuity-retention-runtime-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
const { apiConnections, chats, lorebooks, messages, lorebookEntries } =
  await import("../../packages/server/src/db/schema/index.js");
const { eq } = await import("../../packages/server/src/db/file-query.js");
const { createGameContinuityRuntime } = await import("../../packages/server/src/services/game/continuity-runtime.js");
const { createGameContinuityStorage } =
  await import("../../packages/server/src/services/storage/game-continuity.storage.js");
const { createCampaignMemoryStorage } =
  await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
const { explicitlyCorrectedContinuityClaims, continuityRecordFingerprint } =
  await import("../../packages/server/src/services/game/continuity-retention.js");
const { createGameContinuityRecordId } = await import("../../packages/server/src/services/game/continuity-review.js");

const db = await createFileNativeDB();
const now = "2026-09-26T00:00:00.000Z";
const later = "2026-09-26T00:00:01.000Z";
await db.insert(apiConnections).values({ id: "conn", name: "Retention test", provider: "custom", model: "test" });
await db.insert(lorebooks).values({ id: "book", name: "Retention book", createdAt: now, updatedAt: now });
await db.insert(chats).values({
  id: "chat",
  name: "Retention chat",
  mode: "game",
  connectionId: "conn",
  metadata: JSON.stringify({
    gameContinuity: { mode: "active", extractionInstructions: "extract", verificationInstructions: "verify" },
  }),
  createdAt: now,
  updatedAt: later,
});
await db.insert(messages).values([
  {
    id: "u1",
    chatId: "chat",
    role: "user",
    content:
      "Mara promised to return the key tomorrow. Correction: Mara returned the key today; she never made that promise. Mara hid the ledger in the cellar.",
    createdAt: now,
  },
  { id: "a1", chatId: "chat", role: "assistant", content: "Acknowledged.", createdAt: later },
]);

let extractionCalls = 0;
let reviewCalls = 0;
let correctionReviewPrompt = "";
let returnOverriddenClaimFromRepair = false;
let manualOverrideReviewPrompt = "";
let overriddenRecordForRepair: any = null;
let publishedCallbacks = 0;
const complete = async ({ stage, receipt, prompt }: { stage: string; receipt: any; prompt: string }) => {
  if (stage === "extract") {
    extractionCalls += 1;
    const source = receipt.sources.find((item: any) => item.messageId === "u1")!;
    return {
      records: [
        {
          kind: "promise",
          text: "Mara promised to return the key tomorrow.",
          subjects: ["Mara"],
          conditions: [],
          status: "asserted",
          evidence: [{ messageId: source.messageId, quote: "Mara promised to return the key tomorrow." }],
          keys: ["key"],
        },
        {
          kind: "event",
          text: "Mara hid the ledger in the cellar.",
          subjects: ["Mara"],
          conditions: [],
          status: "asserted",
          evidence: [{ messageId: source.messageId, quote: "Mara hid the ledger in the cellar." }],
          keys: ["ledger"],
        },
      ],
      dispositions: receipt.sources.map((item: any) => ({
        messageId: item.messageId,
        status: item.messageId === "u1" ? "covered" : "no_durable_facts",
        reason: "source",
      })),
    };
  }
  if (stage === "repair") {
    const source = receipt.sources.find((item: any) => item.messageId === "u1")!;
    if (returnOverriddenClaimFromRepair && receipt.id === "gch_manual-page-reread")
      return {
        replace: [],
        add: [
          {
            ...overriddenRecordForRepair,
            text: "Mara got the key back today and had not promised to return it tomorrow.",
          },
        ],
        dispositions: receipt.sources.map((item: any) => ({
          messageId: item.messageId,
          status:
            item.messageId === "u1" || (receipt.id === "gch_manual-page-reread" && item.messageId === "a1")
              ? "covered"
              : "no_durable_facts",
          reason: "adversarial repair",
        })),
      };
    return {
      replace: [
        {
          recordRef: "r1",
          records: [
            {
              kind: "correction",
              text: "Mara returned the key today; she made no promise to return it tomorrow.",
              subjects: ["Mara"],
              conditions: [],
              status: "asserted",
              evidence: [
                { messageId: source.messageId, quote: "Mara returned the key today; she never made that promise." },
              ],
              keys: ["key"],
            },
          ],
        },
      ],
      add: [],
      dispositions: receipt.sources.map((item: any) => ({
        messageId: item.messageId,
        status: item.messageId === "u1" ? "covered" : "no_durable_facts",
        reason: "repair",
      })),
    };
  }
  if (stage === "review") {
    reviewCalls += 1;
    if (returnOverriddenClaimFromRepair && receipt.id === "gch_manual-page-reread" && !manualOverrideReviewPrompt) {
      manualOverrideReviewPrompt = prompt;
      const source = receipt.sources.find((item: any) => item.messageId === "u1")!;
      return {
        findings: [
          {
            kind: "omission",
            messageId: source.messageId,
            quote: "Mara returned the key today; she never made that promise.",
            recordIds: [],
            detail: "Adversarial reviewer claims the edited-page record is omitted.",
          },
        ],
        dispositions: receipt.sources.map((item: any) => ({
          messageId: item.messageId,
          status:
            item.messageId === "u1" ||
            (returnOverriddenClaimFromRepair && receipt.id === "gch_manual-page-reread" && item.messageId === "a1")
              ? "covered"
              : "no_durable_facts",
          reason: "adversarial review",
        })),
      };
    }
    if (reviewCalls === 2) {
      correctionReviewPrompt = prompt;
      const source = receipt.sources.find((item: any) => item.messageId === "u1")!;
      return {
        findings: [
          {
            kind: "contradiction",
            messageId: source.messageId,
            quote: "Mara returned the key today; she never made that promise.",
            recordIds: ["r1"],
            detail: "The later correction says the promise was never made.",
          },
        ],
        dispositions: receipt.sources.map((item: any) => ({
          messageId: item.messageId,
          status: item.messageId === "u1" ? "covered" : "no_durable_facts",
          reason: "reviewed source",
        })),
      };
    }
  }
  return {
    findings: [],
    dispositions: receipt.sources.map((item: any) => ({
      messageId: item.messageId,
      status:
        item.messageId === "u1" || (receipt.id === "gch_manual-page-reread" && item.messageId === "a1")
          ? "covered"
          : "no_durable_facts",
      reason: "reviewed source",
    })),
  };
};
const runtime = createGameContinuityRuntime(db, {
  complete: complete as never,
  maxDrainMs: 3000,
  onPublished: () => {
    publishedCallbacks += 1;
  },
});
const waitFor = async (predicate: () => Promise<boolean>) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("timed out waiting for continuity retention runtime");
};
const armTerminalPublicationRace = (receiptId: string) => {
  const originalTransaction = db.transaction.bind(db);
  let injected = false;
  let lastSeenStatus: string | null = null;
  let observedStatus: string | null = null;
  let publicationStatus: string | null = null;
  (db as any).transaction = async (...args: any[]) => {
    const result = await (originalTransaction as any)(...args);
    if (!injected) {
      setTimeout(async () => {
        if (injected) return;
        const saved = await storage.get(receiptId);
        lastSeenStatus = saved?.status ?? null;
        if (saved && (saved.status === "verified" || saved.status === "unresolved" || saved.status === "published")) {
          injected = true;
          observedStatus = saved.status;
          try {
            publicationStatus = (await runtime.publish(receiptId))?.status ?? null;
          } catch {
            publicationStatus = (await storage.get(receiptId))?.status ?? null;
          }
        }
      }, 0);
    }
    return result;
  };
  return {
    result: () => ({ injected, observedStatus, publicationStatus, lastSeenStatus }),
    restore: () => {
      (db as any).transaction = originalTransaction;
    },
  };
};

await runtime.enqueueCommittedTurn({ chatId: "chat", assistantMessageId: "a1", sessionNumber: 2 });
await waitFor(async () => (await runtime.list("chat")).some((receipt) => receipt.status === "published"));
const storage = createGameContinuityStorage(db);
const original = (await storage.list("chat")).find((receipt) => receipt.status === "published")!;
const seedExactReread = async (base: any, id: string) =>
  storage.save({
    ...base,
    id,
    status: "queued",
    attempts: 0,
    repairAttempts: 0,
    records: [],
    dispositions: [],
    review: null,
    error: undefined,
    errorCode: undefined,
    entryIds: [],
    createdAt: now,
    updatedAt: now,
  });

await seedExactReread(original, "gch_corrected-reread");
await runtime.resumeChat("chat");
await waitFor(async () =>
  (await runtime.list("chat")).some(
    (receipt) => receipt.id === "gch_corrected-reread" && receipt.status === "published",
  ),
);
const corrected = (await storage.get("gch_corrected-reread"))!;
assert.match(
  correctionReviewPrompt,
  /Mara promised to return the key tomorrow/u,
  "old claim is offered to the reviewer",
);
assert.ok(corrected.records.some((record) => record.text.startsWith("Mara returned the key today")));
assert.ok(corrected.records.some((record) => record.text === "Mara hid the ledger in the cellar."));
assert.ok(!corrected.records.some((record) => record.text === "Mara promised to return the key tomorrow."));
const correctionHistory = await storage.getHistory("chat", corrected.id);
assert.ok(
  explicitlyCorrectedContinuityClaims(correctionHistory).has(continuityRecordFingerprint(original.records[0]!)),
  "the persisted publication history records the explicitly repaired old claim",
);
await waitFor(async () => (await storage.get(original.id))?.status === "stale");
assert.equal((await storage.get(original.id))?.status, "stale", "the explicitly corrected published ancestor retires");
assert.equal(extractionCalls, 1, "a fully covered source review seeds prior claims without another extraction");

await seedExactReread(corrected, "gch_third-reread");
await runtime.resumeChat("chat");
await waitFor(async () => (await storage.get("gch_third-reread"))?.status === "published");
await waitFor(async () => (await storage.get("gch_corrected-reread"))?.status === "stale");
const third = (await storage.get("gch_third-reread"))!;
assert.ok(!third.records.some((record) => record.text === "Mara promised to return the key tomorrow."));
assert.ok(third.records.some((record) => record.text === "Mara hid the ledger in the cellar."));
assert.equal(third.records.length, 2, "the distinct retained fact and corrected claim remain bounded across rereads");
assert.equal(extractionCalls, 1, "the third same-source review does not call the extractor");

const independentEvidence = third.sources.find((source) => source.messageId === "a1")!;
const independentRecord = {
  id: "",
  kind: "event" as const,
  text: "The assistant replied, 'Acknowledged.'",
  subjects: [],
  conditions: [],
  status: "asserted" as const,
  evidence: [{ messageId: independentEvidence.messageId, quote: "Acknowledged." }],
  keys: ["acknowledged"],
};
independentRecord.id = createGameContinuityRecordId("gch_unedited-owner", independentRecord);
const independentEntryId = "gce_unedited-owner-entry";
const independentEntryContent = independentRecord.text;
await db.insert(lorebookEntries).values({
  id: independentEntryId,
  lorebookId: "book",
  name: "Independent owner page",
  content: independentEntryContent,
  dynamicState: JSON.stringify({
    receiptId: "gch_unedited-owner",
    publishedContentHash: createHash("sha256").update(JSON.stringify(independentEntryContent)).digest("hex"),
    source: "incremental-game-continuity",
  }),
  createdAt: now,
  updatedAt: later,
});
await storage.save({
  ...third,
  id: "gch_unedited-owner",
  status: "published",
  records: [independentRecord],
  dispositions: third.dispositions.map((disposition) =>
    independentRecord.evidence.some((evidence) => evidence.messageId === disposition.messageId)
      ? { ...disposition, status: "covered" as const }
      : disposition.status === "covered"
        ? { ...disposition, status: "no_durable_facts" as const }
        : disposition,
  ),
  review: { findings: [], dispositions: third.dispositions },
  entryIds: [independentEntryId],
  createdAt: now,
  updatedAt: later,
});

const correctedClaim = third.records.find((record) => record.text.startsWith("Mara returned the key today"))!;
const ledgerClaim = third.records.find((record) => record.text === "Mara hid the ledger in the cellar.")!;
const editedPageSeeds = [
  { receiptId: "gch_override-page-a", entryId: "gce_override-page-a", record: ledgerClaim },
  { receiptId: "gch_override-page-b", entryId: "gce_override-page-b", record: ledgerClaim },
  { receiptId: "gch_override-page-z", entryId: "gce_override-page-z", record: correctedClaim },
];
for (const [index, page] of editedPageSeeds.entries()) {
  const originalContent = `Published generated claim: ${page.record.text}`;
  const pageRecord = {
    ...page.record,
    id: createGameContinuityRecordId(page.receiptId, page.record),
  };
  const pageReceipt = {
    ...third,
    id: page.receiptId,
    status: "published" as const,
    records: [pageRecord],
    dispositions: third.dispositions.map((disposition) =>
      pageRecord.evidence.some((evidence) => evidence.messageId === disposition.messageId)
        ? { ...disposition, status: "covered" as const }
        : disposition.status === "covered"
          ? { ...disposition, status: "no_durable_facts" as const }
          : disposition,
    ),
    entryIds: [page.entryId],
    createdAt: now,
    updatedAt: later,
  };
  await db.insert(lorebookEntries).values({
    id: page.entryId,
    lorebookId: "book",
    name: `Generated claim page ${index + 1}`,
    content: `Player-authored page ${index + 1} override.`,
    dynamicState: JSON.stringify({
      receiptId: page.receiptId,
      publishedContentHash: createHash("sha256").update(JSON.stringify(originalContent)).digest("hex"),
      source: "incremental-game-continuity",
    }),
    createdAt: now,
    updatedAt: later,
  });
  await storage.save(pageReceipt);
}
overriddenRecordForRepair = correctedClaim;
returnOverriddenClaimFromRepair = true;
const manualResumeId = "gch_manual-page-reread";
await storage.save({
  ...third,
  id: manualResumeId,
  status: "reviewing",
  attempts: 1,
  repairAttempts: 0,
  records: [...third.records, independentRecord].map((record) => ({
    ...record,
    id: createGameContinuityRecordId(manualResumeId, record),
  })),
  dispositions: third.dispositions.map((disposition) =>
    independentRecord.evidence.some((evidence) => evidence.messageId === disposition.messageId)
      ? { ...disposition, status: "covered" as const }
      : disposition,
  ),
  review: null,
  error: undefined,
  errorCode: undefined,
  entryIds: [],
  createdAt: now,
  updatedAt: now,
});
const manualRace = armTerminalPublicationRace(manualResumeId);
await runtime.resumeChat("chat");
await waitFor(async () => (await storage.get("gch_manual-page-reread"))?.status === "unresolved");
await waitFor(async () => manualRace.result().injected);
manualRace.restore();
const manualOverrideReread = (await storage.get("gch_manual-page-reread"))!;
assert.deepEqual(
  manualRace.result(),
  { injected: true, observedStatus: "unresolved", publicationStatus: "unresolved", lastSeenStatus: "unresolved" },
  "an immediate publication attempt at the sole terminal checkpoint cannot observe a verified conflicting receipt",
);
assert.match(manualOverrideReviewPrompt, /PLAYER-EDITED GENERATED-PAGE OVERRIDE/u);
assert.match(manualOverrideReviewPrompt, /Player-authored page 1 override\./u);
assert.match(manualOverrideReviewPrompt, /Player-authored page 2 override\./u);
assert.doesNotMatch(manualOverrideReviewPrompt, /Player-authored page 3 override\./u);
assert.equal(
  manualOverrideReread.records.length,
  4,
  "resumed claims, adversarial paraphrase, and independent claim remain visible for manual review",
);
assert.ok(
  manualOverrideReread.records.some((record) => record.text === independentRecord.text),
  "a distinct claim from an unedited owner page with a non-overlapping quote remains retained",
);
assert.ok(
  manualOverrideReread.records.some(
    (record) => record.text === "Mara got the key back today and had not promised to return it tomorrow.",
  ),
  "a paraphrase reintroduced from the third edited page remains visible but unresolved",
);
assert.ok(
  manualOverrideReread.review?.findings.some((finding) =>
    finding.detail.includes("manually edited generated lore page"),
  ),
  "a reintroduced claim is explicitly held with an unresolved finding",
);
assert.equal(extractionCalls, 1, "manual page override handling keeps the unchanged-source fast path");

for (const page of editedPageSeeds) {
  await db
    .update(lorebookEntries)
    .set({ content: `Published generated claim: ${page.record.text}` })
    .where(eq(lorebookEntries.id, page.entryId));
}
const cleanResumeId = "gch_clean-terminal-race";
await storage.save({
  ...third,
  id: cleanResumeId,
  status: "reviewing",
  attempts: 1,
  repairAttempts: 0,
  records: third.records.map((record) => ({
    ...record,
    id: createGameContinuityRecordId(cleanResumeId, record),
  })),
  dispositions: third.dispositions,
  review: null,
  error: undefined,
  errorCode: undefined,
  entryIds: [],
  createdAt: now,
  updatedAt: now,
});
returnOverriddenClaimFromRepair = false;
const cleanRace = armTerminalPublicationRace(cleanResumeId);
await runtime.resumeChat("chat");
await waitFor(async () => (await storage.get(cleanResumeId))?.status === "published");
await waitFor(async () => cleanRace.result().injected);
cleanRace.restore();
assert.deepEqual(
  cleanRace.result(),
  { injected: true, observedStatus: "verified", publicationStatus: null, lastSeenStatus: "verified" },
  "a clean receipt remains verified at the terminal checkpoint while the worker completes publication",
);
const cleanPublished = (await storage.get(cleanResumeId))!;
const callbacksAfterCleanRace = publishedCallbacks;
assert.equal((await runtime.publish(cleanResumeId))?.status, "published");
assert.equal((await storage.get(cleanResumeId))?.status, "published");
assert.equal(
  publishedCallbacks,
  callbacksAfterCleanRace,
  "replaying publication after the runtime completes is idempotent",
);
assert.deepEqual((await storage.get(cleanResumeId))?.entryIds, cleanPublished.entryIds);

const facts = await createCampaignMemoryStorage(db).listFacts({ chatId: "chat" });
assert.ok(
  facts.some(
    (fact) =>
      fact.status === "verified" &&
      (fact.value as any).receiptId === third.id &&
      (fact.value as any).text.startsWith("Mara returned the key today"),
  ),
  "the corrected claim is published under the replacement receipt",
);

console.log("continuity-retention runtime regression passed");
