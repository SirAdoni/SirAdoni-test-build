// ──────────────────────────────────────────────
// Routes: Avatar file serving
// ──────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "../utils/data-dir.js";
import { assertInsideDir, isAllowedImageBuffer } from "../utils/security.js";
import { sendValidatedMediaFile, validateImageAssetFile } from "../utils/media-file-security.js";
import { npcAvatarSlug } from "../services/game/npc-avatar-utils.js";
import { createChatsStorage } from "../services/storage/chats.storage.js";
import type { GameNpc } from "@marinara-engine/shared";

const AVATAR_DIR = join(DATA_DIR, "avatars");
const NPC_AVATAR_DIR = join(AVATAR_DIR, "npc");

function ensureDir() {
  if (!existsSync(AVATAR_DIR)) {
    mkdirSync(AVATAR_DIR, { recursive: true });
  }
}

function isValidFilename(name: string): boolean {
  return !name.includes("..") && !name.includes("/") && !name.includes("\\");
}

/** Keep explicit NPC identities distinct even when their display-safe slugs would collide. */
export function npcAvatarUploadSlug(npcId: string, npcName: string): string {
  const normalizedNpcId = npcId.trim();
  if (!normalizedNpcId) return npcAvatarSlug(npcName);
  const identityHash = createHash("sha256").update(normalizedNpcId).digest("hex").slice(0, 32);
  return `npc-${identityHash}`;
}

export function buildNpcAvatarUploadFilename(
  npcId: string,
  npcName: string,
  extension: string,
  revision: string = randomUUID(),
): string {
  const slug = npcAvatarUploadSlug(npcId, npcName);
  return `${slug}${npcId.trim() ? `-${revision}` : ""}.${extension}`;
}

export function buildNpcAvatarMetadataPatch(
  metadata: Record<string, unknown>,
  npcId: string,
  npcName: string,
  avatarPath: string,
): { gameNpcs: GameNpc[] } | null {
  const ignoredNpcIds = Array.isArray(metadata.gameIgnoredNpcIds)
    ? (metadata.gameIgnoredNpcIds as unknown[]).filter((value): value is string => typeof value === "string")
    : [];
  if (ignoredNpcIds.includes(npcId)) return null;

  const currentNpcs = Array.isArray(metadata.gameNpcs) ? (metadata.gameNpcs as GameNpc[]) : [];
  let matched = false;
  const gameNpcs = currentNpcs.map((npc) => {
    if (npc.id !== npcId) return npc;
    matched = true;
    return { ...npc, avatarUrl: avatarPath };
  });
  if (!matched) {
    gameNpcs.push({
      id: npcId,
      name: npcName,
      emoji: "👤",
      description: "",
      descriptionSource: "user",
      gender: null,
      pronouns: null,
      location: "",
      reputation: 0,
      notes: [],
      avatarUrl: avatarPath,
    });
  }
  return { gameNpcs };
}

