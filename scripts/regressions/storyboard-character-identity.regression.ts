import assert from "node:assert/strict";
import {
  uniqueStoryboardCards,
  compactStoryboardCharacterIdentity,
} from "../../packages/server/src/services/game/storyboard-character-identity.js";
import { selectStoryboardMentionedLibraryCharacterNames } from "../../packages/server/src/routes/game.routes.js";
import { buildSceneIllustrationProviderPrompt } from "../../packages/server/src/services/game/game-asset-generation.js";
import { buildChatGPTDirectImageRequest } from "../../packages/server/src/services/image/openai-chatgpt-image.js";

const npc = { id: "npc-card-outside-party", data: JSON.stringify({ name: "Quenby" }) };
assert.deepEqual(uniqueStoryboardCards([npc, { id: "other", data: '{"name":"Someone Else"}' }], ["Quenby"]), [npc]);
assert.deepEqual(
  uniqueStoryboardCards([npc, { ...npc, id: "duplicate" }], ["Quenby"]),
  [],
  "ambiguous names cannot substitute the wrong photo",
);
assert.deepEqual(
  uniqueStoryboardCards([npc], ["Someone Else"]),
  [],
  "library membership never adds scene participants",
);
const mentionedRows = [
  { id: "quenby-card", data: JSON.stringify({ name: "Quenby" }) },
  { id: "player-card", data: JSON.stringify({ name: "Rowan Mercer" }) },
  { id: "unmentioned-card", data: JSON.stringify({ name: "Someone Else" }) },
];
assert.deepEqual(
  selectStoryboardMentionedLibraryCharacterNames({
    sourceNarration: "Quenby stands at the worktable while Rowan Mercer watches from the door.",
    sections: [],
    rows: mentionedRows,
  }),
  ["Quenby", "Rowan Mercer"],
  "source-mentioned library cards are eligible even when absent from party/presence state",
);
assert.deepEqual(
  selectStoryboardMentionedLibraryCharacterNames({
    sourceNarration: "Quenby stands at the worktable.",
    sections: [],
    rows: [mentionedRows[0]!, { id: "ambiguous-quenby", data: JSON.stringify({ name: "Quenby" }) }],
  }),
  ["Quenby"],
  "mention discovery remains separate from photo selection so duplicate names can be rejected by uniqueStoryboardCards",
);
assert.deepEqual(
  uniqueStoryboardCards(
    [mentionedRows[0]!, { id: "ambiguous-quenby", data: JSON.stringify({ name: "Quenby" }) }],
    ["Quenby"],
  ),
  [],
  "ambiguous source-mentioned cards do not select a photo",
);
const identity = compactStoryboardCharacterIdentity(
  "Quenby's Appearance: OVERALL: bronze automaton.\nBUILD: tall.\nFACE: metallic face, amber lantern eyes.\nHAIR: cast bronze waves.\nATTIRE: old armor.\nGRACE: unknown.",
);
assert.match(identity, /bronze automaton/);
assert.match(identity, /cast bronze waves/);
assert.match(identity, /old armor/);
assert.doesNotMatch(identity, /unknown/);
const incidentalPrivateData = compactStoryboardCharacterIdentity(
  "A poised, beautiful woman with dark hair and clear eyes. She has a curvy build. Her private history includes concubinage and explicit sexual experiences. She wears a blue travelling coat.",
);
assert.match(incidentalPrivateData, /dark hair|clear eyes|curvy build|blue travelling coat/);
assert.doesNotMatch(incidentalPrivateData, /concubinage|sexual experiences|private history/iu);
const plainIdentity = compactStoryboardCharacterIdentity("A graceful woman with brown skin, black hair, and a strong build.");
assert.match(plainIdentity, /brown skin|black hair|strong build/);
const currentWardrobe = compactStoryboardCharacterIdentity(
  "OVERALL: a calm person. ATTIRE: current scene wardrobe is a fully covered green uniform. PRIVATE: unrelated history.",
);
assert.match(currentWardrobe, /fully covered green uniform/);
assert.doesNotMatch(currentWardrobe, /unrelated history/);
const incidentCardProjection = compactStoryboardCharacterIdentity(
  "Jadwiga Rookwood's Appearance: OVERALL: a vampire frozen at 26, a breathtaking night-court beauty, the high art of imperial flesh-shaping worn with deliberate restraint. HEIGHT AND FACE: heart-shaped face, straight slim nose, full lips, white teeth. BUILD: statuesque and curvy. ATTIRE: current scene clothing is a dark formal gown. PRIVATE: concubine and sexual history are irrelevant to this image.",
);
assert.match(incidentCardProjection, /heart-shaped face|straight slim nose|dark formal gown/);
assert.doesNotMatch(incidentCardProjection, /concubine|sexual history|private/iu);
const privateClause = compactStoryboardCharacterIdentity(
  "FACE: green eyes. BUILD: her breasts are sensitive when touched. ATTIRE: blue dress.",
);
assert.match(privateClause, /green eyes|blue dress/);
assert.doesNotMatch(privateClause, /breasts|sensitive when touched/iu);
const conjunctionClause = compactStoryboardCharacterIdentity("FACE: green eyes and large breasts. HAIR: blonde hair.");
assert.match(conjunctionClause, /green eyes|blonde hair/);
assert.doesNotMatch(conjunctionClause, /large breasts/iu);
assert.equal(compactStoryboardCharacterIdentity("FACE: green eyes", 0), "");
assert.equal(compactStoryboardCharacterIdentity("FACE: green eyes", 1).length, 1);
const multilinePrivateSection = compactStoryboardCharacterIdentity(
  "PRIVATE:\nsecret private prose without trigger words\nFACE: green eyes.",
);
assert.match(multilinePrivateSection, /green eyes/);
assert.doesNotMatch(multilinePrivateSection, /secret private prose/);
const references = ["data:image/png;base64,LOCATION", "data:image/png;base64,VIGIL"];
const result = await buildSceneIllustrationProviderPrompt({
  chatId: "proof",
  prompt: "Quenby serves tea in her new pink uniform.",
  imgModel: "gpt-image-2.5-sunburst",
  imgSource: "openai_chatgpt",
  imgBaseUrl: "http://invalid",
  imgApiKey: "",
  referenceImages: references,
  characterReferenceNames: ["Quenby"],
  locationReferenceImageAttached: true,
  characterDescriptions: [identity],
  ensureCharacterAppearance: true,
  useGamePromptTemplate: false,
  maxPromptCharacters: 8000,
});
assert.match(result.prompt, /Reference image 2 is Quenby/);
assert.match(result.prompt, /Reference image 1 is the established LOCATION/);
assert.match(result.prompt, /bronze automaton/);
assert.match(result.prompt, /new pink uniform/);
const request = buildChatGPTDirectImageRequest({
  model: "gpt-image-2.5-sunburst",
  ...result,
  referenceDataUrls: references,
});
assert.equal(request.endpoint, "images/edits");
assert.deepEqual(
  request.body.images,
  references.map((image_url) => ({ image_url })),
);
assert.match(String(request.body.prompt), /Reference image 2 is Quenby/);
console.info(
  "Storyboard NPC identity: non-party lookup, ambiguity protection, compact identity, labeled reference order and direct image payload passed.",
);
