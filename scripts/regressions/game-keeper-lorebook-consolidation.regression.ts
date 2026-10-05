import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const storageDir = mkdtempSync(join(tmpdir(), "marinara-keeper-consolidation-"));
process.env.FILE_STORAGE_DIR = storageDir;

const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
const { eq } = await import("../../packages/server/src/db/file-query.js");
const { chats, lorebookCharacterLinks, lorebookEntries, lorebookFolders, lorebookPersonaLinks, lorebooks } =
  await import("../../packages/server/src/db/schema/index.js");
const { consolidateGameKeeperLorebooks, planGameKeeperLorebookConsolidation } =
  await import("../../packages/server/src/services/game/game-keeper-lorebook.js");
let failNextWrite = false;

const now = new Date().toISOString();
const { createLorebooksStorage } = await import("../../packages/server/src/services/storage/lorebooks.storage.js");
const { resetFeatureSettingsForTests } =
  await import("../../packages/server/src/services/features/feature-settings.js");
const { GAME_LOREBOOK_KEEPER_SOURCE_ID: sourceAgentId } =
  await import("../../packages/server/src/services/lorebook/game-lorebook-scope.js");
const serverRequire = createRequire(join(process.cwd(), "package.json"));
const Fastify = serverRequire("fastify");
const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");
const makeChat = (id: string, gameSessionNumber: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  mode: "game",
  groupId: "campaign-a",
  metadata: JSON.stringify({ gameId: "campaign-a", gameSessionNumber, ...extra }),
  createdAt: now,
  updatedAt: now,
});
const makeBook = (id: string, chatId: string | null, createdAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  description: "",
  category: "world",
  chatId,
  sourceAgentId,
  isGlobal: "false",
  characterId: null,
  personaId: null,
  enabled: "true",
  tags: "[]",
  createdAt,
  updatedAt: now,
  ...extra,
});
const makeEntry = (id: string, lorebookId: string, originChatId: string) => ({
  id,
  lorebookId,
  name: id,
  content: `content-${id}`,
  dynamicState: JSON.stringify({ keeperSourceChatId: originChatId }),
  createdAt: now,
  updatedAt: now,
});

