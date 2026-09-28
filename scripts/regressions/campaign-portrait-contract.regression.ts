import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
const root = mkdtempSync(join(tmpdir(), "me-portrait-contract-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";
const { resolveCampaignPortraitRoster } =
  await import("../../packages/server/src/services/game/campaign-portrait-roster.js");
const { npcPortraitSlug, safeGeneratedAssetSlug, buildNpcPortraitProviderPrompt } =
  await import("../../packages/server/src/services/game/game-asset-generation.js");
const npc = {
  id: "n1",
  name: "Alex",
  characterId: "linked",
  description: "Canonical silver hair",
  descriptionSource: "user" as const,
  emoji: "",
  location: "",
  reputation: 0,
  notes: [],
};
const meta = { gameNpcs: [npc], gamePartyCharacterIds: ["party-card"], gameSetupConfig: { gmCharacterId: "gm" } };
const cards = [
  { id: "party-card", data: { name: "Bea", description: "Copper hair and a blue coat" } },
  { id: "outsider", data: { name: "Other" } },
  { id: "gm", data: { name: "Narrator" } },
];
const resolved = resolveCampaignPortraitRoster(meta, [], cards, [
  { npcId: "n1", name: "Forged", description: "Forged" },
  { npcId: "party:party-card", characterId: "party-card", name: "Forged", description: "Forged" },
]);
assert.equal(resolved.candidates[0]!.name, "Alex");
assert.equal(resolved.candidates[0]!.description, npc.description);
assert.equal(resolved.candidates[1]!.name, "Bea");
assert.equal(resolved.npcs[1]!.characterId, "party-card");
assert.equal(meta.gameNpcs.length, 1, "resolution does not mutate stored metadata");
assert.throws(
  () =>
    resolveCampaignPortraitRoster(meta, [], cards, [
      { npcId: "party:outsider", characterId: "outsider", name: "Other", description: "" },
    ]),
  /current campaign/,
);
assert.throws(
  () =>
    resolveCampaignPortraitRoster(meta, ["gm"], cards, [
      { npcId: "party:gm", characterId: "gm", name: "Narrator", description: "" },
    ]),
  /current campaign/,
);
assert.throws(
  () =>
    resolveCampaignPortraitRoster(meta, [], cards, [
      { npcId: "n1", characterId: "party-card", name: "Alex", description: "" },
    ]),
  /current campaign/,
);
assert.throws(
  () =>
    resolveCampaignPortraitRoster({ ...meta, gameNpcs: [] }, [], cards, [
      { npcId: "n1", name: "Alex", description: "" },
    ]),
  /current campaign/,
  "removed NPC cannot be resurrected by a delayed request",
);
const request = {
  chatId: "proof",
  npcId: "n1",
  npcName: "Alex",
  appearance: "Canonical silver hair",
  imgModel: "unused",
  imgBaseUrl: "http://invalid.local",
  imgApiKey: "",
};
const oldHash = createHash("sha256")
  .update(["n1", "Alex", request.appearance, "", ""].join("\n"))
  .digest("hex")
  .slice(0, 8);
assert.equal(npcPortraitSlug(request), safeGeneratedAssetSlug("Alex", { maxBytes: 160, suffix: oldHash }));
assert.notEqual(npcPortraitSlug({ ...request, styleCacheKey: "2.5D" }), npcPortraitSlug(request));
assert.notEqual(
  npcPortraitSlug({ ...request, styleCacheKey: "2.5D" }),
  npcPortraitSlug({ ...request, styleCacheKey: "watercolor" }),
);
const compiled = await buildNpcPortraitProviderPrompt({
  ...request,
  artStyle: "Stylized 2.5D illustration",
  styleCacheKey: "2.5D",
  dynamicPromptGenerator: async () =>
    "A portrait with soft light and a neutral background, composed as a centered head and shoulders view.",
});
assert.ok(compiled.prompt.includes("Stylized 2.5D illustration"), "style survives a rewriting model that omits it");
assert.ok(compiled.prompt.includes(request.appearance), "canonical appearance survives rewriting");
const { buildApp } = await import("../../packages/server/src/app.js");
const app = await buildApp();
try {
  await app.ready();
  const created = await app.inject({
    method: "POST",
    url: "/api/chats",
    payload: { name: "Portrait proof", mode: "game", characterIds: [] },
  });
  assert.equal(created.statusCode, 200);
  const chatId = created.json().id;
  for (const route of ["/api/game/generate-assets", "/api/game/generate-assets/preview"]) {
    const response = await app.inject({
      method: "POST",
      url: route,
      payload: {
        chatId,
        campaignPortraitBatch: true,
        npcPortraitStylePrompt: "2.5D",
        npcsNeedingAvatars: [{ npcId: "n1", name: "Alex", description: "" }],
      },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.body, /image connection/i);
  }
  const forced = await app.inject({
    method: "POST",
    url: "/api/game/generate-assets",
    payload: { chatId, campaignPortraitBatch: true, forceNpcAvatarNames: ["Alex"] },
  });
  assert.equal(forced.statusCode, 400);
  console.log(
    "Campaign portrait identities, style persistence, legacy cache and configuration errors passed without provider calls.",
  );
} finally {
  await app.close();
  const { closeDB } = await import("../../packages/server/src/db/connection.js");
  await closeDB();
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  rmSync(root, { recursive: true, force: true });
}