export async function avatarsRoutes(app: FastifyInstance) {
  /** Serve an avatar image file. */
  app.get("/file/:filename", async (req, reply) => {
    ensureDir();
    const { filename } = req.params as { filename: string };

    if (!isValidFilename(filename)) {
      return reply.status(400).send({ error: "Invalid filename" });
    }

    const filePath = assertInsideDir(AVATAR_DIR, join(AVATAR_DIR, filename));
    if (!existsSync(filePath)) {
      return reply.status(404).send({ error: "Not found" });
    }

    const image = await validateImageAssetFile(filePath, filename);
    if (!image) return reply.status(404).send({ error: "Not found" });
    return sendValidatedMediaFile(reply, image, {
      method: req.method,
      rangeHeader: req.headers.range,
      cacheControl: "public, max-age=31536000, immutable",
    });
  });

  /** Serve an NPC avatar image by chatId and filename. */
  app.get("/npc/:chatId/:filename", async (req, reply) => {
    const { chatId, filename } = req.params as { chatId: string; filename: string };

    if (!isValidFilename(chatId) || !isValidFilename(filename)) {
      return reply.status(400).send({ error: "Invalid path" });
    }

    const filePath = assertInsideDir(NPC_AVATAR_DIR, join(NPC_AVATAR_DIR, chatId, filename));
    if (!existsSync(filePath)) {
      return reply.status(404).send({ error: "Not found" });
    }

    const image = await validateImageAssetFile(filePath, filename);
    if (!image) return reply.status(404).send({ error: "Not found" });
    return sendValidatedMediaFile(reply, image, {
      method: req.method,
      rangeHeader: req.headers.range,
      cacheControl: "public, max-age=604800",
    });
  });

  /** Upload an NPC avatar (base64 data URL). */
  app.post("/npc/:chatId", async (req, reply) => {
    const { chatId } = req.params as { chatId: string };
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply.status(400).send({ error: "Invalid upload body" });
    }
    const { name, npcId, avatar } = body as {
      name?: unknown;
      npcId?: unknown;
      avatar?: unknown;
    };

    if (!isValidFilename(chatId)) {
      return reply.status(400).send({ error: "Invalid chatId" });
    }
    if (typeof name !== "string" || !name.trim() || typeof avatar !== "string" || !avatar) {
      return reply.status(400).send({ error: "Missing name or avatar" });
    }
    if (npcId != null && typeof npcId !== "string") {
      return reply.status(400).send({ error: "Invalid NPC id" });
    }
    if (typeof npcId === "string" && !npcId.trim()) {
      return reply.status(400).send({ error: "Invalid NPC id" });
    }
    const normalizedName = name.trim();
    const normalizedNpcId = typeof npcId === "string" ? npcId.trim() : "";
    if (normalizedName.length > 200 || normalizedNpcId.length > 200) {
      return reply.status(400).send({ error: "NPC name or id is too long" });
    }

    // Extract base64 data from data URL
    const match = avatar.match(/^data:image\/([\w.+-]+);base64,(.+)$/);
    if (!match) {
      return reply.status(400).send({ error: "Invalid avatar format — expected base64 data URL" });
    }

    const safeName = npcAvatarUploadSlug(normalizedNpcId, normalizedName);
    if (!safeName) {
      return reply.status(400).send({ error: "Invalid character name" });
    }

    const hintedExt = `.${match[1]!.replace("+xml", "")}`;
    const imageBuffer = Buffer.from(match[2]!, "base64");
    const image = isAllowedImageBuffer(imageBuffer, hintedExt);
    if (!image) {
      return reply.status(400).send({ error: "Unsupported or invalid avatar image" });
    }
    const chats = createChatsStorage(app.db);
    if (!(await chats.getById(chatId))) {
      return reply.status(404).send({ error: "Chat not found" });
    }
    const npcDir = join(NPC_AVATAR_DIR, chatId);
    if (!existsSync(npcDir)) mkdirSync(npcDir, { recursive: true });
    const filename = buildNpcAvatarUploadFilename(normalizedNpcId, normalizedName, image.ext);
    const filePath = assertInsideDir(npcDir, join(npcDir, filename));
    writeFileSync(filePath, imageBuffer);

    const avatarPath = `/api/avatars/npc/${chatId}/${filename}?v=${Date.now()}`;
    let npcUpdated = false;
    if (normalizedNpcId) {
      try {
        let persistedNpc = false;
        const updatedChat = await chats.patchMetadata(chatId, (freshMeta) => {
          const patch = buildNpcAvatarMetadataPatch(freshMeta, normalizedNpcId, normalizedName, avatarPath);
          if (!patch) return {};
          persistedNpc = true;
          return patch;
        });
        npcUpdated = !!updatedChat && persistedNpc;
      } catch (error) {
        try {
          unlinkSync(filePath);
        } catch {
          // Best-effort cleanup; a unique unreferenced file is safer than altering the prior portrait.
        }
        throw error;
      }
      if (!npcUpdated) {
        try {
          unlinkSync(filePath);
        } catch {
          // Best-effort cleanup after a missing chat or freshly tombstoned NPC rejects the patch.
        }
      }
    }

    return reply.send({ avatarPath, npcUpdated });
  });
}
