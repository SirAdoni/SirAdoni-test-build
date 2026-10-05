import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Static wiring checks for the guided "Index campaign history" flow: the dialog
// reads the plan, starts nothing without a click, polls the server-side job, shows the
// session being indexed, can cancel a running job, stores its dismissal in chat
// surface exposes the manual action and once-per-game first-run prompt.
// prompt in the game surface.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const dialog = read("../../packages/client/src/components/game/CampaignIndexDialog.tsx");
const surface = read("../../packages/client/src/components/game/GameSurface.tsx");
const locale = JSON.parse(read("../../packages/client/src/localization/locales/en.json")) as Record<string, string>;

assert.match(
  dialog,
  /\/game\/campaign-index\/plan\?chatId=\$\{encodeURIComponent\(chatId\)\}/,
  "plan is read per chat",
);
assert.match(dialog, /\/game\/campaign-index\/status\?chatId=\$\{encodeURIComponent\(chatId\)\}/, "status is polled");
assert.match(dialog, /"\/game\/campaign-index\/run",\s*\{ chatId, steps: body \}/, "run posts the chosen steps");
assert.match(dialog, /enabled: indexEnabled && tracking,\s*refetchInterval:/, "status polling runs while a job exists");
assert.match(dialog, /const tracking = !!planGame\?\.job;/, "a persisted job is tracked when the dialog opens");
assert.match(
  dialog,
  /onClick=\{\(\) => steps && run\.mutate\(effectiveSteps\)\}/,
  "Start is the only trigger for the run",
);
assert.match(dialog, /data-campaign-index-lineage=\{lineage\.status\}/, "the dialog reports selected lineage status");
assert.match(dialog, /lineage\.sessions\.map\(\(session\) =>/, "ready lineage lists the selected sessions");
assert.match(dialog, /session\.branchPathChatIds\.map\(chatLabel\)/, "ready lineage explains the selected branch path");
assert.match(
  dialog,
  /lineage\?\.holds \?\? \[\]\)\.map\(\(hold\) => chatLabel\(hold\.chatId\)\)/,
  "held lineage names affected sessions",
);
assert.match(dialog, /!run\.isPending &&\s*!lineageHeld/, "held lineage blocks starting indexing");
assert.match(dialog, /disabled=\{!canStart \|\| lineageHeld\}/, "the Start control is disabled for held lineage");
assert.match(dialog, /jobTargetMismatch &&/, "the dialog identifies a job for another target chat");
assert.match(dialog, /job\.lineageHold &&/, "the dialog explains a paused lineage hold");
assert.doesNotMatch(dialog, /useEffect\([^)]*run\.mutate/, "nothing runs from an effect");
assert.match(
  dialog,
  /api\.post<\{ retired: number; removedManifests: string\[\] \}>\("\/game\/campaign-index\/cancel", \{ gameId \}\)/,
  "cancel posts the game id",
);
assert.match(dialog, /onClick=\{\(\) => cancel\.mutate\(job\.gameId\)\}/, "Cancel is an explicit click");
assert.match(
  dialog,
  /\(job\.status === "running" \|\| job\.status === "paused"\) && \(/,
  "Cancel is offered only while a job can still be stopped",
);
assert.match(
  dialog,
  /t\("ui\.game\.campaignIndex\.currentSession", \{ session: sessionLabel\(t, currentChat\) \}\)/,
  "the progress view names the session being indexed",
);
assert.match(
  dialog,
  /const currentChatId = job && running \? job\.order\[job\.currentIndex\] : null;/,
  "the current session comes from the job order",
);
assert.match(
  dialog,
  /const disabled =\s*state === "unavailable"\s*\|\|\s*!stepAllowed\(step.key\)\s*\|\|\s*\(step.key === "backfill" && !game\.continuityConfigured\);/,
  "unavailable steps and backfill without a continuity connection are disabled",
);
assert.match(
  dialog,
  /updateMetadata\.mutate\(\{ id: chatId, campaignIndexPrompt: \{ dismissedAt: new Date\(\)\.toISOString\(\) \} \}\)/,
  "dismissal is stored in chat metadata",
);
assert.doesNotMatch(dialog, /localStorage/, "dismissal never lives only in localStorage");
assert.match(
  dialog,
  /game\.needsIndexing && !game\.promptDismissedAt\) setOpen\(true\)/,
  "auto prompt respects dismissal",
);
// Static JSX copy is gated by `node scripts/migrate-static-jsx-localization.mjs --check --notices packages/client/src`.