try {
  const db = await createFileNativeDB({
    beforeTableWrite: async () => {
      if (!failNextWrite) return;
      failNextWrite = false;
      throw new Error("injected Keeper apply write failure");
    },
  });
  const app = Fastify();
  app.decorate("db", db);
  await app.register(gameRoutes, { prefix: "/api/game" });
  await app.ready();
  await db.insert(chats).values([
    makeChat("session-1", 1),
    makeChat("session-2", 2, {
      activeLorebookIds: ["donor"],
      excludedLorebookIds: ["donor"],
      gameLorebookKeeperLorebookId: "donor",
    }),
    makeChat("session-4", 4, {
      activeLorebookIds: ["donor", "empty-current-book"],
      excludedLorebookIds: ["donor", "empty-current-book"],
      gameLorebookKeeperLorebookId: "empty-current-book",
    }),
    makeChat("future-session", 5),
    makeChat("empty-future-session", 6, {
      activeLorebookIds: ["empty-future-book"],
      excludedLorebookIds: ["empty-future-book"],
      gameLorebookKeeperLorebookId: "empty-future-book",
    }),
    makeChat("branch", 3, { branchParentChatId: "session-2" }),
    makeChat("duplicate-a", 9),
    makeChat("duplicate-b", 9),
    makeChat("empty-duplicate-session", 9, {
      activeLorebookIds: ["empty-duplicate-book"],
      excludedLorebookIds: ["empty-duplicate-book"],
      gameLorebookKeeperLorebookId: "empty-duplicate-book",
    }),
    makeChat("empty-missing-session", 7, {
      gameSessionNumber: undefined,
      activeLorebookIds: ["empty-missing-book"],
      excludedLorebookIds: ["empty-missing-book"],
      gameLorebookKeeperLorebookId: "empty-missing-book",
    }),
    makeChat("empty-past-session", 3, {
      activeLorebookIds: ["empty-past-book"],
      excludedLorebookIds: ["empty-past-book"],
      gameLorebookKeeperLorebookId: "empty-past-book",
    }),
    makeChat("other-campaign", 2, { gameId: "campaign-b" }),
    { ...makeChat("non-game-sharing-campaign", 3), mode: "chat" },
    makeChat("race-current", 2, { gameId: "race-campaign" }),
    makeChat("race-donor-chat", 1, { gameId: "race-campaign" }),
  ]);
  await db
    .insert(lorebooks)
    .values([
      makeBook("canonical", "session-1", "2026-01-01T00:00:00.000Z"),
      makeBook("donor", "session-2", "2026-01-02T00:00:00.000Z"),
      makeBook("empty-current-book", "session-4", "2026-01-02T12:00:00.000Z"),
      makeBook("future-book", "future-session", "2026-01-03T00:00:00.000Z"),
      makeBook("empty-future-book", "empty-future-session", "2026-01-03T12:00:00.000Z"),
      makeBook("branch-book", "branch", "2026-01-04T00:00:00.000Z"),
      makeBook("duplicate-book", "duplicate-a", "2026-01-05T00:00:00.000Z"),
      makeBook("empty-duplicate-book", "empty-duplicate-session", "2026-01-05T12:00:00.000Z"),
      makeBook("empty-missing-book", "empty-missing-session", "2026-01-05T18:00:00.000Z"),
      makeBook("empty-past-book", "empty-past-session", "2026-01-05T21:00:00.000Z"),
      makeBook("other-book", "other-campaign", "2026-01-06T00:00:00.000Z"),
      makeBook("global-book", null, "2026-01-07T00:00:00.000Z", { isGlobal: "true" }),
      makeBook("race-canonical", "race-current", "2026-01-08T00:00:00.000Z"),
      makeBook("race-donor", "race-donor-chat", "2026-01-09T00:00:00.000Z"),
    ]);
  await db
    .insert(lorebookEntries)
    .values([
      makeEntry("eligible-entry", "donor", "session-2"),
      makeEntry("future-entry", "future-book", "future-session"),
      makeEntry("branch-entry", "branch-book", "branch"),
      makeEntry("ambiguous-entry", "duplicate-book", "duplicate-a"),
      makeEntry("unrelated-entry", "other-book", "other-campaign"),
      makeEntry("race-entry", "race-donor", "race-donor-chat"),
    ]);
  await db.insert(lorebookFolders).values([
    { id: "donor-folder", lorebookId: "donor", name: "Preserved folder", createdAt: now, updatedAt: now },
    {
      id: "empty-current-folder",
      lorebookId: "empty-current-book",
      name: "Current folder",
      createdAt: now,
      updatedAt: now,
    },
    { id: "empty-future-folder", lorebookId: "empty-future-book", name: "Future folder", createdAt: now, updatedAt: now },
    {
      id: "empty-duplicate-folder",
      lorebookId: "empty-duplicate-book",
      name: "Duplicate folder",
      createdAt: now,
      updatedAt: now,
    },
    { id: "empty-missing-folder", lorebookId: "empty-missing-book", name: "Missing folder", createdAt: now, updatedAt: now },
    { id: "empty-past-folder", lorebookId: "empty-past-book", name: "Past folder", createdAt: now, updatedAt: now },
  ]);
  await db.insert(lorebookCharacterLinks).values([
    { id: "canonical-character", lorebookId: "canonical", characterId: "character-a", createdAt: now },
    { id: "donor-character-same", lorebookId: "donor", characterId: "character-a", createdAt: now },
    { id: "donor-character-new", lorebookId: "donor", characterId: "character-b", createdAt: now },
    { id: "empty-current-character", lorebookId: "empty-current-book", characterId: "character-current", createdAt: now },
    { id: "empty-future-character", lorebookId: "empty-future-book", characterId: "character-future", createdAt: now },
    {
      id: "empty-duplicate-character",
      lorebookId: "empty-duplicate-book",
      characterId: "character-duplicate",
      createdAt: now,
    },
    { id: "empty-missing-character", lorebookId: "empty-missing-book", characterId: "character-missing", createdAt: now },
    { id: "empty-past-character", lorebookId: "empty-past-book", characterId: "character-past", createdAt: now },
  ]);
  await db.insert(lorebookPersonaLinks).values([
    { id: "donor-persona", lorebookId: "donor", personaId: "persona-a", createdAt: now },
    { id: "empty-current-persona", lorebookId: "empty-current-book", personaId: "persona-current", createdAt: now },
    { id: "empty-future-persona", lorebookId: "empty-future-book", personaId: "persona-future", createdAt: now },
    {
      id: "empty-duplicate-persona",
      lorebookId: "empty-duplicate-book",
      personaId: "persona-duplicate",
      createdAt: now,
    },
    { id: "empty-missing-persona", lorebookId: "empty-missing-book", personaId: "persona-missing", createdAt: now },
    { id: "empty-past-persona", lorebookId: "empty-past-book", personaId: "persona-past", createdAt: now },
  ]);
  await db._fileStore.flush();

  resetFeatureSettingsForTests({});
  let disabledOperations = 0;
  const disabledDb = new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (!["select", "insert", "update", "delete", "transaction"].includes(String(property)))
        return typeof value === "function" ? value.bind(target) : value;
      return (...args: unknown[]) => {
        disabledOperations += 1;
        return Reflect.apply(value, target, args);
      };
    },
  });
  const disabledApp = Fastify();
  disabledApp.decorate("db", disabledDb);
  await disabledApp.register(gameRoutes, { prefix: "/api/game" });
  await disabledApp.ready();
  for (const apply of [false, true]) {
    const disabledResponse = await disabledApp.inject({
      method: "POST",
      url: "/api/game/session/lorebook-keeper/consolidate",
      payload: { chatId: "session-4", apply },
    });
    assert.equal(disabledResponse.statusCode, 403, "Keeper routes refuse while the shared feature switch is off");
    assert.equal(JSON.parse(disabledResponse.payload).error, "FEATURE_DISABLED");
  }
  assert.equal(disabledOperations, 0, "default-OFF preview and apply refuse before any database work");
  await disabledApp.close();
  resetFeatureSettingsForTests({ gameKeeperConsolidation: true });

  await assert.rejects(
    planGameKeeperLorebookConsolidation(db, "non-game-sharing-campaign"),
    /GAME_CHAT_NOT_GAME/,
    "a non-game chat cannot initiate campaign-wide Keeper work through shared gameId/groupId metadata",
  );
  for (const apply of [false, true]) {
    const nonGameResponse = await app.inject({
      method: "POST",
      url: "/api/game/session/lorebook-keeper/consolidate",
      payload: { chatId: "non-game-sharing-campaign", apply },
    });
    assert.equal(nonGameResponse.statusCode, 400);
    assert.equal(JSON.parse(nonGameResponse.payload).error, "GAME_CHAT_NOT_GAME");
  }
  assert((await db.select().from(lorebooks)).some((row) => row.id === "donor"));
  assert.equal(
    (await db.select().from(lorebookEntries)).find((row) => row.id === "eligible-entry")?.lorebookId,
    "donor",
  );

  // Simulate a concurrent actor removing the reviewed canonical between preflight and the serialized re-plan.
  let raceInjected = false;
  const raceDb = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "transaction") {
        return async (...args: Parameters<typeof db.transaction>) => {
          if (!raceInjected) {
            raceInjected = true;
            await target.delete(lorebooks).where(eq(lorebooks.id, "race-canonical"));
            await target.update(lorebooks).set({ sourceAgentId: "other-agent" }).where(eq(lorebooks.id, "race-donor"));
          }
          return target.transaction(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const raceApp = Fastify();
  raceApp.decorate("db", raceDb);
  await raceApp.register(gameRoutes, { prefix: "/api/game" });
  await raceApp.ready();
  const vanishedCanonicalResponse = await raceApp.inject({
    method: "POST",
    url: "/api/game/session/lorebook-keeper/consolidate",
    payload: { chatId: "race-current", apply: true },
  });
  assert.equal(vanishedCanonicalResponse.statusCode, 409);
  const vanishedCanonical = JSON.parse(vanishedCanonicalResponse.payload);
  assert.equal(vanishedCanonical.applied, false);
  assert.equal(vanishedCanonical.conflict, "CANONICAL_BOOK_DISAPPEARED");
  assert.equal(
    (await db.select().from(lorebookEntries)).find((row) => row.id === "race-entry")?.lorebookId,
    "race-donor",
  );
  assert((await db.select().from(lorebooks)).some((row) => row.id === "race-donor"));
  await raceApp.close();

  const preview = await planGameKeeperLorebookConsolidation(db, "session-4");
  assert.equal(preview.canonicalBookId, "canonical");
  assert.deepEqual(preview.migrateEntryIds, ["eligible-entry"]);
  assert(preview.skippedEntryIds.includes("future-entry"), "future-session entries remain in their donor book");
  assert(preview.skippedEntryIds.includes("ambiguous-entry"), "duplicate session origins are held");
  assert(!preview.candidateBookIds.includes("branch-book"), "branches are isolated");
  assert(!preview.candidateBookIds.includes("other-book"), "unrelated campaigns are isolated");
  assert(!preview.removeBookIds.includes("empty-future-book"), "an empty future-session donor is preserved");
  assert(!preview.removeBookIds.includes("empty-duplicate-book"), "an empty duplicate-session donor is preserved");
  assert(!preview.removeBookIds.includes("empty-missing-book"), "an empty donor without a session number is preserved");
  assert(preview.removeBookIds.includes("empty-past-book"), "an empty eligible past-session donor can be removed");
  assert(preview.removeBookIds.includes("empty-current-book"), "an empty current-session donor can be removed");
  assert.deepEqual(preview.duplicateSessionNumbers, [9]);

  const previewResponse = await app.inject({
    method: "POST",
    url: "/api/game/session/lorebook-keeper/consolidate",
    payload: { chatId: "session-4" },
  });
  assert.equal(previewResponse.statusCode, 200);
  assert.equal(JSON.parse(previewResponse.payload).canonicalBookId, "canonical");
  assert(
    (await db.select().from(lorebooks)).some((row) => row.id === "donor"),
    "HTTP preview is read-only by default",
  );

  // Disable the feature after the transaction re-plan's final awaited read but before write admission.
  let transactionSelects = 0;
  const wrapTransactionValue = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    return new Proxy(value, {
      get(target, property, receiver) {
        if (property === "then") {
          return (resolve: (result: unknown) => unknown, reject: (error: unknown) => unknown) =>
            Promise.resolve(target).then((result) => {
              transactionSelects += 1;
              if (transactionSelects === 5) resetFeatureSettingsForTests({});
              return resolve(result);
            }, reject);
        }
        const method = Reflect.get(target, property, receiver);
        return typeof method === "function"
          ? (...args: unknown[]) => wrapTransactionValue(Reflect.apply(method, target, args))
          : method;
      },
    });
  };
  const lateOptOutDb = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "transaction") {
        const transaction = Reflect.get(target, property, target) as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => {
          const [callback, options] = args as [(tx: unknown) => unknown, unknown?];
          return Reflect.apply(transaction, target, [
            (tx: unknown) => (callback as (tx: unknown) => unknown)(wrapTransactionValue(tx)),
            options,
          ]);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const lateOptOutApp = Fastify();
  lateOptOutApp.decorate("db", lateOptOutDb);
  await lateOptOutApp.register(gameRoutes, { prefix: "/api/game" });
  await lateOptOutApp.ready();
  const lateOptOutResponse = await lateOptOutApp.inject({
    method: "POST",
    url: "/api/game/session/lorebook-keeper/consolidate",
    payload: { chatId: "session-4", apply: true },
  });
  assert.equal(
    transactionSelects,
    5,
    "the feature was disabled after transactional re-planning and before the first write",
  );
  assert.equal(
    lateOptOutResponse.statusCode,
    403,
    "apply is refused if the switch turns off during transaction re-planning",
  );
  assert.equal(
    (await db.select().from(lorebookEntries)).find((row) => row.id === "eligible-entry")?.lorebookId,
    "donor",
    "late opt-out causes no entry migration",
  );
  assert((await db.select().from(lorebooks)).some((row) => row.id === "donor"));
  await lateOptOutApp.close();
  resetFeatureSettingsForTests({ gameKeeperConsolidation: true });

  const readOnly = await consolidateGameKeeperLorebooks(db, "session-4");
  assert.equal(readOnly.applied, false, "apply is opt-in");
  assert.equal(
    (await db.select().from(lorebookEntries)).find((row) => row.id === "eligible-entry")?.lorebookId,
    "donor",
  );

  // A preview may become stale before explicit apply. Apply must re-plan inside its transaction.
  await db
    .update(lorebookEntries)
    .set({ dynamicState: JSON.stringify({ keeperSourceChatId: "future-session" }) })
    .where(eq(lorebookEntries.id, "eligible-entry"));
  const staleApply = await consolidateGameKeeperLorebooks(db, "session-4", { apply: true });
  assert(staleApply.skippedEntryIds.includes("eligible-entry"), "apply rechecks origin eligibility");
  assert.equal(
    (await db.select().from(lorebookEntries)).find((row) => row.id === "eligible-entry")?.lorebookId,
    "donor",
  );
  assert(
    (await db.select().from(lorebooks)).some((row) => row.id === "donor"),
    "unsafe donor is retained",
  );

  await db
    .update(lorebookEntries)
    .set({ dynamicState: JSON.stringify({ keeperSourceChatId: "session-2" }) })
    .where(eq(lorebookEntries.id, "eligible-entry"));
  failNextWrite = true;
  await assert.rejects(
    consolidateGameKeeperLorebooks(db, "session-4", { apply: true }),
    /injected Keeper apply write failure/,
  );
  assert.equal(
    (await db.select().from(lorebookEntries)).find((row) => row.id === "eligible-entry")?.lorebookId,
    "donor",
    "a failed durable apply restores the in-memory donor entry",
  );
  assert((await db.select().from(lorebooks)).some((row) => row.id === "donor"));
  await db._fileStore.flush();

  const before = (await db.select().from(lorebookEntries)).map((row) => [row.id, row.content]);
  const applied = await consolidateGameKeeperLorebooks(db, "session-4", { apply: true });
  assert.equal(applied.applied, true);
  const entries = await db.select().from(lorebookEntries);
  assert.equal(entries.find((row) => row.id === "eligible-entry")?.lorebookId, "canonical");
  assert.equal(entries.find((row) => row.id === "future-entry")?.lorebookId, "future-book");
  assert.equal(entries.find((row) => row.id === "ambiguous-entry")?.lorebookId, "duplicate-book");
  assert.deepEqual(
    entries.map((row) => [row.id, row.content]),
    before,
    "consolidation preserves entry IDs and contents",
  );
  assert(!(await db.select().from(lorebooks)).some((row) => row.id === "donor"));
  assert((await db.select().from(lorebooks)).some((row) => row.id === "duplicate-book"));
  const remainingBooks = await db.select().from(lorebooks);
  for (const id of ["empty-future-book", "empty-duplicate-book", "empty-missing-book"]) {
    assert(remainingBooks.some((row) => row.id === id), `${id} remains after consolidation`);
  }
  assert(!remainingBooks.some((row) => row.id === "empty-past-book"), "eligible empty past donor is removed");
  assert(!remainingBooks.some((row) => row.id === "empty-current-book"), "eligible empty current donor is removed");

  const folders = await db.select().from(lorebookFolders);
  assert.equal(folders.find((row) => row.id === "donor-folder")?.lorebookId, "canonical");
  for (const id of ["empty-future", "empty-duplicate", "empty-missing"]) {
    assert.equal(
      folders.find((row) => row.id === `${id}-folder`)?.lorebookId,
      `${id}-book`,
      `${id} donor folder remains with its preserved book`,
    );
  }
  assert.equal(folders.find((row) => row.id === "empty-past-folder")?.lorebookId, "canonical");
  assert.equal(folders.find((row) => row.id === "empty-current-folder")?.lorebookId, "canonical");
  const characterLinks = await db.select().from(lorebookCharacterLinks);
  assert.equal(
    characterLinks.filter((row) => row.lorebookId === "canonical" && row.characterId === "character-a").length,
    1,
  );
  assert(characterLinks.some((row) => row.lorebookId === "canonical" && row.characterId === "character-b"));
  for (const [bookId, characterId] of [
    ["empty-future-book", "character-future"],
    ["empty-duplicate-book", "character-duplicate"],
    ["empty-missing-book", "character-missing"],
  ]) {
    assert(
      characterLinks.some((row) => row.lorebookId === bookId && row.characterId === characterId),
      `${bookId} keeps its character link`,
    );
  }
  assert(characterLinks.some((row) => row.lorebookId === "canonical" && row.characterId === "character-past"));
  assert(characterLinks.some((row) => row.lorebookId === "canonical" && row.characterId === "character-current"));
  const personaLinks = await db.select().from(lorebookPersonaLinks);
  for (const [bookId, personaId] of [
    ["empty-future-book", "persona-future"],
    ["empty-duplicate-book", "persona-duplicate"],
    ["empty-missing-book", "persona-missing"],
  ]) {
    assert(
      personaLinks.some((row) => row.lorebookId === bookId && row.personaId === personaId),
      `${bookId} keeps its persona link`,
    );
  }
  assert(personaLinks.some((row) => row.lorebookId === "canonical" && row.personaId === "persona-past"));
  assert(personaLinks.some((row) => row.lorebookId === "canonical" && row.personaId === "persona-current"));
  assert((await db.select().from(lorebookPersonaLinks)).some((row) => row.lorebookId === "canonical"));

  const updatedChats = await db.select().from(chats);
  for (const id of ["session-2", "session-4"]) {
    const metadata = JSON.parse(updatedChats.find((row) => row.id === id)!.metadata);
    assert.deepEqual(metadata.activeLorebookIds, ["canonical"]);
    assert.deepEqual(metadata.excludedLorebookIds, ["canonical"]);
    assert.equal(metadata.gameLorebookKeeperLorebookId, "canonical");
    const preferred = await createLorebooksStorage(db).getById(metadata.gameLorebookKeeperLorebookId);
    assert(
      preferred?.id && (preferred.chatId === id || preferred.sourceAgentId === sourceAgentId),
      "the unchanged baseline Keeper resolver accepts the rewritten source-owned preferred book",
    );
  }
  const unrelatedMetadata = JSON.parse(updatedChats.find((row) => row.id === "other-campaign")!.metadata);
  assert.deepEqual(unrelatedMetadata.activeLorebookIds ?? [], []);
  for (const [chatId, bookId] of [
    ["empty-future-session", "empty-future-book"],
    ["empty-duplicate-session", "empty-duplicate-book"],
    ["empty-missing-session", "empty-missing-book"],
  ]) {
    const donorMetadata = JSON.parse(updatedChats.find((row) => row.id === chatId)!.metadata);
    assert.deepEqual(donorMetadata.activeLorebookIds, [bookId]);
    assert.deepEqual(donorMetadata.excludedLorebookIds, [bookId]);
    assert.equal(donorMetadata.gameLorebookKeeperLorebookId, bookId);
  }
  assert.equal((await consolidateGameKeeperLorebooks(db, "session-4", { apply: true })).migrateEntryIds.length, 0);
  const repeatedApplyResponse = await app.inject({
    method: "POST",
    url: "/api/game/session/lorebook-keeper/consolidate",
    payload: { chatId: "session-4", apply: true },
  });
  assert.equal(repeatedApplyResponse.statusCode, 200);
  assert.equal(JSON.parse(repeatedApplyResponse.payload).applied, true);
  assert.equal(JSON.parse(repeatedApplyResponse.payload).migrateEntryIds.length, 0);
  assert(!(await db.select().from(lorebooks)).some((row) => row.id === "donor"));
  await app.close();
  await db._fileStore.close();

  const reopened = await createFileNativeDB();
  assert.equal(
    (await reopened.select().from(lorebookEntries)).find((row) => row.id === "eligible-entry")?.lorebookId,
    "canonical",
    "explicit apply is durable across a storage reopen",
  );
  assert(!(await reopened.select().from(lorebooks)).some((row) => row.id === "donor"));
  await reopened._fileStore.close();
} finally {
  resetFeatureSettingsForTests({});
  rmSync(storageDir, { recursive: true, force: true });
}
