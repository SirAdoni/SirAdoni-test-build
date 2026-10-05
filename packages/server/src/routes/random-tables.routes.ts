// ──────────────────────────────────────────────
// Routes: Random tables and the yes/no oracle
//
// Tables live server-side, global or scoped to one game. Rolls happen here so a
// roll and its dice-log row come from the same throw; the roll logic itself is
// the pure shared module (random-tables.ts). Nothing here writes to a chat: a
// roll is logged to the game's dice history only when asked, and the client
// decides whether to drop the result into the chat input.
// ──────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ORACLE_LIKELIHOODS,
  buildLorebookTableRows,
  collectFolderSubtreeIds,
  createTableLookup,
  formatOracleLine,
  formatTableRollLine,
  normalizeTableName,
  ORACLE_OUTCOME_TEXT,
  parseRandomTableImport,
  resolveEffectiveGameId,
  rollOracle,
  rollRandomTable,
  type OracleLikelihood,
  type RandomTableDefinition,
} from "@marinara-engine/shared";
import type { DB } from "../db/connection.js";
import { eq } from "../db/file-query.js";
import { chats, lorebookEntries } from "../db/schema/index.js";
import { featureDisabledResponse, isFeatureEnabled } from "../services/features/feature-settings.js";
import { createLorebooksStorage } from "../services/storage/lorebooks.storage.js";
import { MAX_RANDOM_TABLES, createRandomTablesStorage } from "../services/storage/random-tables.storage.js";
import { recordGameDiceRollsSafely } from "../services/storage/game-dice-rolls.storage.js";
import type { DiceRollLogEntry } from "../services/game/dice-roll-log.js";

// The app-wide default is 256 MB for uploads. One table is at most 1000 rows of 2000
// characters; an import file of a few thousand ordinary tables fits well inside 16 MB.
const TABLE_BODY_LIMIT = 4 * 1024 * 1024;
const IMPORT_BODY_LIMIT = 16 * 1024 * 1024;

const chatIdField = z.string().min(1).max(200).optional();
const scopeField = z.enum(["global", "game"]).default("global");

const tableBody = z.object({
  name: z.string().min(1).max(200),
  dice: z.string().max(20).nullable().optional(),
  description: z.string().max(2000).optional(),
  rows: z.array(z.unknown()).max(1000),
});

const createSchema = z.object({ chatId: chatIdField, scope: scopeField, table: tableBody });
const updateSchema = z.object({ chatId: chatIdField, scope: z.enum(["global", "game"]).optional(), table: tableBody });
const importSchema = z.object({
  chatId: chatIdField,
  scope: scopeField,
  data: z.unknown(),
  /** Leave out tables whose name a visible table already has (a starter pack added twice adds nothing). */
  skipExisting: z.boolean().default(false),
});
const rollSchema = z.object({ tableId: z.string().min(1), chatId: chatIdField, log: z.boolean().default(false) });
const oracleSchema = z.object({
  likelihood: z.enum(ORACLE_LIKELIHOODS as [OracleLikelihood, ...OracleLikelihood[]]),
  question: z.string().max(500).optional(),
  chatId: chatIdField,
  log: z.boolean().default(false),
});
const fromLorebookSchema = z.object({
  chatId: chatIdField,
  scope: scopeField,
  name: z.string().min(1).max(200),
  lorebookId: z.string().min(1),
  folderId: z.string().min(1).nullable().optional(),
  includeSubfolders: z.boolean().default(true),
  tag: z.string().max(200).nullable().optional(),
  includeDisabled: z.boolean().default(false),
});

type SourceEntry = { name?: unknown; folderId?: unknown; tag?: unknown; enabled?: unknown };
type SourceFolder = { id: string; name: string; parentFolderId?: string | null };

