import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "marinara-campaign-memory-branch-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { chats, messages, campaignMemoryEntities, campaignMemoryFacts, campaignMemoryKnowledge } =
    await import("../../packages/server/src/db/schema/index.js");
  const { projectCampaignMemoryBranch, CampaignMemoryBranchError } =
    await import("../../packages/server/src/services/game/campaign-memory-branch.js");
  const { formatCampaignMemoryMessageOrder } =
    await import("../../packages/server/src/services/game/campaign-memory-order.js");
  const db = await createFileNativeDB();
  const now = new Date().toISOString();
  const futureAt = new Date(Date.parse(now) + 1_000).toISOString();
  for (const id of [
    "branch-source",
    "branch-target",
    "branch-target-invalid",
    "branch-target-order",
    "branch-target-missing",
    "branch-target-tie",
  ]) {
    await db.insert(chats).values({ id, name: id, mode: "game", createdAt: now, updatedAt: now });
  }
  await db.insert(messages).values([
    {
      id: "source-m1",
      chatId: "branch-source",
      role: "user",
      content: "Alice arrived and knows the secret.",
      createdAt: now,
    },
    {
      id: "source-future",
      chatId: "branch-source",
      role: "user",
      content: "future source evidence",
      createdAt: futureAt,
    },
    {
      id: "target-m1",
      chatId: "branch-target",
      role: "user",
      content: "Alice arrived and knows the secret.",
      createdAt: now,
    },
    {
      id: "target-future",
      chatId: "branch-target",
      role: "user",
      content: "future source evidence",
      createdAt: futureAt,
    },
  ]);
  await db.insert(messages).values([
    { id: "source-tie-a", chatId: "branch-source", role: "user", content: "tie evidence", createdAt: now },
    { id: "source-tie-b", chatId: "branch-source", role: "user", content: "tie second", createdAt: now },
    {
      id: "target-order-m1",
      chatId: "branch-target-order",
      role: "user",
      content: "Alice arrived and knows the secret.",
      createdAt: now,
    },
    {
      id: "target-missing-m1",
      chatId: "branch-target-missing",
      role: "user",
      content: "Alice arrived and knows the secret.",
      createdAt: now,
    },
    { id: "target-tie-z", chatId: "branch-target-tie", role: "user", content: "tie evidence", createdAt: now },
    { id: "target-tie-a", chatId: "branch-target-tie", role: "user", content: "tie second", createdAt: now },
  ]);
  const provenance = { source: "regression", sourceRevision: "r1", actor: "user" as const };
  const entity = {
    entityId: "source-alice",
    chatId: "branch-source",
    kind: "note",
    owner: { type: "registry" as const, store: "campaign-memory" as const, recordId: "source-alice" },
    aliases: ["Alice"],
    tags: [],
    attributes: { futureSecret: "must-not-project" },
    status: "active" as const,
    manualLock: true,
    provenance,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(campaignMemoryEntities).values({
    ...entity,
    owner: JSON.stringify(entity.owner),
    aliases: '["Alice"]',
    tags: "[]",
    attributes: JSON.stringify(entity.attributes),
    provenance: JSON.stringify(provenance),
    manualLock: 1,
  });
  const sourceHash = createHash("sha256").update("Alice arrived and knows the secret.").digest("hex");
  const sourceM1Order = formatCampaignMemoryMessageOrder("source-m1", now);
  const sourceFutureOrder = formatCampaignMemoryMessageOrder("source-future", futureAt);
  const fact = {
    factId: "source-fact",
    chatId: "branch-source",
    subjectEntityId: "source-alice",
    predicate: "knows",
    value: { secret: "red" },
    conditions: [],
    status: "verified",
    validFromOrder: sourceM1Order,
    validToOrder: null,
    sourceRevision: "r1",
    evidence: [{ messageId: "source-m1", quote: "knows the secret", sourceHash }],
    author: "user",
    provenance,
    manualLock: 1,
    supersedesFactId: null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  const futureFact = {
    ...fact,
    factId: "future-fact",
    predicate: "future",
    value: "must-not-copy",
    validFromOrder: sourceFutureOrder,
    manualLock: 0,
  };
  const earlyFactWithFutureEvidence = {
    ...fact,
    factId: "early-fact-with-future-evidence",
    predicate: "early-with-future-evidence",
    evidence: [
      {
        messageId: "source-future",
        quote: "future source evidence",
        sourceHash: createHash("sha256").update("future source evidence").digest("hex"),
      },
    ],
  };
  const unknownOrderFact = {
    ...fact,
    factId: "unknown-order-fact",
    predicate: "unknown-order",
    validFromOrder: "legacy|unknown-order",
  };
  const legacyFact = {
    ...fact,
    factId: "legacy-fact",
    predicate: "legacy",
    validFromOrder: sourceM1Order,
    evidence: [{ messageId: "source-m1", quote: "knows the secret" }],
  };
  const supersedingFact = {
    ...fact,
    factId: "superseding-fact",
    predicate: "knows",
    value: { secret: "blue" },
    validFromOrder: sourceM1Order,
    supersedesFactId: "source-fact",
  };
  const missingOwnerEntity = {
    ...entity,
    entityId: "missing-owner",
    owner: { type: "existing" as const, store: "characters", recordId: "missing-character" },
    attributes: { futureSecret: "must-not-project" },
  };
  const missingOwnerFact = {
    ...fact,
    factId: "missing-owner-fact",
    subjectEntityId: "missing-owner",
    predicate: "depends",
    validFromOrder: sourceM1Order,
  };
  const unavailablePredecessorEntity = {
    ...missingOwnerEntity,
    entityId: "unavailable-predecessor",
    attributes: {},
  };
  const availableSupersederEntity = {
    ...entity,
    entityId: "available-superseder",
    owner: { type: "registry" as const, store: "campaign-memory" as const, recordId: "available-superseder" },
  };
  const unavailablePredecessorFact = {
    ...fact,
    factId: "unavailable-predecessor-fact",
    subjectEntityId: "unavailable-predecessor",
    predicate: "old",
    validFromOrder: sourceM1Order,
  };
  const dependentSupersederFact = {
    ...fact,
    factId: "dependent-superseder-fact",
    subjectEntityId: "available-superseder",
    predicate: "new",
    validFromOrder: sourceM1Order,
    supersedesFactId: "unavailable-predecessor-fact",
  };
  const temporalFact = {
    ...fact,
    factId: "temporal-fact",
    predicate: "temporal",
    validFromOrder: sourceM1Order,
  };
  const missingTemporalFact = {
    ...fact,
    factId: "missing-temporal-fact",
    predicate: "missing-temporal",
    validFromOrder: formatCampaignMemoryMessageOrder("source-0", now),
  };
  const reorderedTieFact = {
    ...fact,
    factId: "reordered-tie-fact",
    predicate: "reordered-tie",
    validFromOrder: formatCampaignMemoryMessageOrder("source-tie-a", now),
    evidence: [
      {
        messageId: "source-tie-a",
        quote: "tie evidence",
        sourceHash: createHash("sha256").update("tie evidence").digest("hex"),
      },
    ],
  };
  await db.insert(campaignMemoryFacts).values([
    {
      ...fact,
      value: JSON.stringify(fact.value),
      conditions: "[]",
      evidence: JSON.stringify(fact.evidence),
      provenance: JSON.stringify(provenance),
    },
    {
      ...futureFact,
      value: JSON.stringify(futureFact.value),
      conditions: "[]",
      evidence: JSON.stringify(futureFact.evidence),
      provenance: JSON.stringify(provenance),
    },
    {
      ...earlyFactWithFutureEvidence,
      value: JSON.stringify(earlyFactWithFutureEvidence.value),
      conditions: "[]",
      evidence: JSON.stringify(earlyFactWithFutureEvidence.evidence),
      provenance: JSON.stringify(provenance),
    },
    {
      ...unknownOrderFact,
      value: JSON.stringify(unknownOrderFact.value),
      conditions: "[]",
      evidence: JSON.stringify(unknownOrderFact.evidence),
      provenance: JSON.stringify(provenance),
    },
    {
      ...legacyFact,
      value: JSON.stringify(legacyFact.value),
      conditions: "[]",
      evidence: JSON.stringify(legacyFact.evidence),
      provenance: JSON.stringify(provenance),
    },
    {
      ...supersedingFact,
      value: JSON.stringify(supersedingFact.value),
      conditions: "[]",
      evidence: JSON.stringify(supersedingFact.evidence),
      provenance: JSON.stringify(provenance),
    },
    {
      ...missingOwnerFact,
      value: JSON.stringify(missingOwnerFact.value),
      conditions: "[]",
      evidence: JSON.stringify(missingOwnerFact.evidence),
      provenance: JSON.stringify(provenance),
    },
    {
      ...unavailablePredecessorFact,
      value: JSON.stringify(unavailablePredecessorFact.value),
      conditions: "[]",
      evidence: JSON.stringify(unavailablePredecessorFact.evidence),
      provenance: JSON.stringify(provenance),
    },
    {
      ...dependentSupersederFact,
      value: JSON.stringify(dependentSupersederFact.value),
      conditions: "[]",
      evidence: JSON.stringify(dependentSupersederFact.evidence),
      provenance: JSON.stringify(provenance),
    },
    {
      ...temporalFact,
      value: JSON.stringify(temporalFact.value),
      conditions: "[]",
      evidence: JSON.stringify(temporalFact.evidence),
      provenance: JSON.stringify(provenance),
    },
    {
      ...missingTemporalFact,
      value: JSON.stringify(missingTemporalFact.value),
      conditions: "[]",
      evidence: JSON.stringify(missingTemporalFact.evidence),
      provenance: JSON.stringify(provenance),
    },
    {
      ...reorderedTieFact,
      value: JSON.stringify(reorderedTieFact.value),
      conditions: "[]",
      evidence: JSON.stringify(reorderedTieFact.evidence),
      provenance: JSON.stringify(provenance),
    },
  ]);
  await db.insert(campaignMemoryEntities).values({
    ...missingOwnerEntity,
    owner: JSON.stringify(missingOwnerEntity.owner),
    aliases: "[]",
    tags: "[]",
    attributes: JSON.stringify(missingOwnerEntity.attributes),
    provenance: JSON.stringify(provenance),
    manualLock: 0,
  });
  await db.insert(campaignMemoryEntities).values([
    {
      ...unavailablePredecessorEntity,
      owner: JSON.stringify(unavailablePredecessorEntity.owner),
      aliases: "[]",
      tags: "[]",
      attributes: JSON.stringify(unavailablePredecessorEntity.attributes),
      provenance: JSON.stringify(provenance),
      manualLock: 0,
    },
    {
      ...availableSupersederEntity,
      owner: JSON.stringify(availableSupersederEntity.owner),
      aliases: "[]",
      tags: "[]",
      attributes: JSON.stringify(availableSupersederEntity.attributes),
      provenance: JSON.stringify(provenance),
      manualLock: 1,
    },
  ]);
  await db.insert(campaignMemoryKnowledge).values({
    knowledgeId: "superseding-knowledge",
    chatId: "branch-source",
    holderEntityId: "source-alice",
    factId: "superseding-fact",
    epistemicState: "knows",
    learnedFrom: JSON.stringify(fact.evidence),
    learnedAtOrder: sourceM1Order,
    confidence: "high",
    provenance: JSON.stringify(provenance),
    manualLock: 0,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(campaignMemoryKnowledge).values({
    knowledgeId: "dependent-superseder-knowledge",
    chatId: "branch-source",
    holderEntityId: "available-superseder",
    factId: "dependent-superseder-fact",
    epistemicState: "knows",
    learnedFrom: JSON.stringify(fact.evidence),
    learnedAtOrder: sourceM1Order,
    confidence: "high",
    provenance: JSON.stringify(provenance),
    manualLock: 0,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  const first = await projectCampaignMemoryBranch(db, {
    sourceChatId: "branch-source",
    targetChatId: "branch-target",
    cutoffOrder: sourceM1Order,
    messageIdMap: { "source-m1": "target-m1", "source-future": "target-future" },
    operationId: "branch-op-1",
  });
  assert.equal(first.copied.entities, 1);
  assert.equal(first.copied.facts, 3);
  assert.equal(first.copied.knowledge, 1);
  assert.equal(
    first.held.filter((item) => item.recordType === "fact").length,
    9,
    "future, early-with-future-evidence, unknown-order, legacy, unmapped-temporal, missing-owner, unavailable predecessor, and dependent superseder facts are reported as held",
  );
  assert.ok(
    first.held.some((item) => item.recordId === "legacy-fact" && item.reason.includes("sourceHash")),
    "missing sourceHash is fail-closed",
  );
  assert.ok(
    first.held.some((item) => item.recordId === "missing-owner" && item.recordType === "entity"),
    "unavailable owners are held without aborting the projection",
  );
  assert.ok(
    first.held.some((item) => item.recordId === "missing-owner-fact" && item.reason.includes("unavailable owner")),
    "dependent facts are dropped when their owner is unavailable",
  );
  assert.ok(
    first.held.some(
      (item) => item.recordId === "early-fact-with-future-evidence" && item.reason.includes("after the branch cutoff"),
    ),
    "early records cannot cite future branch evidence",
  );
  assert.ok(
    first.held.some((item) => item.recordId === "unknown-order-fact" && item.reason.includes("temporal order")),
    "unknown temporal order is held",
  );
  assert.ok(
    first.held.some((item) => item.recordId === "unavailable-predecessor-fact"),
    "unavailable predecessor is held",
  );
  assert.ok(
    first.held.some((item) => item.recordId === "dependent-superseder-fact"),
    "superseder is held when its predecessor is unavailable",
  );
  assert.ok(
    first.held.some((item) => item.recordId === "dependent-superseder-knowledge"),
    "knowledge depending on a removed superseder is held",
  );
  assert.ok(
    first.idMap["source-fact"] && first.idMap["superseding-fact"],
    "both sides of a valid supersession are copied",
  );
  const projectedSuperseding = (
    await db.select().from(campaignMemoryFacts).where(eq(campaignMemoryFacts.factId, first.idMap["superseding-fact"]!))
  ).at(0);
  assert.equal(
    projectedSuperseding?.supersedesFactId,
    first.idMap["source-fact"],
    "supersession link is remapped only after both records are eligible",
  );
  assert.equal(first.idMap["missing-owner"], undefined, "idMap contains only copied records");
  assert.notEqual(first.idMap[entity.entityId], entity.entityId, "internal entity ID is remapped");
  const projectedEntity = (
    await db
      .select()
      .from(campaignMemoryEntities)
      .where(eq(campaignMemoryEntities.entityId, first.idMap[entity.entityId]!))
  ).at(0);
  assert.deepEqual(
    JSON.parse(projectedEntity?.attributes ?? "{}"),
    {},
    "unordered entity metadata is not projected across the cutoff",
  );
  assert.equal(first.messageIdMap["source-m1"], "target-m1");
  const ordered = await projectCampaignMemoryBranch(db, {
    sourceChatId: "branch-source",
    targetChatId: "branch-target-order",
    cutoffOrder: sourceM1Order,
    messageIdMap: { "source-m1": "target-order-m1" },
    operationId: "branch-op-order",
  });
  assert.ok(ordered.idMap["temporal-fact"], "m1 temporal fact is copied when its source message is mapped");
  const projectedTemporal = (
    await db.select().from(campaignMemoryFacts).where(eq(campaignMemoryFacts.factId, ordered.idMap["temporal-fact"]!))
  ).at(0);
  assert.equal(
    projectedTemporal?.validFromOrder,
    formatCampaignMemoryMessageOrder("target-order-m1", now),
    "temporal order is remapped to the target message ID",
  );
  assert.equal(
    JSON.parse(projectedTemporal?.provenance ?? "{}").origin.sourceOrders.validFromOrder,
    sourceM1Order,
    "source temporal order remains auditable in provenance",
  );
  const missingTemporal = await projectCampaignMemoryBranch(db, {
    sourceChatId: "branch-source",
    targetChatId: "branch-target-missing",
    cutoffOrder: sourceM1Order,
    messageIdMap: { "source-m1": "target-missing-m1" },
    operationId: "branch-op-missing-order",
  });
  assert.equal(missingTemporal.idMap["missing-temporal-fact"], undefined, "an unmapped temporal source is not copied");
  assert.ok(
    missingTemporal.held.some(
      (item) => item.recordId === "missing-temporal-fact" && item.reason.includes("temporal order"),
    ),
    "unmapped temporal source is visibly held",
  );
  const reordered = await projectCampaignMemoryBranch(db, {
    sourceChatId: "branch-source",
    targetChatId: "branch-target-tie",
    cutoffOrder: formatCampaignMemoryMessageOrder("source-tie-b", now),
    messageIdMap: { "source-tie-a": "target-tie-z", "source-tie-b": "target-tie-a" },
    operationId: "branch-op-reordered-tie",
  });
  assert.equal(
    reordered.idMap["reordered-tie-fact"],
    undefined,
    "equal-timestamp ID reordering holds temporal records",
  );
  assert.ok(
    reordered.held.some((item) => item.recordId === "reordered-tie-fact" && item.reason.includes("reordered")),
    "equal-timestamp reorder is visibly held",
  );
  const retry = await projectCampaignMemoryBranch(db, {
    sourceChatId: "branch-source",
    targetChatId: "branch-target",
    cutoffOrder: sourceM1Order,
    messageIdMap: { "source-m1": "target-m1", "source-future": "target-future" },
    operationId: "branch-op-1",
  });
  assert.deepEqual(retry, first, "duplicate retry replays the committed projection");
  await db.insert(campaignMemoryFacts).values({
    ...(await db.select().from(campaignMemoryFacts).limit(1))[0]!,
    factId: "bad-cross-chat",
    chatId: "branch-source",
    subjectEntityId: "foreign-entity",
  });
  await assert.rejects(
    () =>
      projectCampaignMemoryBranch(db, {
        sourceChatId: "branch-source",
        targetChatId: "branch-target-invalid",
        cutoffOrder: sourceM1Order,
        messageIdMap: { "source-m1": "target-m1", "source-future": "target-future" },
        operationId: "branch-op-invalid",
      }),
    (error) => error instanceof CampaignMemoryBranchError && error.code === "CAMPAIGN_MEMORY_INVALID_REFERENCE",
  );
  assert.equal(
    (await db.select().from(campaignMemoryEntities).where(eq(campaignMemoryEntities.chatId, "branch-target-invalid")))
      .length,
    0,
    "invalid cross-chat references roll back all target writes",
  );
  await db._fileStore.close();
  console.log("Campaign memory branch regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
