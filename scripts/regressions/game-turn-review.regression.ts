import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpatialContextSnapshot } from "@marinara-engine/shared";
import {
  chats,
  gameStateSnapshots,
  messages,
  spatialContextSnapshots,
} from "../../packages/server/src/db/schema/index.js";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { and, eq } from "../../packages/server/src/db/file-query.js";
import { createChatsStorage } from "../../packages/server/src/services/storage/chats.storage.js";
import {
  correctGameTurnReview,
  applyGameTurnClock,
  getGameTurnReview,
} from "../../packages/server/src/services/game/turn-review.service.js";
import { sceneTurnHash } from "../../packages/server/src/services/game/scene-timeline-model.js";
import { readSceneTimeline } from "../../packages/server/src/services/game/scene-timeline.service.js";
import {
  registerCapabilityService,
  resetCapabilityServices,
} from "../../packages/server/src/services/capability-packages/capability-service-registry.service.js";

const root = mkdtempSync(join(tmpdir(), "marinara-turn-review-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";

const mapSnapshot = (row: typeof spatialContextSnapshots.$inferSelect): SpatialContextSnapshot => ({
  id: row.id,
  chatId: row.chatId,
  messageId: row.messageId,
  swipeIndex: row.swipeIndex,
  currentLocationId: row.currentLocationId,
  definitionRevision: row.definitionRevision,
  source: row.source as SpatialContextSnapshot["source"],
  transitionCommandId: row.transitionCommandId,
  transitionPayloadHash: row.transitionPayloadHash,
  createdAt: row.createdAt,
});

try {
  const db = await createFileNativeDB();
  const release = registerCapabilityService("hierarchical-maps:storage", {
    create: () => ({
      async getById(id: string, chatId?: string) {
        const row = (await db.select().from(spatialContextSnapshots)).find(
          (x) => x.id === id && (!chatId || x.chatId === chatId),
        );
        return row ? mapSnapshot(row) : null;
      },
      async getByAnchor(chatId: string, messageId: string, swipeIndex: number) {
        const row = (await db.select().from(spatialContextSnapshots)).find(
          (x) => x.chatId === chatId && x.messageId === messageId && x.swipeIndex === swipeIndex,
        );
        return row ? mapSnapshot(row) : null;
      },
      async getByCommand(chatId: string, commandId: string) {
        const row = (await db.select().from(spatialContextSnapshots)).find(
          (x) => x.chatId === chatId && x.transitionCommandId === commandId,
        );
        return row ? mapSnapshot(row) : null;
      },
      async listByAnchors(chatId: string, anchors: Array<{ messageId: string; swipeIndex: number }>) {
        return (await db.select().from(spatialContextSnapshots))
          .filter(
            (x) =>
              x.chatId === chatId && anchors.some((a) => a.messageId === x.messageId && a.swipeIndex === x.swipeIndex),
          )
          .map(mapSnapshot);
      },
      async listForChat(chatId: string) {
        return (await db.select().from(spatialContextSnapshots)).filter((x) => x.chatId === chatId).map(mapSnapshot);
      },
      async hasMessageSnapshots(chatId: string) {
        return (await db.select().from(spatialContextSnapshots)).some((x) => x.chatId === chatId && x.messageId !== "");
      },
      async getLatest(chatId: string) {
        const rows = (await db.select().from(spatialContextSnapshots))
          .filter((x) => x.chatId === chatId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return rows[0] ? mapSnapshot(rows[0]) : null;
      },
      async getBootstrap(chatId: string) {
        const row = (await db.select().from(spatialContextSnapshots)).find(
          (x) => x.chatId === chatId && x.messageId === "",
        );
        return row ? mapSnapshot(row) : null;
      },
      async create(input: any) {
        await db.insert(spatialContextSnapshots).values(input);
        return mapSnapshot(input);
      },
      async replaceBootstrap(input: any) {
        await db
          .delete(spatialContextSnapshots)
          .where(and(eq(spatialContextSnapshots.chatId, input.chatId), eq(spatialContextSnapshots.messageId, "")));
        await db.insert(spatialContextSnapshots).values(input);
        return mapSnapshot(input);
      },
      async replaceAtAnchor(input: any) {
        await db
          .delete(spatialContextSnapshots)
          .where(
            and(
              eq(spatialContextSnapshots.chatId, input.chatId),
              eq(spatialContextSnapshots.messageId, input.messageId),
              eq(spatialContextSnapshots.swipeIndex, input.swipeIndex),
            ),
          );
        await db.insert(spatialContextSnapshots).values(input);
        return mapSnapshot(input);
      },
    }),
  });

  const chatId = "turn-review-chat",
    previousId = "turn-review-previous",
    messageId = "turn-review-current";
  const now = "2026-09-26T10:00:00.000Z",
    later = "2026-09-26T10:01:00.000Z";
  const content = "After 20 minutes the party enters Hall. Alice leaves the hall. Bob remains by the gate.";
  const sourceHash = createHash("sha256").update(content).digest("hex");
  const scene = {
    visits: [
      {
        location: "Hall",
        present: ["Alice", "Bob"],
        participants: ["Alice", "Bob"],
        presenceEvidence: [
          { name: "Alice", quote: "the party enters Hall" },
          { name: "Bob", quote: "Bob remains by the gate." },
        ],
        departures: [{ name: "Alice", quote: "Alice leaves the hall." }],
        facts: [{ text: "The party enters Hall.", quote: "After 20 minutes the party enters Hall." }],
      },
    ],
  };
  const previousHash = sceneTurnHash(
    sceneTurnHash("scene-timeline-v3", "[]"),
    `${previousId}:0:assistant: They wait for 20 minutes.`,
  );
  const hash = sceneTurnHash(
    sceneTurnHash(previousHash, `turn-review-user:0:user: After 20 minutes, the party reaches Hall.`),
    `${messageId}:0:assistant: ${content}`,
  );
  await db.insert(chats).values({
    id: chatId,
    name: "Turn review",
    mode: "game",
    characterIds: "[]",
    metadata: JSON.stringify({
      gameTime: { day: 3, hour: 14, minute: 0 },
      gameNpcs: [
        { id: "npc-bob", name: "Bob", emoji: "🧭", description: "Guide", location: "Hall", reputation: 0, notes: [] },
        {
          id: "npc-bob-alt",
          name: "Bob",
          emoji: "🧭",
          description: "A second Bob",
          location: "Hall",
          reputation: 0,
          notes: [],
        },
        {
          id: "npc-clara",
          characterId: "character-clara",
          name: "Clara",
          emoji: "🗝️",
          description: "Scout",
          location: "Hall",
          reputation: 0,
          notes: [],
        },
      ],
      spatialContext: {
        locations: [
          { id: "gate", name: "Gate" },
          { id: "hall", name: "Hall" },
        ],
      },
    }),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(messages).values([
    {
      id: previousId,
      chatId,
      role: "assistant",
      content: "They wait for 20 minutes.",
      activeSwipeIndex: 0,
      extra: JSON.stringify({
        gameTurnClock: { after: { day: 3, hour: 13, minute: 40 } },
        gameSceneTimeline: {
          visits: [
            {
              location: "Gate",
              present: ["Bob"],
              participants: ["Bob"],
              presenceEvidence: [{ name: "Bob", quote: "They wait for 20 minutes." }],
              departures: [],
              facts: [],
            },
          ],
          hash: previousHash,
        },
      }),
      createdAt: now,
    },
    {
      id: "turn-review-user",
      chatId,
      role: "user",
      content: "After 20 minutes, the party reaches Hall.",
      activeSwipeIndex: 0,
      extra: "{}",
      createdAt: "2026-09-26T10:00:30.000Z",
    },
    {
      id: messageId,
      chatId,
      role: "assistant",
      content,
      activeSwipeIndex: 0,
      extra: JSON.stringify({
        gameTurnClock: {
          before: { day: 3, hour: 13, minute: 40 },
          after: { day: 3, hour: 14, minute: 0 },
          sourceHash,
          timeEvidence: {
            messageId: "turn-review-user",
            swipeIndex: 0,
            quote: "After 20 minutes, the party reaches Hall.",
          },
        },
        gameSceneTimeline: { ...scene, hash },
      }),
      createdAt: later,
    },
  ]);
  await db.insert(gameStateSnapshots).values([
    {
      id: "state-prev",
      chatId,
      messageId: previousId,
      swipeIndex: 0,
      time: "Day 3, 13:40",
      location: "Gate",
      presentCharacters: JSON.stringify([{ name: "Bob" }]),
      createdAt: now,
    },
    {
      id: "state-current",
      chatId,
      messageId,
      swipeIndex: 0,
      time: "Day 3, 13:40",
      location: "Hall",
      presentCharacters: JSON.stringify([{ name: "Alice" }, { name: "Bob" }]),
      createdAt: later,
    },
  ]);
  await db.insert(spatialContextSnapshots).values([
    {
      id: "sp-prev",
      chatId,
      messageId: previousId,
      swipeIndex: 0,
      currentLocationId: "gate",
      definitionRevision: 1,
      source: "assistant_swipe",
      createdAt: now,
    },
    {
      id: "sp-current",
      chatId,
      messageId,
      swipeIndex: 0,
      currentLocationId: "hall",
      definitionRevision: 1,
      source: "assistant_swipe",
      createdAt: later,
    },
  ]);

  const review = await getGameTurnReview(db, chatId, messageId);
  assert.deepEqual(review.before.location, { id: "gate", name: "Gate" });
  assert.deepEqual(review.after.location, { id: "hall", name: "Hall" });
  assert.deepEqual(review.before.present, ["Bob"]);
  assert.deepEqual(review.after.present, ["Alice", "Bob"]);
  assert.deepEqual(review.changes.find((change) => change.id === "time")?.evidence, {
    messageId: "turn-review-user",
    swipeIndex: 0,
    quote: "After 20 minutes, the party reaches Hall.",
  });
  assert.equal(review.changes.find((change) => change.id === "presence:Alice")?.source, "recorded");
  assert.equal(review.changes.find((change) => change.id === "location")?.source, "state_only");
  await assert.rejects(
    () =>
      correctGameTurnReview(
        db,
        chatId,
        messageId,
        { revision: "stale", swipeIndex: 0, correction: { field: "location", locationId: "hall" } },
        () => false,
      ),
    /stale/,
  );
  await assert.rejects(
    () =>
      correctGameTurnReview(
        db,
        chatId,
        messageId,
        { revision: review.revision, swipeIndex: 1, correction: { field: "location", locationId: "hall" } },
        () => false,
      ),
    /stale/,
  );
  await assert.rejects(
    () =>
      correctGameTurnReview(
        db,
        chatId,
        messageId,
        { revision: review.revision, swipeIndex: 0, correction: { field: "location", locationId: "unknown" } },
        () => false,
      ),
    /Unknown canonical location/,
  );
  await assert.rejects(
    () =>
      correctGameTurnReview(
        db,
        chatId,
        messageId,
        {
          revision: review.revision,
          swipeIndex: 0,
          correction: { field: "presence", name: "Unknown", present: false },
        },
        () => false,
      ),
    /known canonical character/,
  );
  const corrected = await correctGameTurnReview(
    db,
    chatId,
    messageId,
    { revision: review.revision, swipeIndex: 0, correction: { field: "presence", name: "Alice", present: false } },
    () => false,
  );
  assert.deepEqual(corrected.after.present, ["Bob"]);
  const timeline = await readSceneTimeline(db, chatId);
  assert.equal(timeline.scenes.at(-1)?.present.includes("Alice"), false);
  await db
    .update(gameStateSnapshots)
    .set({ presentCharacters: JSON.stringify([{ name: "Bob" }, { name: "bob" }]) })
    .where(eq(gameStateSnapshots.id, "state-current"));
  const ambiguous = await getGameTurnReview(db, chatId, messageId);
  await assert.rejects(
    () =>
      correctGameTurnReview(
        db,
        chatId,
        messageId,
        { revision: ambiguous.revision, swipeIndex: 0, correction: { field: "presence", name: "Bob", present: false } },
        () => false,
      ),
    /ambiguous|canonical character/,
  );
  const addedNpc = await correctGameTurnReview(
    db,
    chatId,
    messageId,
    { revision: ambiguous.revision, swipeIndex: 0, correction: { field: "presence", name: "Clara", present: true } },
    () => false,
  );
  assert.equal(addedNpc.after.present.includes("Clara"), true);
  const addedState = JSON.parse(
    (await db.select().from(gameStateSnapshots).where(eq(gameStateSnapshots.id, "state-current")))[0]!
      .presentCharacters,
  );
  assert.deepEqual(
    addedState.find((item: any) => item.name === "Clara"),
    { name: "Clara", characterId: "character-clara" },
  );

  const rollbackReview = await getGameTurnReview(db, chatId, messageId);
  const beforeRollbackMessage = (await db.select().from(messages).where(eq(messages.id, messageId)))[0]!;
  const beforeRollbackChat = (await db.select().from(chats).where(eq(chats.id, chatId)))[0]!;
  const beforeRollbackState = (
    await db.select().from(gameStateSnapshots).where(eq(gameStateSnapshots.id, "state-current"))
  )[0]!;
  const beforeRollbackSpatial = (
    await db.select().from(spatialContextSnapshots).where(eq(spatialContextSnapshots.id, "sp-current"))
  )[0]!;
  const originalTransaction = db.transaction.bind(db);
  (db as any).transaction = (callback: (transaction: any) => Promise<unknown>) =>
    originalTransaction(async (transaction: any) => {
      const proxied = new Proxy(transaction, {
        get(target, property) {
          if (property === "update") {
            return (table: unknown) => {
              if (table === spatialContextSnapshots) throw new Error("forced spatial transaction failure");
              return target.update(table);
            };
          }
          const value = target[property as keyof typeof target];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return callback(proxied);
    });
  try {
    await assert.rejects(
      () =>
        correctGameTurnReview(
          db,
          chatId,
          messageId,
          { revision: rollbackReview.revision, swipeIndex: 0, correction: { field: "location", locationId: "gate" } },
          () => false,
        ),
      /forced spatial transaction failure/,
    );
  } finally {
    (db as any).transaction = originalTransaction;
  }
  assert.equal(
    (await db.select().from(messages).where(eq(messages.id, messageId)))[0]!.extra,
    beforeRollbackMessage.extra,
  );
  assert.equal((await db.select().from(chats).where(eq(chats.id, chatId)))[0]!.metadata, beforeRollbackChat.metadata);
  assert.equal(
    (await db.select().from(gameStateSnapshots).where(eq(gameStateSnapshots.id, "state-current")))[0]!.location,
    beforeRollbackState.location,
  );
  assert.equal(
    (await db.select().from(spatialContextSnapshots).where(eq(spatialContextSnapshots.id, "sp-current")))[0]!
      .currentLocationId,
    beforeRollbackSpatial.currentLocationId,
  );

  const clockReview = await applyGameTurnClock(
    db,
    chatId,
    messageId,
    { swipeIndex: 0, elapsedMinutes: 20, timeEvidence: "After 20 minutes the party enters Hall." },
    () => false,
  );
  assert.deepEqual(clockReview.after.time, { day: 3, hour: 14, minute: 0 });
  const retry = await applyGameTurnClock(
    db,
    chatId,
    messageId,
    { swipeIndex: 0, elapsedMinutes: 20, timeEvidence: "After 20 minutes the party enters Hall." },
    () => false,
  );
  assert.deepEqual(retry.after.time, clockReview.after.time);
  await assert.rejects(
    () =>
      applyGameTurnClock(
        db,
        chatId,
        messageId,
        { swipeIndex: 0, elapsedMinutes: 20, timeEvidence: "They wait for 20 minutes." },
        () => false,
      ),
    /exact source quote/,
  );
  await assert.rejects(
    () =>
      applyGameTurnClock(
        db,
        chatId,
        messageId,
        { swipeIndex: 0, elapsedMinutes: 1, timeEvidence: "After 20 minutes the party enters Hall." },
        () => false,
      ),
    /already applied|duration|changed/,
  );
  await assert.rejects(
    () =>
      applyGameTurnClock(
        db,
        chatId,
        messageId,
        { swipeIndex: 0, elapsedMinutes: 1, timeEvidence: "not a source quote" },
        () => false,
      ),
    /exact source quote/,
  );
  await assert.rejects(
    () =>
      applyGameTurnClock(
        db,
        chatId,
        messageId,
        { swipeIndex: 0, elapsedMinutes: 1, timeEvidence: "After 20 minutes the party enters Hall." },
        () => true,
      ),
    /generation/,
  );
  await assert.rejects(
    () =>
      applyGameTurnClock(
        db,
        chatId,
        previousId,
        { swipeIndex: 0, elapsedMinutes: 1, timeEvidence: "They wait." },
        () => false,
      ),
    /latest/,
  );
  await createChatsStorage(db).updateMessageContent(messageId, `${content} Edited.`);
  await assert.rejects(
    () =>
      applyGameTurnClock(
        db,
        chatId,
        messageId,
        { swipeIndex: 0, elapsedMinutes: 20, timeEvidence: "After 20 minutes the party enters Hall." },
        () => false,
      ),
    /content changed/,
  );
  await createChatsStorage(db).updateMessageContent(messageId, content);
  const manuallyCorrectedExtra = JSON.parse(
    (await db.select().from(messages).where(eq(messages.id, messageId)))[0]!.extra,
  );
  manuallyCorrectedExtra.gameTurnClock = {
    before: { day: 3, hour: 13, minute: 40 },
    after: { day: 3, hour: 14, minute: 0 },
    elapsedMinutes: 20,
    sourceHash,
    timeEvidence: { messageId, swipeIndex: 0, quote: "After 20 minutes the party enters Hall." },
    appliedKey: "previous-application",
    manualCorrection: true,
  };
  await db
    .update(messages)
    .set({ extra: JSON.stringify(manuallyCorrectedExtra) })
    .where(eq(messages.id, messageId));
  await assert.rejects(
    () =>
      applyGameTurnClock(
        db,
        chatId,
        messageId,
        { swipeIndex: 0, elapsedMinutes: 20, timeEvidence: "After 20 minutes the party enters Hall." },
        () => false,
      ),
    /manually corrected/,
  );

  release();
  await db._fileStore.close();
  process.stdout.write("game-turn-review regression passed.\n");
} finally {
  resetCapabilityServices();
  rmSync(root, { recursive: true, force: true });
}
