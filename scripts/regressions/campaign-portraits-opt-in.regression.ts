import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-campaign-portraits-opt-in-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
const { applyFeatureSettingsValue } = await import("../../packages/server/src/services/features/feature-settings.js");
const { buildNpcPortraitProviderPrompt, generateNpcPortrait } =
  await import("../../packages/server/src/services/game/game-asset-generation.js");

const db = await getDB();
const app = Fastify();
app.decorate("db", db);
await app.register(gameRoutes, { prefix: "/api/game" });
const chat = await createChatsStorage(db).create({
  name: "Portrait opt-in regression",
  mode: "game",
  characterIds: [],
});
assert.ok(chat);

let dynamicPromptCalls = 0;
let imageRequests = 0;
let duringImage: (() => void) | undefined;
const pixel = readFileSync(new URL("../../packages/client/public/icon-512.png", import.meta.url)).toString("base64");
const imageProvider = createServer((_request, response) => {
  _request.resume();
  imageRequests++;
  duringImage?.();
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ b64_json: pixel }] }));
});
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  assert.equal(url.hostname, "127.0.0.1", "No external provider requests are permitted");
  const address = imageProvider.address();
  assert.ok(address && typeof address === "object");
  assert.equal(url.port, String(address.port));
  return originalFetch(input, init);
};

