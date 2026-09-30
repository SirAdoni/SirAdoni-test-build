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
import { createCharactersStorage } from "../services/storage/characters.storage.js";
import { readCharacterAvatarState, readGameNpcAvatarState } from "../services/game/npc-avatar-state.js";
import { chats as chatRows } from "../db/schema/index.js";
import type { GameNpc, GameNpcAvatarState } from "@marinara-engine/shared";

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
    const initialChat = await chats.getById(chatId);
    if (!initialChat) {
      return reply.status(404).send({ error: "Chat not found" });
    }
    const initialMetadata = JSON.parse(initialChat.metadata || "{}") as Record<string, unknown>;
    const initialNpc = Array.isArray(initialMetadata.gameNpcs)
      ? (initialMetadata.gameNpcs as GameNpc[]).find((npc) => npc.id === normalizedNpcId)
      : undefined;
    const characterId = initialNpc?.characterId || undefined;
    const expectedUnlinkedAvatarRevision = !characterId
      ? (readGameNpcAvatarState(initialNpc?.avatarState)?.revision ?? 0)
      : null;
    const characters = createCharactersStorage(app.db);
    const initialCharacter = characterId ? await characters.getById(characterId) : null;
    const expectedAvatarRevision = readCharacterAvatarState(initialCharacter?.data)?.revision ?? 0;
    const npcDir = join(NPC_AVATAR_DIR, chatId);
    if (!existsSync(npcDir)) mkdirSync(npcDir, { recursive: true });
    const filename = buildNpcAvatarUploadFilename(normalizedNpcId, normalizedName, image.ext);
    const filePath = assertInsideDir(npcDir, join(npcDir, filename));
    writeFileSync(filePath, imageBuffer);

    const avatarPath = `/api/avatars/npc/${chatId}/${filename}?v=${Date.now()}`;
    let npcUpdated = false;
    let avatarState: GameNpcAvatarState | null = null;
    let characterAttached = false;
    if (normalizedNpcId) {
      try {
        let persistedNpc = false;
        const latestChat = await chats.getById(chatId);
        const latestMetadata = JSON.parse(latestChat?.metadata || "{}") as Record<string, unknown>;
        const latestNpc = Array.isArray(latestMetadata.gameNpcs)
          ? (latestMetadata.gameNpcs as GameNpc[]).find((npc) => npc.id === normalizedNpcId)
          : undefined;
        const eligiblePatch = latestChat
          ? buildNpcAvatarMetadataPatch(latestMetadata, normalizedNpcId, normalizedName, avatarPath)
          : null;
        const eligibleNpc = eligiblePatch?.gameNpcs.find((npc) => npc.id === normalizedNpcId);
        let accepted =
          !!eligiblePatch && (!initialNpc || !!latestNpc) && (eligibleNpc?.characterId || undefined) === characterId;
        if (accepted && characterId) {
          // Take the avatar lifecycle lock before entering the chat metadata queue.
          const character = await characters.updateAvatar(characterId, avatarPath, { expectedAvatarRevision });
          accepted = !!character;
          characterAttached = accepted;
          avatarState = character ? readCharacterAvatarState(character.data) : null;
        }
        const updatedChat = accepted
          ? await chats.patchMetadata(
              chatId,
              (freshMeta) => {
                const currentNpc = Array.isArray(freshMeta.gameNpcs)
                  ? (freshMeta.gameNpcs as GameNpc[]).find((npc) => npc.id === normalizedNpcId)
                  : undefined;
                if (initialNpc && !currentNpc) return {};
                const patch = buildNpcAvatarMetadataPatch(freshMeta, normalizedNpcId, normalizedName, avatarPath);
                if (!patch) return {};
                const freshNpc = patch.gameNpcs.find((npc) => npc.id === normalizedNpcId);
                if ((freshNpc?.characterId || undefined) !== characterId) return {};
                if (freshNpc && avatarState) freshNpc.avatarState = avatarState;
                persistedNpc = true;
                return patch;
              },
              {
                npcAvatarWriteIntents:
                  expectedUnlinkedAvatarRevision === null
                    ? undefined
                    : [{ npcId: normalizedNpcId, expectedRevision: expectedUnlinkedAvatarRevision }],
              },
            )
          : null;
        npcUpdated = !!updatedChat && persistedNpc;
        if (npcUpdated && updatedChat) {
          const savedMetadata = JSON.parse(updatedChat.metadata || "{}") as Record<string, unknown>;
          const savedNpc = Array.isArray(savedMetadata.gameNpcs)
            ? (savedMetadata.gameNpcs as GameNpc[]).find((npc) => npc.id === normalizedNpcId)
            : undefined;
          npcUpdated = savedNpc?.avatarUrl === avatarPath;
          avatarState = readGameNpcAvatarState(savedNpc?.avatarState);
          if (npcUpdated && expectedUnlinkedAvatarRevision !== null) {
            npcUpdated =
              !!avatarState && !avatarState.removed && avatarState.revision === expectedUnlinkedAvatarRevision + 1;
          }
        }
        if (npcUpdated && characterId) {
          for (const otherChat of await app.db.select().from(chatRows)) {
            if (otherChat.id === chatId) continue;
            const metadata = JSON.parse(otherChat.metadata || "{}") as Record<string, unknown>;
            if (!Array.isArray(metadata.gameNpcs) || !metadata.gameNpcs.some((npc) => npc?.characterId === characterId))
              continue;
            await chats.patchMetadata(otherChat.id, (fresh) => ({ gameNpcs: fresh.gameNpcs }));
          }
        }
      } catch (error) {
        try {
          if (!characterAttached) unlinkSync(filePath);
        } catch {
          // Best-effort cleanup; a unique unreferenced file is safer than altering the prior portrait.
        }
        throw error;
      }
      if (!npcUpdated) {
        try {
          if (!characterAttached) unlinkSync(filePath);
        } catch {
          // Best-effort cleanup after a missing chat or freshly tombstoned NPC rejects the patch.
        }
        return reply.status(409).send({ error: "NPC portrait changed during upload" });
      }
    }

    return reply.send({ avatarPath, npcUpdated, characterId, avatarState });
  });
}
