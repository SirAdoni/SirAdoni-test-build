import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCharacterLibraryCategory } from "../../packages/shared/src/utils/character-library-category.js";
import {
  buildNpcProfileContext,
  npcProfileSourceKey,
  parseNpcProfiles,
  parseNpcIdentityDecisions,
} from "../../packages/server/src/services/game/npc-profile.js";
import {
  syncGameNpcCharacters,
  isVerifiedNpcCharacterData,
  type GameNpcCharacterCandidate,
} from "../../packages/server/src/services/game/npc-character-sync.js";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { createCharactersStorage } from "../../packages/server/src/services/storage/characters.storage.js";

const candidate: GameNpcCharacterCandidate = {
  npcId: "npc:mereth-drummond",
  name: "Mereth Drummond",
  description: ': "Rowan Mercer, my mother, Mereth Drummond.',
  appearance: "",
  location: "",
  evidenceKind: "narration",
  sourceMessageId: "turn1",
  sourceSwipeIndex: 0,
};
const sourceKey = npcProfileSourceKey("turn1", 0, "creative");
const biology = "Women begin visible aging at 100; all have soft facial features.";
const withLore = buildNpcProfileContext([candidate], [], [], biology);
assert.equal(JSON.parse(withLore).worldLore, biology);
assert.equal(JSON.parse(buildNpcProfileContext([candidate], [], [])).worldLore, "");
assert.notEqual(npcProfileSourceKey("turn1", 0, withLore), sourceKey);
assert.match(JSON.parse(withLore).profileRequirements, /Chronological age is not apparent age/);
const generated = {
  npcId: candidate.npcId,
  name: candidate.name,
  description: "Mereth Drummond is Faelan's mother, a weaver who welcomes visitors to her home.",
  appearance: "Silver hair in a practical braid; a russet working dress.",
  personality: "Practical, warmly direct, and attentive to craftsmanship.",
  backstory: "She raised Faelan while working as a weaver.",
  creativeAdditions: "Practical braid.",
};
const profile = {
  ...parseNpcProfiles(JSON.stringify({ profiles: [generated] }), [candidate], sourceKey).get(candidate.npcId)!,
  sourceMessageId: "turn1",
};
assert.throws(() =>
  parseNpcProfiles(JSON.stringify({ profiles: [{ ...generated, name: "Faelan Drummond" }] }), [candidate], sourceKey),
);
assert.throws(() => parseNpcProfiles(JSON.stringify({ profiles: [generated, generated] }), [candidate], sourceKey));
assert.throws(() =>
  parseNpcProfiles(JSON.stringify({ profiles: [{ ...generated, npcId: "player" }] }), [candidate], sourceKey),
);
assert.throws(() =>
  parseNpcProfiles(JSON.stringify({ profiles: [{ ...generated, description: "fragment" }] }), [candidate], sourceKey),
);
assert.notEqual(sourceKey, npcProfileSourceKey("turn1", 1, "creative"));
assert.notEqual(sourceKey, npcProfileSourceKey("turn1", 0, "strict"));
const context = JSON.parse(
  buildNpcProfileContext(
    [candidate],
    [
      { id: "u", role: "user", content: "She is a weaver, not a mage." },
      { id: "a", role: "assistant", content: "Faelan introduced Mereth as her mother." },
    ],
    [],
  ),
);
assert.equal(context.transcript[0].role, "user");
assert.equal(context.targets[0].name, "Mereth Drummond");
assert.equal(isVerifiedNpcCharacterData({ name: "Authored character" }), true);
assert.equal(isVerifiedNpcCharacterData(null), false);
const identityContext = buildNpcProfileContext(
  [candidate],
  [{ id: "proof", role: "assistant", content: "The weaver introduced herself as Mereth Drummond." }],
  [],
);
const decision = {
  npcId: candidate.npcId,
  name: candidate.name,
  status: "confirmed",
  messageId: "proof",
  quote: "The weaver introduced herself as Mereth Drummond.",
  reason: "Explicit introduction",
};
const verify = (decisions: unknown[]) =>
  parseNpcIdentityDecisions(JSON.stringify({ decisions }), [candidate], identityContext);
