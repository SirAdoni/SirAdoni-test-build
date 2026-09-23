import type { ResolvedOwnerSpatialProjection, SpatialContextDefinition } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { createChatsStorage } from "../storage/chats.storage.js";
import { createGalleryStorage } from "../storage/gallery.storage.js";
import { resolveSpatialLocationReferenceImage } from "./spatial-location-reference.js";

const pending = new Map<string, Promise<void>>();

/** Prepare the map's existing location record, never a second independent room registry. */
export async function ensureLocationVisualIdentity(args: {
  db: DB;
  chatId: string;
  projection: ResolvedOwnerSpatialProjection | null;
  describe: (existing: string, path: string) => Promise<string>;
  render: (
    description: string,
    path: string,
  ) => Promise<{
    filePath: string;
    prompt: string;
    provider: string;
    model: string;
    width: number;
    height: number;
  }>;
}): Promise<string | null> {
  const projection = args.projection;
  if (!projection) return null;
  // Explicit opt-out on a linked reference remains a user-controlled boundary.
  if (projection.referenceImageId && !projection.useReferenceImage) return null;
  const chats = createChatsStorage(args.db);
  const key = `${args.chatId}:${projection.currentLocationId}`;
  const previous = pending.get(key) ?? Promise.resolve();
  const work = previous
    .catch(() => undefined)
    .then(async () => {
      const chat = await chats.getById(args.chatId);
      if (!chat) throw new Error("Location identity chat no longer exists");
      const metadata = typeof chat.metadata === "string" ? JSON.parse(chat.metadata) : chat.metadata;
      const definition = metadata?.spatialContext as SpatialContextDefinition | undefined;
      const location = definition?.locations.find((candidate) => candidate.id === projection.currentLocationId);
      if (!location) throw new Error("Location identity requires a saved map location");
      const originalDescription = location.description;
      const originalReference = location.referenceImageId;
      const current = {
        ...projection,
        description: location.description,
        referenceImageId: location.referenceImageId ?? null,
        useReferenceImage: location.useReferenceImage === true,
      };
      let reference = await resolveSpatialLocationReferenceImage({ ...args, projection: current });
      const path = projection.breadcrumb.map(({ name }) => name).join(" > ");
      let description = location.description;
      if (description.trim().length < 400) {
        description = (await args.describe(description, path)).trim();
        if (description.length < 400 || description.length > 4000)
          throw new Error("Location description generation returned an unusable description");
      }
      let imageId = originalReference;
      if (!reference) {
        const generated = await args.render(description, path);
        const image = await createGalleryStorage(args.db).create({ chatId: args.chatId, ...generated });
        if (!image) throw new Error("Location reference image could not be saved");
        imageId = image.id;
      }
      await chats.patchMetadata(args.chatId, (fresh) => {
        const latest = fresh.spatialContext as SpatialContextDefinition | undefined;
        const target = latest?.locations.find((candidate) => candidate.id === location.id);
        if (
          !latest ||
          !target ||
          target.description !== originalDescription ||
          target.referenceImageId !== originalReference
        ) {
          throw new Error("Location changed while preparing its reference; retry with the updated location");
        }
        if (description === originalDescription && imageId === originalReference) return {};
        return {
          spatialContext: {
            ...latest,
            revision: latest.revision + 1,
            locations: latest.locations.map((candidate) =>
              candidate.id === location.id
                ? { ...candidate, description, referenceImageId: imageId, useReferenceImage: true }
                : candidate,
            ),
          },
        };
      });
      projection.description = description;
      projection.referenceImageId = imageId ?? null;
      projection.useReferenceImage = true;
      reference = await resolveSpatialLocationReferenceImage({ ...args, projection });
      if (!reference) throw new Error("Saved location reference could not be read; scene rendering stopped");
    });
  pending.set(key, work);
  try {
    await work;
  } finally {
    if (pending.get(key) === work) pending.delete(key);
  }
  return resolveSpatialLocationReferenceImage({ ...args, projection });
}
