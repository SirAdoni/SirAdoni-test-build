// ──────────────────────────────────────────────
// Routes: Resource Library Folders
// ──────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import {
  createLibraryFolderSchema,
  libraryFolderParamsSchema,
  libraryFolderScopeParamsSchema,
  migrateLibraryFoldersSchema,
  moveLibraryItemsSchema,
  updateLibraryFolderSchema,
} from "@marinara-engine/shared";
import { createLibraryFoldersStorage, LibraryFolderTreeError } from "../services/storage/library-folders.storage.js";

export async function libraryFoldersRoutes(app: FastifyInstance) {
  const storage = createLibraryFoldersStorage(app.db);

  app.get("/:scope", async (req) => {
    const { scope } = libraryFolderScopeParamsSchema.parse(req.params);
    return storage.list(scope);
  });

  app.post("/:scope/migrate", async (req) => {
    const { scope } = libraryFolderScopeParamsSchema.parse(req.params);
    const input = migrateLibraryFoldersSchema.parse(req.body);
    return storage.migrate(scope, input);
  });

  app.post("/:scope/move", async (req, reply) => {
    const { scope } = libraryFolderScopeParamsSchema.parse(req.params);
    const input = moveLibraryItemsSchema.parse(req.body);
    const moved = await storage.moveItems(scope, input);
    if (!moved) return reply.status(404).send({ error: "Folder not found" });
    return reply.send({ ok: true });
  });

  app.post("/:scope", async (req, reply) => {
    const { scope } = libraryFolderScopeParamsSchema.parse(req.params);
    const input = createLibraryFolderSchema.parse(req.body);
    try {
      return await storage.create(scope, input);
    } catch (error) {
      if (error instanceof LibraryFolderTreeError) return reply.status(400).send({ error: error.message });
      throw error;
    }
  });

  app.patch("/:scope/:id", async (req, reply) => {
    const { scope, id } = libraryFolderParamsSchema.parse(req.params);
    const input = updateLibraryFolderSchema.parse(req.body);
    let folder;
    try {
      folder = await storage.update(scope, id, input);
    } catch (error) {
      if (error instanceof LibraryFolderTreeError) return reply.status(400).send({ error: error.message });
      throw error;
    }
    if (!folder) return reply.status(404).send({ error: "Folder not found" });
    return reply.send(folder);
  });

  app.delete("/:scope/:id", async (req, reply) => {
    const { scope, id } = libraryFolderParamsSchema.parse(req.params);
    const removed = await storage.remove(scope, id);
    if (!removed) return reply.status(404).send({ error: "Folder not found" });
    return reply.status(204).send();
  });
}
