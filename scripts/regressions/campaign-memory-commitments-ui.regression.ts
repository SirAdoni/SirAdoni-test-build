import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Pulse 8 commitments view: static wiring checks for the component, hook, and localization keys.
// The server contract is proven by campaign-memory-commitments.regression.ts.
const component = readFileSync(
  new URL("../../packages/client/src/components/game/CampaignWikiCommitments.tsx", import.meta.url),
  "utf8",
);
const hooks = readFileSync(new URL("../../packages/client/src/hooks/use-campaign-memory.ts", import.meta.url), "utf8");
const locale = JSON.parse(
  readFileSync(new URL("../../packages/client/src/localization/locales/en.json", import.meta.url), "utf8"),
) as Record<string, string>;

assert.match(hooks, /\/game\/\$\{chatId\}\/memory\/commitments`, \{ entityId, state, cursor, limit \}/, "list hook uses the commitments query contract");
assert.match(hooks, /memory\/commitments\/\$\{commitmentId\}\/transition`/, "transition hook posts to the transition route");
assert.match(hooks, /expectedRevision: number;/, "transitions carry the observed revision for CAS");
assert.match(component, /export function CampaignWikiCommitments\(\{\s*chatId,\s*entityId,\s*onNavigate,/, "component signature");
assert.match(component, /items: \(page\?\.items \?\? \[\]\)\.filter\(\(item\) => item\.state === state\)/, "items are grouped by state");
assert.match(component, /onClick=\{\(\) => onNavigate\?\.\(participant\.entityId\)\}/, "participants navigate through onNavigate");
assert.match(component, /<CampaignWikiEvidence chatId=\{chatId\} evidence=\{item\.evidence\} \/>/, "evidence reuses the wiki evidence component");
assert.match(component, /<details[\s\S]*commitments\.history[\s\S]*item\.transitions\.map/, "transition history is collapsible");
assert.match(component, /expectedRevision: item\.revision/, "a transition sends the shown revision");
assert.match(component, /const conflict = errorStatus === 409/, "409 renders the conflict banner");
assert.match(component, /errorStatus === 400\s*\? t\("ui\.game\.campaignWiki\.commitments\.illegal"\)/, "400 explains an illegal transition");
assert.doesNotMatch(component, /action: "update"|api\.patch|api\.delete/, "the view never edits or deletes the shown record");

for (const key of [
  "ui.game.campaignWiki.commitments.apply",
  "ui.game.campaignWiki.commitments.conflict",
  "ui.game.campaignWiki.commitments.empty",
  "ui.game.campaignWiki.commitments.history",
  "ui.game.campaignWiki.commitments.illegal",
  "ui.game.campaignWiki.commitments.kind.invitation",
  "ui.game.campaignWiki.commitments.kind.quest",
  "ui.game.campaignWiki.commitments.state.proposed",
  "ui.game.campaignWiki.commitments.state.unresolved",
  "ui.game.campaignWiki.commitments.terminal",
  "ui.game.campaignWiki.commitments.title",
  "ui.game.campaignWiki.commitments.transition",
]) {
  assert.equal(typeof locale[key], "string", `missing localization key: ${key}`);
}
for (const kind of ["invitation", "promise", "offer", "quest", "employment", "candidacy", "other"])
  assert.equal(typeof locale[`ui.game.campaignWiki.commitments.kind.${kind}`], "string", `missing kind label ${kind}`);
for (const state of ["proposed", "accepted", "active", "completed", "declined", "cancelled", "unresolved"])
  assert.equal(typeof locale[`ui.game.campaignWiki.commitments.state.${state}`], "string", `missing state label ${state}`);
process.stdout.write("campaign-memory-commitments-ui regression passed\n");