try {
  await new Promise<void>((resolve) => imageProvider.listen(0, "127.0.0.1", resolve));
  const address = imageProvider.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  applyFeatureSettingsValue("{}");
  const contactsOff = await app.inject({ method: "GET", url: `/api/game/${chat.id}/contacts` });
  assert.equal(contactsOff.statusCode, 403, contactsOff.body);
  for (const payload of [
    { chatId: chat.id, campaignPortraitBatch: true },
    { chatId: chat.id, npcPortraitStylePrompt: "Painterly portrait style" },
  ]) {
    const preview = await app.inject({ method: "POST", url: "/api/game/generate-assets/preview", payload });
    const generate = await app.inject({ method: "POST", url: "/api/game/generate-assets", payload });
    assert.equal(preview.statusCode, 403, preview.body);
    assert.equal(generate.statusCode, 403, generate.body);
  }

  applyFeatureSettingsValue(JSON.stringify({ campaignPortraits: true }));
  const contactsStillOff = await app.inject({ method: "GET", url: `/api/game/${chat.id}/contacts` });
  assert.equal(contactsStillOff.statusCode, 403, "Portrait opt-in must not enable the separate contact book");

  applyFeatureSettingsValue(JSON.stringify({ gameContactBook: true, campaignPortraits: true }));
  const contactsOn = await app.inject({ method: "GET", url: `/api/game/${chat.id}/contacts` });
  assert.equal(contactsOn.statusCode, 200, contactsOn.body);

  applyFeatureSettingsValue(JSON.stringify({ gameContactBook: true }));
  const batchOff = await app.inject({
    method: "POST",
    url: "/api/game/generate-assets",
    payload: { chatId: chat.id, campaignPortraitBatch: true },
  });
  assert.equal(batchOff.statusCode, 403, batchOff.body);
  const contactsStillOn = await app.inject({ method: "GET", url: `/api/game/${chat.id}/contacts` });
  assert.equal(contactsStillOn.statusCode, 200, "Contact book remains independently enabled");

  await assert.rejects(
    buildNpcPortraitProviderPrompt({
      chatId: chat.id,
      npcName: "Fixture",
      appearance: "Short dark hair",
      imgModel: "fixture",
      imgBaseUrl: baseUrl,
      imgApiKey: "fixture",
      isAllowed: () => false,
      dynamicPromptGenerator: async () => {
        dynamicPromptCalls++;
        return "A stable synthetic portrait prompt for a test character.";
      },
    }),
    /Campaign portrait generation is disabled/u,
  );
  assert.equal(dynamicPromptCalls, 0, "A disabled request must not invoke its dynamic prompt provider");

  applyFeatureSettingsValue(JSON.stringify({ campaignPortraits: true }));
  let enabled = true;
  let dynamicCallsDuringGeneration = 0;
  const generated = await generateNpcPortrait({
    chatId: chat.id,
    npcName: "Fixture",
    appearance: "Short dark hair",
    imgModel: "fixture",
    imgBaseUrl: baseUrl,
    imgApiKey: "fixture",
    isAllowed: () => enabled,
    dynamicPromptGenerator: async () => {
      dynamicCallsDuringGeneration++;
      enabled = false;
      return "A stable synthetic portrait prompt for a test character.";
    },
  });
  assert.equal(generated, null, "Turning the switch off during prompt work must cancel optional generation");
  assert.equal(dynamicCallsDuringGeneration, 1);
  assert.equal(imageRequests, 0, "Canceled optional work must not reach the synthetic image provider");
  const request = {
    chatId: chat.id,
    npcName: "Image boundary fixture",
    appearance: "Short dark hair",
    imgModel: "fixture",
    imgBaseUrl: baseUrl,
    imgApiKey: "fixture",
    imgSource: "openai",
    promptOverride: "Synthetic portrait",
    force: true,
  };
  enabled = true;
  duringImage = () => {
    enabled = false;
  };
  assert.equal(await generateNpcPortrait({ ...request, isAllowed: () => enabled }), null);
  assert.equal(imageRequests, 1, "Late-OFF scenario must actually reach the synthetic image provider");
  const avatarDir = join(dataDir, "avatars", "npc", chat.id);
  assert.deepEqual(existsSync(avatarDir) ? readdirSync(avatarDir) : [], [], "Late OFF must not save a portrait");
  duringImage = undefined;
  enabled = true;
  const saved = await generateNpcPortrait({ ...request, isAllowed: () => enabled });
  assert.ok(saved, "Re-enabled optional generation must save its portrait");
  const savedFiles = readdirSync(avatarDir);
  enabled = false;
  assert.equal(await generateNpcPortrait({ ...request, isAllowed: () => enabled }), null);
  assert.deepEqual(readdirSync(avatarDir), savedFiles, "Disabling must preserve existing portraits");
  applyFeatureSettingsValue("{}");
  assert.ok(
    await generateNpcPortrait({ ...request, npcName: "Baseline scene fixture" }),
    "Ordinary scene generation remains available while both optional switches are OFF",
  );
  const assertPublicationAllowed = () => {
    assert.ok(enabled, "Optional portrait publication is disabled");
  };
  const chatStorage = createChatsStorage(db);
  const metadataBefore = (await chatStorage.getById(chat.id))!.metadata;
  enabled = true;
  await assert.rejects(
    chatStorage.patchMetadata(
      chat.id,
      async () => {
        assertPublicationAllowed();
        await Promise.resolve();
        enabled = false;
        return { gameNpcs: [{ id: "late-npc", name: "Late", avatarUrl: "/late.png" }] };
      },
      { beforeWrite: assertPublicationAllowed },
    ),
    /publication is disabled/u,
  );
  assert.equal((await chatStorage.getById(chat.id))!.metadata, metadataBefore);
  const characters = createCharactersStorage(db);
  const character = await characters.create({
    name: "Late portrait",
    description: "",
    personality: "",
    scenario: "",
    first_mes: "",
    mes_example: "",
    creator_notes: "",
    system_prompt: "",
    post_history_instructions: "",
    tags: [],
    creator: "",
    character_version: "1",
    alternate_greetings: [],
    extensions: {},
    character_book: null,
  } as never);
  assert.ok(character);
  enabled = true;
  await assert.rejects(
    characters.updateAvatar(character.id, "/late.png", {
      canUpdate: async () => {
        assertPublicationAllowed();
        await Promise.resolve();
        enabled = false;
        return true;
      },
      beforeWrite: assertPublicationAllowed,
    }),
    /publication is disabled/u,
  );
  assert.equal((await characters.getById(character.id))!.avatarPath, character.avatarPath);
} finally {
  globalThis.fetch = originalFetch;
  imageProvider.close();
  try {
    await app.close();
  } finally {
    try {
      await closeDB();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
}
