import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Pulse 7 authoring surfaces: correction drawer (supersession), archive references, entity creation with owner selection.
// Rendered behaviour is proven by .tmp/v3-execution/wiki-ui/run-authoring.mjs; this guards the wiring that the fixture relies on.
const editor = readFileSync(
  new URL("../../packages/client/src/components/game/CampaignWikiEditor.tsx", import.meta.url),
  "utf8",
);
const create = readFileSync(
  new URL("../../packages/client/src/components/game/CampaignWikiCreateRecord.tsx", import.meta.url),
  "utf8",
);
const locale = JSON.parse(
  readFileSync(new URL("../../packages/client/src/localization/locales/en.json", import.meta.url), "utf8"),
) as Record<string, string>;

assert.match(editor, /supersedesFactId: fact\.factId/, "a correction creates a superseding fact linked to the original");
assert.match(editor, /action: "create",\s+recordType: "fact"/, "the correction path is a create, so the original row is retained");
assert.match(editor, /<CampaignWikiEvidence chatId=\{chatId\} evidence=\{fact\.evidence\} \/>/, "the drawer reuses the evidence component");
assert.match(editor, /memory\/facts\/\$\{fact\?\.factId\}\/dependents/, "downstream impact reads the dependents contract");
assert.match(editor, /memory\/entities\/\$\{entity\.entityId\}\/references/, "archiving reads the references contract");
assert.match(editor, /archiving && !references\.data/, "preview is blocked until affected references are shown");
assert.match(editor, /status: archived \? "archived" : "active"/, "archive is a status patch, never a delete");
assert.doesNotMatch(editor, /action: "delete"|api\.delete/, "the editor never deletes campaign memory");
assert.match(create, /\["organization", "item", "quest", "lore", "note"\]/, "entity creation offers the plan's kinds");
assert.match(create, /type: "registry", store: "campaign-memory", recordId: entityId/, "registry owners point at their own entity ID");
assert.match(create, /type: "existing", store: ownerStore, recordId/, "other kinds require an existing owner record");
assert.match(create, /memory\/entities\?owner=/, "the owner picker uses the owner lookup contract");
assert.match(
  editor,
  /\.\.\.\(body !== entityBody \? \{ body \} : \{\}\)/,
  "the entity tab patches prose notes like summary",
);
assert.match(editor, /maxLength=\{20000\}/, "the notes textarea mirrors the server cap");
for (const key of [
  "ui.game.campaignWiki.create.entity",
  "ui.game.campaignWiki.editor.notes",
  "ui.game.campaignWiki.editor.field.body",
  "ui.game.campaignWiki.create.ownerLinked",
  "ui.game.campaignWiki.create.ownerRegistry",
  "ui.game.campaignWiki.editor.correction",
  "ui.game.campaignWiki.editor.downstreamImpact",
  "ui.game.campaignWiki.editor.protectRecord",
  "ui.game.campaignWiki.editor.archive",
  "ui.game.campaignWiki.editor.archiveReferences",
  "ui.game.campaignWiki.editor.referencesPreserved",
]) {
  assert.equal(typeof locale[key], "string", `missing localization key: ${key}`);
}
process.stdout.write("campaign-memory-authoring-ui regression passed\n");
