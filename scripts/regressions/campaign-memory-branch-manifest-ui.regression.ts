import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const wiki = readFileSync(
  new URL("../../packages/client/src/components/game/CampaignWiki.tsx", import.meta.url),
  "utf8",
);
const locale = JSON.parse(
  readFileSync(new URL("../../packages/client/src/localization/locales/en.json", import.meta.url), "utf8"),
) as Record<string, string>;
const shared = readFileSync(new URL("../../packages/shared/src/types/chat.ts", import.meta.url), "utf8");

assert.match(wiki, /useChat\(chatId\)/, "CampaignWiki reads branch metadata through the existing chat-detail query");
assert.match(wiki, /branchHeldWarning/, "held branch records have a visible warning");
assert.match(wiki, /branchDiagnosticDetails/, "record IDs are placed behind diagnostic details");
assert.match(wiki, /onClick=\{\(\) => void chat\.refetch\(\)\}/, "metadata errors remain retryable");
assert.match(
  shared,
  /campaignMemoryBranch\?: CampaignMemoryBranchManifest/,
  "ChatMetadata declares the branch manifest",
);
for (const key of [
  "ui.game.campaignWiki.branchDiagnosticDetails",
  "ui.game.campaignWiki.branchHeldRecords",
  "ui.game.campaignWiki.branchHeldSummary",
  "ui.game.campaignWiki.branchHeldWarning",
  "ui.game.campaignWiki.branchStatusError",
  "ui.game.campaignWiki.branchStatusLoading",
]) {
  assert.equal(typeof locale[key], "string", `missing localization key: ${key}`);
}
assert.match(wiki, /record\.recordId/, "record IDs remain available for diagnostics");
process.stdout.write("campaign-memory-branch-manifest-ui regression passed\n");
