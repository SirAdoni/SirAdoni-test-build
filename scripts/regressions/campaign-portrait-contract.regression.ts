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
const { selectContactBookChats, selectContactBookNpcOwners } =
  await import("../../packages/server/src/services/game/game-contact-book.js");
const { resolveCampaignPortraitOwners } =
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
  { npcId: "n1", name: "Alex", description: npc.description },
  { npcId: "party:party-card", characterId: "party-card", name: "Bea", description: "Copper hair and a blue coat" },
]);
assert.equal(resolved.candidates[0]!.name, "Alex");
assert.equal(resolved.candidates[0]!.description, npc.description);
assert.equal(resolved.candidates[1]!.name, "Bea");
assert.equal(resolved.npcs[1]!.characterId, "party-card");
assert.equal(meta.gameNpcs.length, 1, "resolution does not mutate stored metadata");
assert.throws(
  () => resolveCampaignPortraitRoster(meta, [], cards, [{ npcId: "n1", name: "Forged", description: "Forged" }]),
  /identity changed/,
  "client-supplied appearance cannot replace persisted portrait identity",
);
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
assert.throws(
  () =>
    resolveCampaignPortraitRoster(
      { ...meta, gameNpcs: [npc, { ...npc, name: "Conflicting Alex", description: "Different identity" }] },
      [],
      cards,
      [{ npcId: "n1", name: "Alex", description: npc.description }],
    ),
  /current campaign/,
  "a duplicate stable NPC ID is rejected rather than resolved to the first row",
);
const duplicateOwnerChat = {
  id: "duplicate-owner-current",
  mode: "game",
  groupId: "duplicate-owner-campaign",
  metadata: {
    gameSessionNumber: 2,
    gameNpcs: [npc, { ...npc, name: "Conflicting Alex", description: "Different identity" }],
  },
};
assert.deepEqual(
  selectContactBookNpcOwners(duplicateOwnerChat, [duplicateOwnerChat]),
  [],
  "a duplicated stable NPC ID is absent from contact ownership, matching portrait resolution",
);
const removedLinkedNpc = {
  ...npc,
  avatarUrl: "/api/avatars/file/stale.png",
  avatarState: { revision: 3, removed: true },
};
const removedLinkedRoster = resolveCampaignPortraitRoster(
  { ...meta, gameNpcs: [removedLinkedNpc] },
  [],
  [{ id: "linked", avatarPath: "/api/avatars/file/stale.png", data: {} }],
  [{ npcId: " n1 ", characterId: "linked", name: "Alex", description: npc.description }],
);
assert.deepEqual(
  removedLinkedRoster.candidates.map(({ npcId }) => npcId),
  ["n1"],
  "explicitly removed canonical linked portraits bypass retained file paths and normalize IDs",
);
const existingLinkedPortraitRoster = resolveCampaignPortraitRoster(
  { ...meta, gameNpcs: [{ ...npc, avatarUrl: null }] },
  [],
  [{ id: "linked", avatarPath: "/api/avatars/file/current.png", data: {} }],
  [{ npcId: "n1", characterId: "linked", name: "Alex", description: npc.description }],
);
assert.deepEqual(
  existingLinkedPortraitRoster.candidates,
  [],
  "a current linked-card avatar suppresses a stale missing-contact request",
);
const selectedSessions = selectContactBookChats(
  { id: "current", mode: "game", groupId: "campaign", metadata: { gameSessionNumber: 4 } },
  [
    { id: "current", mode: "game", groupId: "campaign", metadata: { gameSessionNumber: 4 } },
    { id: "prior", mode: "game", groupId: "campaign", metadata: { gameSessionNumber: 3 } },
    { id: "ambiguous-a", mode: "game", groupId: "campaign", metadata: { gameSessionNumber: 2 } },
    { id: "ambiguous-b", mode: "game", groupId: "campaign", metadata: { gameSessionNumber: 2 } },
    {
      id: "branch",
      mode: "game",
      groupId: "campaign",
      metadata: { gameSessionNumber: 1, branchParentChatId: "prior" },
    },
    { id: "other-campaign", mode: "game", groupId: "other", metadata: { gameSessionNumber: 1 } },
    { id: "un-numbered", mode: "game", groupId: "campaign", metadata: {} },
  ],
);
assert.deepEqual(
  selectedSessions.map(({ id }) => id),
  ["prior", "current"],
);
const selectedOwners = selectContactBookNpcOwners(
  { id: "current", mode: "game", groupId: "campaign", metadata: { gameSessionNumber: 4 } },
  [
    {
      id: "prior-old",
      mode: "game",
      groupId: "campaign",
      metadata: { gameSessionNumber: 2, gameNpcs: [{ id: "shared", name: "Old" }] },
    },
    {
      id: "prior-new",
      mode: "game",
      groupId: "campaign",
      metadata: { gameSessionNumber: 3, gameNpcs: [{ id: "historical", name: "New owner" }] },
    },
    {
      id: "current",
      mode: "game",
      groupId: "campaign",
      metadata: { gameSessionNumber: 4, gameNpcs: [{ id: "shared", name: "Current owner" }] },
    },
  ],
);
assert.equal(selectedOwners.find((owner) => owner.id === "shared")?.npc.name, "Current owner");
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
  const { applyFeatureSettingsValue } = await import("../../packages/server/src/services/features/feature-settings.js");
  applyFeatureSettingsValue(JSON.stringify({ gameContactBook: true, campaignPortraits: true }));
  const created = await app.inject({
    method: "POST",
    url: "/api/chats",
    payload: { name: "Portrait proof", mode: "game", characterIds: [] },
  });
  assert.equal(created.statusCode, 200);
  const chatId = created.json().id;
  const contacts = await app.inject({ method: "GET", url: `/api/game/${chatId}/contacts` });
  assert.equal(contacts.statusCode, 200, contacts.body);
  assert.deepEqual(contacts.json(), { contacts: [], coverage: { complete: true, pendingSessions: 0 } });
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  await createChatsStorage(app.db).updateMetadata(chatId, {
    gameId: "campaign-contact-scope",
    gameSessionNumber: 4,
    enableSpriteGeneration: true,
    gameNpcs: [{ id: "stable-contact-id", name: "Mira current", description: "Observed red scarf" }],
  });
  const createHistoryChat = async (name: string, metadata: Record<string, unknown>) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/chats",
      payload: { name, mode: "game", characterIds: [] },
    });
    assert.equal(response.statusCode, 200, response.body);
    const id = response.json().id as string;
    await createChatsStorage(app.db).updateMetadata(id, metadata);
    return id;
  };
  const priorOwner = await createHistoryChat("Portrait prior session", {
    gameId: "campaign-contact-scope",
    gameSessionNumber: 3,
    gameNpcs: [
      { id: "stable-contact-id", name: "Mira old", description: "Old appearance" },
      { id: "historical-contact-id", name: "Historical latest", description: "Observed blue sash" },
    ],
  });
  await createHistoryChat("Portrait older session", {
    gameId: "campaign-contact-scope",
    gameSessionNumber: 2,
    gameNpcs: [{ id: "historical-contact-id", name: "Historical older", description: "Older appearance" }],
  });
  const duplicateSessionA = await createHistoryChat("Ambiguous A", {
    gameId: "campaign-contact-scope",
    gameSessionNumber: 1,
    gameNpcs: [{ id: "ambiguous-id", name: "Ambiguous" }],
  });
  await createHistoryChat("Ambiguous B", {
    gameId: "campaign-contact-scope",
    gameSessionNumber: 1,
    gameNpcs: [{ id: "ambiguous-id", name: "Ambiguous" }],
  });
  await createHistoryChat("Foreign campaign", {
    gameId: "foreign-contact-scope",
    gameSessionNumber: 3,
    gameNpcs: [{ id: "foreign-id", name: "Foreign" }],
  });
  await createHistoryChat("Portrait branch", {
    gameId: "campaign-contact-scope",
    gameSessionNumber: 5,
    branchParentChatId: chatId,
    gameNpcs: [{ id: "branch-only", name: "Branch only" }],
  });
  const currentChat = await createChatsStorage(app.db).getById(chatId);
  assert.ok(currentChat);
  const scopedOwners = await resolveCampaignPortraitOwners(app.db, currentChat, [
    { npcId: "stable-contact-id", sourceChatId: chatId, name: "Mira current", description: "Observed red scarf" },
    {
      npcId: "historical-contact-id",
      sourceChatId: priorOwner,
      name: "Historical latest",
      description: "Observed blue sash",
    },
  ]);
  assert.deepEqual(scopedOwners.map((owner) => owner.sourceChatId).sort(), [chatId, priorOwner].sort());
  await assert.rejects(
    resolveCampaignPortraitOwners(app.db, currentChat, [
      { npcId: "stable-contact-id", sourceChatId: priorOwner, name: "Mira current", description: "Observed red scarf" },
    ]),
    /outside the roster scope/,
    "duplicate stable IDs resolve to current chat before older sessions",
  );
  await assert.rejects(
    resolveCampaignPortraitOwners(app.db, currentChat, [
      { npcId: "ambiguous-id", sourceChatId: duplicateSessionA, name: "Ambiguous", description: "" },
    ]),
    /outside the roster scope/,
    "duplicate session numbers are not eligible portrait owners",
  );
  await assert.rejects(
    resolveCampaignPortraitOwners(app.db, currentChat, [
      { npcId: "foreign-id", sourceChatId: "foreign-chat", name: "Foreign", description: "" },
    ]),
    /outside the roster scope/,
    "unrelated campaign owners are rejected",
  );
  const populatedContacts = await app.inject({ method: "GET", url: `/api/game/${chatId}/contacts` });
  assert.equal(populatedContacts.statusCode, 200, populatedContacts.body);
  const apiContacts = populatedContacts.json();
  const currentContact = apiContacts.contacts.find((contact: { id: string }) => contact.id === "stable-contact-id");
  const historicalContact = apiContacts.contacts.find(
    (contact: { id: string }) => contact.id === "historical-contact-id",
  );
  assert.equal(currentContact?.sourceChatId, chatId, "current chat owner wins for duplicate stable IDs");
  assert.equal(currentContact?.name, "Mira current");
  assert.equal(currentContact?.opinion, undefined, "contact API does not invent opinion data");
  assert.equal(currentContact?.relationshipStatus, undefined, "contact API does not invent relationship data");
  assert.equal(historicalContact?.sourceChatId, priorOwner, "latest unique prior session supplies its stable owner");
  assert.equal(historicalContact?.name, "Historical latest");
  assert.equal(apiContacts.coverage.complete, false);
  assert.equal(apiContacts.coverage.pendingSessions, 2, "ambiguous duplicate sessions are surfaced as skipped scope");
  for (const route of ["/api/game/generate-assets", "/api/game/generate-assets/preview"]) {
    const response = await app.inject({
      method: "POST",
      url: route,
      payload: {
        chatId,
        campaignPortraitBatch: true,
        npcPortraitStylePrompt: "2.5D",
        npcsNeedingAvatars: [
          {
            npcId: "stable-contact-id",
            sourceChatId: chatId,
            name: "Mira current",
            description: "Observed red scarf",
          },
        ],
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    if (route.endsWith("/preview")) {
      assert.deepEqual(response.json().items, [], "preview safely skips when no image connection is configured");
    } else {
      assert.deepEqual(response.json().generatedNpcAvatars, [], "generation safely skips before any provider call");
    }
  }
  const forced = await app.inject({
    method: "POST",
    url: "/api/game/generate-assets",
    payload: { chatId, campaignPortraitBatch: true, forceNpcAvatarNames: ["Alex"] },
  });
  assert.equal(forced.statusCode, 200);
  assert.deepEqual(forced.json().generatedNpcAvatars, []);
  console.log(
    "Campaign portrait identities, style persistence, legacy cache, and no-connection skips passed without provider calls.",
  );
} finally {
  await app.close();
  const { closeDB } = await import("../../packages/server/src/db/connection.js");
  await closeDB();
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  rmSync(root, { recursive: true, force: true });
}