assert.equal(verify([decision]).get(candidate.npcId), "confirmed");
assert.throws(() => verify([]));
assert.throws(() => verify([decision, decision]));
// Unsupported evidence downgrades that one decision to uncertain instead of failing the batch.
assert.equal(
  verify([{ ...decision, quote: "Mereth Drummond is an imaginary quote." }]).get(candidate.npcId),
  "uncertain",
);
assert.equal(verify([{ ...decision, messageId: "invented" }]).get(candidate.npcId), "uncertain");
assert.throws(() => verify([{ ...decision, name: "Another Person" }]));
assert.equal(
  verify([{ ...decision, status: "uncertain", quote: "", messageId: "" }]).get(candidate.npcId),
  "uncertain",
);
{
  // Identity verifier: alias tokens, title stripping, quote normalization and per-decision downgrade.
  const captain = { ...candidate, npcId: "npc:captain-rhosyn-vell", name: "Captain Rhosyn Vell" };
  const pilot = { ...candidate, npcId: "npc:tamsin-vell", name: "Tamsin Vell" };
  const clerk = { ...candidate, npcId: "npc:odo-marsh", name: "Odo Marsh" };
  const batch = [captain, pilot, clerk];
  const batchContext = buildNpcProfileContext(
    batch,
    [
      {
        id: "m1",
        role: "assistant",
        content:
          "Rhosyn asked for the charts.\n\u201CHold  the line,\u201D Tamsin Vell told the crew.\nOdo Marsh stamped the manifest.",
      },
      { id: "m2", role: "assistant", content: "Vell asked the harbor master for a berth." },
      { id: "m3", role: "assistant", content: "The quartermaster counted every crate twice." },
    ],
    [],
  );
  const confirm = (target: typeof captain, messageId: string, quote: string) => ({
    npcId: target.npcId,
    name: target.name,
    status: "confirmed",
    messageId,
    quote,
    reason: "Named in narration",
  });
  const verifyBatch = (decisions: unknown[]) =>
    parseNpcIdentityDecisions(JSON.stringify({ decisions }), batch, batchContext);

  // A first-name token (title dropped) confirms; curly quotes, doubled spaces and case are normalized.
  const normalized = verifyBatch([
    confirm(captain, "m1", "rhosyn asked for the charts."),
    confirm(pilot, "m1", '"Hold the line," Tamsin Vell told the crew.'),
    confirm(clerk, "m1", "Odo Marsh stamped the manifest."),
  ]);
  assert.deepEqual([...normalized.values()], ["confirmed", "confirmed", "confirmed"]);

  // "Vell" is shared by two targets, so it proves neither; that one decision is uncertain,
  // it does not throw, and the rest of the batch is still processed.
  const shared = verifyBatch([
    confirm(captain, "m2", "Vell asked the harbor master for a berth."),
    confirm(pilot, "m1", '"Hold the line," Tamsin Vell told the crew.'),
    { ...confirm(clerk, "", ""), status: "rejected" },
  ]);
  assert.equal(shared.get(captain.npcId), "uncertain");
  assert.equal(shared.get(pilot.npcId), "confirmed");
  assert.equal(shared.get(clerk.npcId), "rejected");

  // Alone in the batch, the surname is an unambiguous token for the full stored name.
  assert.equal(
    parseNpcIdentityDecisions(
      JSON.stringify({ decisions: [confirm(captain, "m2", "Vell asked the harbor master for a berth.")] }),
      [captain],
      batchContext,
    ).get(captain.npcId),
    "confirmed",
  );

  // A quote with no name token at all is uncertain, not a batch failure.
  const nameless = verifyBatch([
    confirm(captain, "m3", "The quartermaster counted every crate twice."),
    confirm(pilot, "m1", '"Hold the line," Tamsin Vell told the crew.'),
    confirm(clerk, "m1", "Odo Marsh stamped the manifest."),
  ]);
  assert.deepEqual([...nameless.values()], ["uncertain", "confirmed", "confirmed"]);

  // Structural problems (unknown target, omitted target) still reject the whole response.
  assert.throws(() => verifyBatch([confirm(captain, "m1", "Rhosyn asked for the charts.")]));
}
const fragment = { ...candidate, npcId: "npc:unfortunately", name: "Unfortunately" };
const fragmentContext = buildNpcProfileContext(
  [fragment],
  [
    {
      id: "bad",
      role: "assistant",
      content: "Unfortunately, the woman who had laced it considered sitting down a failure of posture.",
    },
  ],
  [],
);
assert.equal(
  parseNpcIdentityDecisions(
    JSON.stringify({
      decisions: [
        {
          ...decision,
          npcId: fragment.npcId,
          name: fragment.name,
          status: "rejected",
          quote: "",
          messageId: "",
          reason: "Sentence-opening adverb, not the woman's name",
        },
      ],
    }),
    [fragment],
    fragmentContext,
  ).get(fragment.npcId),
  "rejected",
);
assert.equal(getCharacterLibraryCategory({}), "characters");
assert.equal(
  getCharacterLibraryCategory({ tags: ["Game NPC", "Auto-created"] }),
  "characters",
  "display tags are not identity",
);
assert.equal(getCharacterLibraryCategory({ extensions: { marinara: { gameNpc: { autoCreated: true } } } }), "npcs");
assert.equal(
  getCharacterLibraryCategory({
    extensions: { libraryCategory: "characters", marinara: { gameNpc: { autoCreated: true } } },
  }),
  "characters",
);

