import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "marinara-location-identity-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
const { buildApp } = await import("../../packages/server/src/app.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { ensureLocationVisualIdentity } =
  await import("../../packages/server/src/services/image/location-visual-identity.js");
const { saveImageToDisk } = await import("../../packages/server/src/services/image/image-generation.js");
const {
  formatSpatialLocationVisualContext,
  mergeSpatialLocationReferenceImages,
  resolveSpatialLocationReferenceImage,
} = await import("../../packages/server/src/services/image/spatial-location-reference.js");
const { buildSceneIllustrationProviderPrompt } =
  await import("../../packages/server/src/services/game/game-asset-generation.js");
const app = await buildApp();
try {
  const { reconcileStoryboardCharactersForFrame, appendStoryboardCharacterScopeToPrompt } =
    await import("../../packages/server/src/routes/game.routes.js");
  assert.deepEqual(
    reconcileStoryboardCharactersForFrame({
      value: ["Zerah"],
      allowedCharacterNames: ["Zerah", "Quenby"],
      sourceNarration: "Zerah reads Quenby's letter.",
      frameText: "Zerah discusses Quenby's expected arrival.",
    }).characters,
    ["Zerah"],
    "mentioning an absent character must not attach their portrait",
  );
  const ensemble = Array.from({ length: 16 }, (_, i) => `Scene person ${i + 1}`);
  for (const value of [ensemble, ensemble.join(", ")]) {
    const cast = reconcileStoryboardCharactersForFrame({
      value,
      allowedCharacterNames: ensemble,
      sourceNarration: ensemble.join(" stands here. "),
      frameText: ensemble.join(" "),
      maxCharacters: 20,
    });
    assert.deepEqual(
      cast.characters,
      ensemble,
      "Visible ensemble must not be truncated to the portrait reference capacity",
    );
    assert.deepEqual(cast.omittedMentionedCharacters, []);
  }
  assert.equal(
    reconcileStoryboardCharactersForFrame({
      value: ensemble,
      allowedCharacterNames: ensemble,
      sourceNarration: "",
      frameText: "",
      maxCharacters: 2,
    }).characters.length,
    2,
  );
  const castPrompt = appendStoryboardCharacterScopeToPrompt(
    "Zerah speaks to two unnamed market managers.",
    ["Zerah"],
    ["Quenby"],
  );
  assert.match(castPrompt, /Only depict these named visible characters: Zerah/);
  assert.match(castPrompt, /does not exclude unnamed participants explicitly described/);
  assert.doesNotMatch(castPrompt, /off-screen for this keyframe/);
  assert.match(castPrompt, /does not establish their absence/);
  const chats = createChatsStorage(app.db);
  const chat = await chats.create({ name: "Location identity proof", mode: "game", characterIds: [] });
  assert(chat);
  const location = {
    id: "dining",
    name: "Dining Room",
    description: "",
    parentId: null,
    kind: "room",
    links: [],
    lorebookEntryIds: [],
    status: "active",
    sortOrder: 0,
    childPresentation: "list",
  };
  await chats.patchMetadata(chat.id, {
    gameId: "identity-proof",
    spatialContext: {
      schemaVersion: 1,
      revision: 0,
      enabled: true,
      ownerMode: "game",
      locations: [location],
      startingLocationId: "dining",
    },
  });
  const projection = {
    kind: "owner" as const,
    chatId: chat.id,
    ownerMode: "game" as const,
    definitionRevision: 0,
    currentLocationId: "dining",
    breadcrumb: [{ id: "dining", name: "Dining Room" }],
    description: "",
    modelMemory: null,
    referenceImageId: null as string | null,
    useReferenceImage: false,
    lorebookEntryIds: [],
    destinations: [],
    omittedDestinationCount: 0,
  };
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  let descriptions = 0;
  let renders = 0;
  const description = "An oval oak dining table stands between the eastern windows and the western fireplace. ".repeat(
    7,
  );
  const prepare = (p = { ...projection }) =>
    ensureLocationVisualIdentity({
      db: app.db,
      chatId: chat.id,
      projection: p,
      describe: async () => {
        descriptions++;
        return description;
      },
      render: async () => {
        renders++;
        return {
          filePath: saveImageToDisk(chat.id, png, "png"),
          prompt: description,
          provider: "fixture",
          model: "fixture",
          width: 1,
          height: 1,
        };
      },
    });
  const references = await Promise.all([prepare(projection), prepare()]);
  assert.equal(descriptions, 1);
  assert.equal(renders, 1, "concurrent requests must reuse one canonical room image");
  assert.equal(references[0], png);
  assert.equal(references[1], png);
  await prepare();
  assert.equal(renders, 1, "subsequent shots must not redesign the room");
  assert.deepEqual(mergeSpatialLocationReferenceImages(png, ["character-a", "character-b"], 3), [
    png,
    "character-a",
    "character-b",
  ]);
  const compiled = await buildSceneIllustrationProviderPrompt({
    chatId: chat.id,
    slug: "proof",
    prompt: "Zerah writes a letter.",
    characters: ["Zerah"],
    characterDescriptions: ["Zerah: dark braided hair"],
    imgModel: "fixture",
    imgBaseUrl: "",
    imgApiKey: "",
    locationVisualContext: formatSpatialLocationVisualContext(projection),
    locationReferenceImageAttached: true,
    referenceImages: [png, "character-a"],
    preserveFullScenePrompt: true,
  });
  assert(compiled.prompt.startsWith("ESTABLISHED LOCATION"));
  assert(compiled.prompt.indexOf("oval oak") < compiled.prompt.indexOf("CURRENT SCENE:"));
  const next = await chats.create({ name: "Next session", mode: "game", characterIds: [] });
  assert(next);
  await chats.patchMetadata(next.id, { gameId: "identity-proof" });
  assert.equal(await resolveSpatialLocationReferenceImage({ db: app.db, chatId: next.id, projection }), png);
  await chats.patchMetadata(next.id, { gameId: "unrelated" });
  assert.equal(await resolveSpatialLocationReferenceImage({ db: app.db, chatId: next.id, projection }), null);
  console.log(
    "Location identity: single creation, reuse, reference order, description grounding, and campaign boundary passed.",
  );
} finally {
  await app.close();
  const { closeDB } = await import("../../packages/server/src/db/connection.js");
  await closeDB();
  rmSync(root, { recursive: true, force: true });
}