// Only the four columns a table needs are read: a large book's entries carry their full
// content and keys, which listEntries would parse for every entry just to be thrown away.
async function readLorebookSource(db: DB, storage: ReturnType<typeof createLorebooksStorage>, lorebookId: string) {
  const [entries, folders] = await Promise.all([
    db
      .select({
        name: lorebookEntries.name,
        folderId: lorebookEntries.folderId,
        tag: lorebookEntries.tag,
        enabled: lorebookEntries.enabled,
      })
      .from(lorebookEntries)
      .where(eq(lorebookEntries.lorebookId, lorebookId)),
    storage.listFolders(lorebookId),
  ]);
  return {
    entries: (entries as SourceEntry[]).map((entry) => ({
      name: typeof entry.name === "string" ? entry.name : "",
      folderId: typeof entry.folderId === "string" && entry.folderId ? entry.folderId : null,
      tag: typeof entry.tag === "string" ? entry.tag.trim() : "",
      enabled: entry.enabled !== "false" && entry.enabled !== false,
    })),
    folders: (folders as unknown as SourceFolder[]).map((folder) => ({
      id: folder.id,
      name: folder.name,
      parentFolderId: folder.parentFolderId ?? null,
    })),
  };
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** `maxTables` is the per-scope cap; only tests pass a smaller one. */
export async function randomTablesRoutes(app: FastifyInstance, options: { maxTables?: number } = {}) {
  const maxTables = options.maxTables ?? MAX_RANDOM_TABLES;
  const tables = createRandomTablesStorage(app.db, () => isFeatureEnabled("randomTables"));
  const lorebooks = createLorebooksStorage(app.db);

  app.addHook("preHandler", async (_request, reply) => {
    if (!isFeatureEnabled("randomTables")) {
      return reply.status(403).send(featureDisabledResponse("randomTables"));
    }
  });

  /** The campaign a Game Mode chat belongs to; null for any other chat or none. */
  async function gameIdFor(chatId: string | undefined): Promise<string | null> {
    if (!chatId) return null;
    const chat = (await app.db.select().from(chats).where(eq(chats.id, chatId)))[0];
    if (!chat || chat.mode !== "game") return null;
    return resolveEffectiveGameId(parseMetadata(chat.metadata).gameId, chat.groupId, chat.id);
  }

  async function scopeGameId(scope: "global" | "game", chatId: string | undefined) {
    if (scope === "global") return "";
    return gameIdFor(chatId);
  }

  function logRoll(chatId: string, entry: DiceRollLogEntry) {
    return recordGameDiceRollsSafely(app.db, chatId, [entry]);
  }

  // ── GET / ── the tables visible from a chat (its game's plus the global ones)
  app.get<{ Querystring: { chatId?: string } }>("/", async (req, reply) => {
    const gameId = await gameIdFor(req.query.chatId);
    const visible = await tables.listVisible(gameId);
    if (!isFeatureEnabled("randomTables")) return reply.status(403).send(featureDisabledResponse("randomTables"));
    return { gameId, tables: visible };
  });

  // ── POST / ── create a table
  app.post("/", { bodyLimit: TABLE_BODY_LIMIT }, async (req, reply) => {
    const body = createSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid table" });
    const gameId = await scopeGameId(body.data.scope, body.data.chatId);
    if (gameId === null) return reply.status(400).send({ error: "Game tables need a Game Mode chat" });
    if ((await tables.countInScope(gameId)) >= maxTables) {
      return reply.status(409).send({ error: "Too many tables" });
    }
    const created = await tables.create(body.data.table, gameId);
    if (!created) {
      if (!isFeatureEnabled("randomTables")) return reply.status(403).send(featureDisabledResponse("randomTables"));
      return reply.status(400).send({ error: "Invalid table" });
    }
    return created;
  });

  // ── PUT /:id ── replace a table's content (and optionally move it between scopes)
  app.put<{ Params: { id: string } }>("/:id", { bodyLimit: TABLE_BODY_LIMIT }, async (req, reply) => {
    const body = updateSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid table" });
    let gameId: string | undefined;
    if (body.data.scope) {
      const resolved = await scopeGameId(body.data.scope, body.data.chatId);
      if (resolved === null) return reply.status(400).send({ error: "Game tables need a Game Mode chat" });
      const existing = await tables.getById(req.params.id);
      if (!existing) return reply.status(404).send({ error: "Table not found" });
      // A move is a create in the other scope, so it keeps to the same cap.
      if (existing.gameId !== resolved && (await tables.countInScope(resolved)) >= maxTables) {
        return reply.status(409).send({ error: "Too many tables" });
      }
      gameId = resolved;
    }
    const updated = await tables.update(req.params.id, body.data.table, gameId);
    if (!updated) {
      if (!isFeatureEnabled("randomTables")) return reply.status(403).send(featureDisabledResponse("randomTables"));
      return reply.status(404).send({ error: "Table not found" });
    }
    return updated;
  });

  // ── DELETE /:id ──
  app.delete<{ Params: { id: string } }>("/:id", async (req, reply) => {
    if (!(await tables.remove(req.params.id))) {
      if (!isFeatureEnabled("randomTables")) return reply.status(403).send(featureDisabledResponse("randomTables"));
      return reply.status(404).send({ error: "Table not found" });
    }
    return { deleted: true };
  });

  // ── POST /import ── an export file, an array of tables or one table
  app.post("/import", { bodyLimit: IMPORT_BODY_LIMIT }, async (req, reply) => {
    const body = importSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid import" });
    const gameId = await scopeGameId(body.data.scope, body.data.chatId);
    if (gameId === null) return reply.status(400).send({ error: "Game tables need a Game Mode chat" });
    const parsed = parseRandomTableImport(body.data.data);
    if (parsed.length === 0) return reply.status(400).send({ error: "No tables found in the file" });
    let fresh = parsed;
    if (body.data.skipExisting) {
      // Visible means this scope plus the global tables a game also sees, so a game import
      // does not shadow a global table of the same name.
      const taken = new Set((await tables.listVisible(gameId || null)).map((table) => normalizeTableName(table.name)));
      fresh = parsed.filter((table) => {
        const key = normalizeTableName(table.name);
        if (taken.has(key)) return false;
        taken.add(key);
        return true;
      });
    }
    const room = maxTables - (await tables.countInScope(gameId));
    const created = [];
    for (const table of fresh.slice(0, Math.max(0, room))) {
      const record = await tables.create(table, gameId);
      if (!isFeatureEnabled("randomTables")) return reply.status(403).send(featureDisabledResponse("randomTables"));
      if (record) created.push(record);
    }
    return { created, skipped: parsed.length - created.length, existing: parsed.length - fresh.length };
  });

  // ── POST /roll ── roll a table, expanding [[references]] among the visible tables
  app.post("/roll", async (req, reply) => {
    const body = rollSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid roll" });
    const table = await tables.getById(body.data.tableId);
    if (!isFeatureEnabled("randomTables")) return reply.status(403).send(featureDisabledResponse("randomTables"));
    if (!table) return reply.status(404).send({ error: "Table not found" });
    const gameId = await gameIdFor(body.data.chatId);
    const visible = await tables.listVisible(gameId ?? (table.gameId || null));
    if (!isFeatureEnabled("randomTables")) return reply.status(403).send(featureDisabledResponse("randomTables"));
    const definitions: RandomTableDefinition[] = visible.map((entry) => ({
      name: entry.name,
      dice: entry.dice,
      rows: entry.rows,
    }));
    const result = rollRandomTable(
      { name: table.name, dice: table.dice, rows: table.rows },
      { rng: Math.random, lookup: createTableLookup(definitions) },
    );
    const line = formatTableRollLine(result);
    let logged = 0;
    if (body.data.log && body.data.chatId && gameId !== null) {
      logged = await logRoll(body.data.chatId, {
        source: "table",
        actor: null,
        label: `${table.name}: ${result.rowIndex < 0 ? "-" : result.text}`,
        notation: result.notation,
        rolls: result.rolls,
        modifier: 0,
        total: result.total,
        critical: false,
        fumble: false,
      });
    }
    if (!isFeatureEnabled("randomTables")) return reply.status(403).send(featureDisabledResponse("randomTables"));
    return { result, line, logged };
  });

  // ── POST /oracle ── a yes/no question at a likelihood
  app.post("/oracle", async (req, reply) => {
    const body = oracleSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid oracle question" });
    const result = rollOracle(body.data.likelihood, Math.random);
    const line = formatOracleLine(result, body.data.question);
    let logged = 0;
    if (body.data.log && body.data.chatId && (await gameIdFor(body.data.chatId)) !== null) {
      const question = body.data.question?.replace(/\s+/g, " ").trim();
      logged = await logRoll(body.data.chatId, {
        source: "table",
        actor: null,
        label: `Oracle (${result.likelihood}): ${ORACLE_OUTCOME_TEXT[result.outcome]}${question ? `. ${question}` : ""}`,
        notation: "d100",
        rolls: [result.roll],
        modifier: 0,
        total: result.roll,
        critical: false,
        fumble: false,
      });
    }
    if (!isFeatureEnabled("randomTables")) return reply.status(403).send(featureDisabledResponse("randomTables"));
    return { result, line, logged };
  });

  // ── GET /lorebook-sources/:lorebookId ── folders and tags to build a table from
  app.get<{ Params: { lorebookId: string } }>("/lorebook-sources/:lorebookId", async (req, reply) => {
    const lorebook = await lorebooks.getById(req.params.lorebookId);
    if (!lorebook) return reply.status(404).send({ error: "Lorebook not found" });
    const { entries, folders } = await readLorebookSource(app.db, lorebooks, req.params.lorebookId);
    if (!isFeatureEnabled("randomTables")) return reply.status(403).send(featureDisabledResponse("randomTables"));
    const folderCounts = new Map<string, number>();
    const tagCounts = new Map<string, { tag: string; count: number }>();
    for (const entry of entries) {
      if (entry.folderId) folderCounts.set(entry.folderId, (folderCounts.get(entry.folderId) ?? 0) + 1);
      const tag = entry.tag;
      if (!tag) continue;
      const key = tag.toLocaleLowerCase();
      const current = tagCounts.get(key);
      if (current) current.count += 1;
      else tagCounts.set(key, { tag, count: 1 });
    }
    return {
      entryCount: entries.length,
      folders: folders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        parentFolderId: folder.parentFolderId,
        entryCount: folderCounts.get(folder.id) ?? 0,
      })),
      tags: [...tagCounts.values()].sort((left, right) => left.tag.localeCompare(right.tag)),
    };
  });

  // ── POST /from-lorebook ── a table whose rows are the names of entries in a folder or with a tag
  app.post("/from-lorebook", async (req, reply) => {
    const body = fromLorebookSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid lorebook source" });
    const input = body.data;
    if (!input.folderId && !input.tag?.trim()) return reply.status(400).send({ error: "Pick a folder or a tag" });
    const gameId = await scopeGameId(input.scope, input.chatId);
    if (gameId === null) return reply.status(400).send({ error: "Game tables need a Game Mode chat" });
    const lorebook = await lorebooks.getById(input.lorebookId);
    if (!lorebook) return reply.status(404).send({ error: "Lorebook not found" });
    const { entries, folders } = await readLorebookSource(app.db, lorebooks, input.lorebookId);
    let folderIds: string[] | null = null;
    if (input.folderId) {
      if (!folders.some((folder) => folder.id === input.folderId)) {
        return reply.status(404).send({ error: "Folder not found" });
      }
      folderIds = input.includeSubfolders ? collectFolderSubtreeIds(folders, input.folderId) : [input.folderId];
    }
    const rows = buildLorebookTableRows(entries, {
      folderIds,
      tag: input.tag ?? null,
      includeDisabled: input.includeDisabled,
    });
    if (rows.length === 0) return reply.status(400).send({ error: "No entries match" });
    const created = await tables.create({ name: input.name, dice: null, rows }, gameId);
    if (!created) {
      if (!isFeatureEnabled("randomTables")) return reply.status(403).send(featureDisabledResponse("randomTables"));
      return reply.status(400).send({ error: "Invalid table" });
    }
    return created;
  });
}