const storageRoot = mkdtempSync(join(tmpdir(), "marinara-npc-profile-"));
const previousRoot = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = storageRoot;
const db = await createFileNativeDB();
try {
  const store = createCharactersStorage(db);
  const base = { db, gameId: "profile-game", chatId: "profile-chat", sessionNumber: 1, campaignName: "Profile proof" };
  const denied = await syncGameNpcCharacters({ ...base, candidates: [candidate] });
  assert.equal(denied.created.length, 0, "unverified candidates must fail closed");
  const noProfile = await syncGameNpcCharacters({ ...base, candidates: [{ ...candidate, identityVerified: true }] });
  assert.equal(noProfile.created.length, 0, "identity alone cannot create a fragment card");
  const created = await syncGameNpcCharacters({
    ...base,
    candidates: [{ ...candidate, identityVerified: true, profile }],
  });
  const id = created.created[0]!.characterId;
  assert.equal(isVerifiedNpcCharacterData((await store.getById(id))!.data), true);
  const linked = { ...candidate, characterId: id };
  await syncGameNpcCharacters({ ...base, candidates: [{ ...linked, profile }] });
  let data = JSON.parse((await store.getById(id))!.data);
  assert.equal(data.description, generated.description);
  assert.equal(data.personality, generated.personality);
  assert.equal(data.extensions.appearance, generated.appearance);
  assert.equal(data.extensions.backstory, generated.backstory);
  assert.equal(data.extensions.marinara.gameNpc.creativeAdditions, generated.creativeAdditions);
  assert.equal((await store.listPage({ limit: 1, offset: 0, category: "npcs" })).items[0]?.id, id);
  assert.equal((await store.listPage({ limit: 1, offset: 0, category: "characters" })).items.length, 0);

  // Ordinary sync must not put the original dialogue fragment back over a profile.
  await syncGameNpcCharacters({ ...base, candidates: [linked] });
  data = JSON.parse((await store.getById(id))!.data);
  assert.equal(data.description, generated.description);
  await store.update(id, {
    personality: "User-authored personality",
    extensions: { ...data.extensions, libraryCategory: "characters", backstory: "User-authored backstory" },
  });
  await syncGameNpcCharacters({
    ...base,
    candidates: [
      {
        ...linked,
        profile: {
          ...profile,
          sourceKey: "second",
          personality: "Replacement personality",
          backstory: "Replacement backstory",
          appearance: "A new supported appearance.",
        },
      },
    ],
  });
  data = JSON.parse((await store.getById(id))!.data);
  assert.equal(data.personality, "User-authored personality");
  assert.equal(data.extensions.backstory, "User-authored backstory");
  assert.equal(data.extensions.appearance, "A new supported appearance.");
  assert.equal(getCharacterLibraryCategory(data), "characters");
  assert.equal((await store.listPage({ limit: 1, offset: 0, category: "characters" })).items[0]?.id, id);
  assert.equal((await store.listPage({ limit: 1, offset: 0, category: "npcs" })).items.length, 0);
  assert.equal((await store.list()).length, 1, "moving never copies or deletes the card");
  await syncGameNpcCharacters({
    ...base,
    candidates: [
      { ...linked, profile: { ...profile, description: "Stale generation must never replace the saved profile." } },
    ],
    isTargetCurrent: async () => false,
  });
  assert.equal(JSON.parse((await store.getById(id))!.data).description, generated.description);
} finally {
  await db._fileStore.close();
  if (previousRoot === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousRoot;
  rmSync(storageRoot, { recursive: true, force: true });
}
console.log("NPC profile and library category regressions passed.");
