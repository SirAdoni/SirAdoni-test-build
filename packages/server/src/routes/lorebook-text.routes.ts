// ──────────────────────────────────────────────
// Routes: Lorebook Markdown / CSV import and export
// Registered inside lorebooksRoutes, so paths sit under /api/lorebooks.
// ──────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import {
  createLorebookSchema,
  exportLorebookText,
  type Lorebook,
  type LorebookEntry,
  type LorebookFolder,
} from "@marinara-engine/shared";
import { createLorebooksStorage } from "../services/storage/lorebooks.storage.js";
import { syncCharacterBookFromLorebook } from "../services/lorebook/character-book-sync.js";
import {
  importLorebookText,
  LorebookTextImportError,
  readLorebookTextImportRequest,
} from "../services/lorebook/text-import.js";

export async function lorebookTextRoutes(app: FastifyInstance) {
  const storage = createLorebooksStorage(app.db);

  /** Import entries into an existing lorebook. Body: { format, text, duplicateMode }. */
  app.post<{ Params: { id: string } }>("/:id/import-text", async (req, reply) => {
    const lorebook = await storage.getById(req.params.id);
    if (!lorebook) return reply.status(404).send({ error: "Lorebook not found" });
    try {
      const request = readLorebookTextImportRequest(req.body);
      const result = await importLorebookText(storage, req.params.id, request);
      await syncCharacterBookFromLorebook(app.db, req.params.id);
      return result;
    } catch (err) {
      if (err instanceof LorebookTextImportError) return reply.status(400).send({ error: err.message });
      throw err;
    }
  });

  /** Import entries into a new lorebook. Body: { name, format, text, duplicateMode }. */
  app.post("/import-text", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    let request;
    try {
      request = readLorebookTextImportRequest(body);
    } catch (err) {
      if (err instanceof LorebookTextImportError) return reply.status(400).send({ error: err.message });
      throw err;
    }
    const name =
      typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 200) : "Imported lorebook";
    const created = (await storage.create(createLorebookSchema.parse({ name }))) as { id: string } | null;
    if (!created) return reply.status(500).send({ error: "Failed to create lorebook" });
    try {
      return await importLorebookText(storage, created.id, request);
    } catch (err) {
      await storage.remove(created.id).catch(() => undefined);
      if (err instanceof LorebookTextImportError) return reply.status(400).send({ error: err.message });
      throw err;
    }
  });

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>("/:id/export-text", async (req, reply) => {
    const lb = (await storage.getById(req.params.id)) as Lorebook | null;
    if (!lb) return reply.status(404).send({ error: "Lorebook not found" });
    const format = req.query.format === "csv" ? "csv" : "markdown";
    const entries = (await storage.listEntries(req.params.id)) as LorebookEntry[];
    const folders = (await storage.listFolders(req.params.id)) as LorebookFolder[];
    const text = exportLorebookText(format, { name: String(lb.name ?? ""), entries, folders });
    const baseName = encodeURIComponent(String(lb.name || "lorebook"));
    return (
      reply
        .header("Content-Type", format === "csv" ? "text/csv; charset=utf-8" : "text/markdown; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${baseName}.${format === "csv" ? "csv" : "md"}"`)
        // The BOM lets spreadsheet apps read non-English text in the CSV as UTF-8.
        .send(format === "csv" ? `﻿${text}` : text)
    );
  });
}