assert.equal(
  (
    surface.match(
      /onClick=\{\(\) => (?:setCampaignIndexOpen\(true\)|\{\s*setMobileActionsOpen\(false\);\s*setCampaignIndexOpen\(true\);\s*\})\}/g,
    ) ?? []
  ).length,
  2,
  "desktop and mobile Game Mode actions expose Campaign Index",
);
assert.match(surface, /<CampaignIndexDialog chatId=\{activeChatId\}/, "the dialog targets the selected chat");

assert.match(surface, /import\("\.\/CampaignIndexDialog"\)/, "game surface lazy-loads the auto prompt");
assert.match(
  surface,
  /\{campaignIndexEnabled && gameId && !campaignIndexPromptSettled && \(\s*<Suspense fallback=\{null\}>\s*<CampaignIndexAutoPrompt key=\{activeChatId\} chatId=\{activeChatId\} manualOpen=\{campaignIndexOpen\} \/>/,
  "the auto prompt only mounts while the offer is still open",
);
// Once the offer was dismissed or a job exists, the surface must not mount the prompt at all: its plan query
// runs a per-session owner preview that stalled the Engine on every tab open.
assert.match(surface, /campaignIndexPromptSettled\s*=[\s\S]{0,200}dismissedAt/, "a dismissed offer settles the prompt");
assert.match(
  surface,
  /campaignIndexPromptSettled\s*=[\s\S]{0,260}campaignIndexJob/,
  "an existing job settles the prompt",
);

for (const key of [
  "ui.game.campaignIndex.close",
  "ui.game.campaignIndex.column.coverage",
  "ui.game.campaignIndex.column.messages",
  "ui.game.campaignIndex.column.owners",
  "ui.game.campaignIndex.column.session",
  "ui.game.campaignIndex.column.turns",
  "ui.game.campaignIndex.costNote",
  "ui.game.campaignIndex.coverage",
  "ui.game.campaignIndex.intro",
  "ui.game.campaignIndex.lineage.title",
  "ui.game.campaignIndex.lineage.ready",
  "ui.game.campaignIndex.lineage.session",
  "ui.game.campaignIndex.lineage.held",
  "ui.game.campaignIndex.lineage.affected",
  "ui.game.campaignIndex.lineage.path",
  "ui.game.campaignIndex.lineage.unknownSession",
  "ui.game.campaignIndex.jobLineageChanged",
  "ui.game.campaignIndex.jobLineageInvalid",
  "ui.game.campaignIndex.jobTargetMissing",
  "ui.game.campaignIndex.jobTargetMismatch",
  "ui.game.campaignIndex.loadError",
  "ui.game.campaignIndex.loading",
  "ui.game.campaignIndex.noReceipts",
  "ui.game.campaignIndex.notConfigured",
  "ui.game.campaignIndex.notNow",
  "ui.game.campaignIndex.open",
  "ui.game.campaignIndex.ownersPending",
  "ui.game.campaignIndex.ownersRegistered",
  "ui.game.campaignIndex.ownersUnknown",
  "ui.game.campaignIndex.cancel",
  "ui.game.campaignIndex.cancelError",
  "ui.game.campaignIndex.cancelling",
  "ui.game.campaignIndex.currentSession",
  "ui.game.campaignIndex.jobCancelled",
  "ui.game.campaignIndex.jobDone",
  "ui.game.campaignIndex.jobPaused",
  "ui.game.campaignIndex.manifestLine",
  "ui.game.campaignIndex.orderNote",
  "ui.game.campaignIndex.progressNote",
  "ui.game.campaignIndex.published",
  "ui.game.campaignIndex.resume",
  "ui.game.campaignIndex.result.failed",
  "ui.game.campaignIndex.result.ownersRegistered",
  "ui.game.campaignIndex.result.turnsQueued",
  "ui.game.campaignIndex.retry",
  "ui.game.campaignIndex.sessionLabel",
  "ui.game.campaignIndex.sessionState",
  "ui.game.campaignIndex.sessionUnknown",
  "ui.game.campaignIndex.start",
  "ui.game.campaignIndex.startError",
  "ui.game.campaignIndex.starting",
  "ui.game.campaignIndex.step.backfill",
  "ui.game.campaignIndex.step.publishVerified",
  "ui.game.campaignIndex.step.registerOwners",
  "ui.game.campaignIndex.stepsLegend",
  "ui.game.campaignIndex.title",
  "ui.game.campaignIndex.totals",
  "ui.game.campaignIndex.upToDate",
  ...["queued", "extracting", "reviewing", "repairing", "verified", "published", "unresolved", "failed", "stale"].map(
    (status) => `ui.game.campaignIndex.receiptStatus.${status}`,
  ),
  ...["pending", "enqueued", "terminal", "published", "skipped", "failed"].map(
    (state) => `ui.game.campaignIndex.state.${state}`,
  ),
]) {
  assert.equal(typeof locale[key], "string", `missing localization key: ${key}`);
}
for (const key of dialog.matchAll(/t\("(ui\.game\.campaignIndex\.[^"`]+)"/g)) {
  assert.equal(typeof locale[key[1]], "string", `dialog uses unknown key ${key[1]}`);
}
const templated = /campaignIndex\.(receiptStatus|state)\./;
for (const key of Object.keys(locale).filter((candidate) => candidate.startsWith("ui.game.campaignIndex."))) {
  if (templated.test(key)) continue;
  assert.ok(dialog.includes(`"${key}"`) || surface.includes(`"${key}"`), `unused localization key: ${key}`);
}
process.stdout.write("campaign-index-ui regression passed\n");

assert.match(dialog, /if \(!indexEnabled\) return null;/, "mounted dialog hides while OFF");
assert.match(
  dialog,
  /if \(!isCampaignFeatureEnabled\(qc, "campaignIndex"\)\) return;/,
  "stale dismissal and result callbacks recheck permission",
);
assert.match(
  dialog,
  /body.registerOwners && !isCampaignFeatureEnabled\(qc, "campaignMemory"\)/,
  "owner mutation checks the destination at dispatch",
);
assert.match(
  dialog,
  /body.backfill && !isCampaignFeatureEnabled\(qc, "gameContinuity"\)/,
  "backfill checks its prerequisite at dispatch",
);
assert.match(dialog, /enabled: indexEnabled && enabled && !!chatId/, "plan query is disabled while OFF");

// Execute the actual summary expression with suppressed prerequisite fields.
const ast = ts.createSourceFile("CampaignIndexDialog.tsx", dialog, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let summary: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "stepStates") summary = node.initializer;
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(summary);
const summaryCode = ts.transpileModule(`const result = ${summary.getText(ast)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const summarize = new Function(
  "memoryEnabled",
  "continuityEnabled",
  "chats",
  "ownersToRegister",
  "unreadMessages",
  `${summaryCode}; return result;`,
);
assert.equal(summarize(false, true, [{ ownersRegistered: null }], 0, 0).registerOwners, "unavailable");
assert.equal(summarize(true, true, [{ ownersRegistered: null }], 0, 0).registerOwners, "unavailable");
assert.equal(summarize(true, true, [{ ownersRegistered: true }], 0, 0).registerOwners, "done");
assert.equal(summarize(true, true, [{ ownersRegistered: false }], 1, 0).registerOwners, "todo");
assert.equal(summarize(true, false, [], 0, 0).backfill, "unavailable");
assert.equal(summarize(false, true, [], 0, 0).publishVerified, "unavailable");
assert.match(
  dialog,
  /state === "unavailable"\s*\? t\("ui.game.campaignIndex.stepStatus.unavailable"\)\s*: step.status/,
  "unavailable steps use a neutral, honest status",
);
