import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Static source checks for the Pulse 8 reader additions (timeline, co-holders, perspective, fact vocabulary,
// match tiers). Rendered behaviour is proven by the fetch-mocked fixture in .tmp/v3-execution/wiki-ui/run-timeline.mjs.
const wiki = readFileSync(
  new URL("../../packages/client/src/components/game/CampaignWiki.tsx", import.meta.url),
  "utf8",
);
const wikiWindow = readFileSync(
  new URL("../../packages/client/src/components/game/CampaignWikiWindow.tsx", import.meta.url),
  "utf8",
);
const hooks = readFileSync(new URL("../../packages/client/src/hooks/use-campaign-memory.ts", import.meta.url), "utf8");
const apiClient = readFileSync(new URL("../../packages/client/src/lib/api-client.ts", import.meta.url), "utf8");
const routeIndex = readFileSync(new URL("../../packages/server/src/routes/index.ts", import.meta.url), "utf8");
const memoryRoutes = readFileSync(
  new URL("../../packages/server/src/routes/campaign-memory.routes.ts", import.meta.url),
  "utf8",
);
const factControls = readFileSync(
  new URL("../../packages/client/src/components/game/CampaignWikiFacts.tsx", import.meta.url),
  "utf8",
);
const factEditor = readFileSync(
  new URL("../../packages/client/src/components/game/CampaignWikiEditor.tsx", import.meta.url),
  "utf8",
);
const wikiUi = readFileSync(
  new URL("../../packages/client/src/components/game/campaign-wiki-ui.tsx", import.meta.url),
  "utf8",
);
const ownerLink = readFileSync(
  new URL("../../packages/client/src/components/game/CampaignWikiOwnerLink.tsx", import.meta.url),
  "utf8",
);
const lorebookEditor = readFileSync(
  new URL("../../packages/client/src/components/lorebooks/LorebookEditor.tsx", import.meta.url),
  "utf8",
);
const lorebookEntryFocus = readFileSync(
  new URL("../../packages/client/src/lib/lorebook-entry-focus.ts", import.meta.url),
  "utf8",
);
const serverApp = readFileSync(new URL("../../packages/server/src/app.ts", import.meta.url), "utf8");
const locale = JSON.parse(
  readFileSync(new URL("../../packages/client/src/localization/locales/en.json", import.meta.url), "utf8"),
) as Record<string, string>;

assert.match(
  hooks,
  /\/game\/\$\{chatId\}\/memory\/timeline`, \{ entityId, locationId, cursor, limit \}/,
  "timeline hook uses contract item 3 query",
);
assert.match(hooks, /nextCursor: string \| null/, "timeline page carries nextCursor");
assert.match(hooks, /matchTier\?: CampaignMemoryMatchTier/, "entity list items carry matchTier");
assert.match(hooks, /coHolders\?: CampaignMemoryCoHolder\[\]/, "facts carry coHolders");
assert.match(
  wikiWindow,
  /export interface CampaignWikiWindowProps[\s\S]*target\?: CampaignWikiTarget \| null/,
  "the Wiki window exposes its owner-target contract for host integrations",
);
assert.match(
  wikiWindow,
  /\/game\/\$\{chatId\}\/memory\/entities\?owner=\$\{encodeURIComponent\(ownerTarget\?\.owner \?\? ""\)\}&limit=1/,
  "owner links use the stable owner query and encode its identity",
);
assert.match(apiClient, /const BASE = "\/api";/, "the client API prefix maps the Wiki path under /api");
assert.match(
  routeIndex,
  /app\.register\(campaignMemoryRoutes, \{ prefix: "\/api\/game" \}\)/,
  "the production route tree registers Campaign Memory under /api/game",
);
assert.match(
  memoryRoutes,
  /app\.get\("\/:chatId\/memory\/entities"[\s\S]*?entities = entities\.filter\(\(entity\) => entity\.owner\.store === store && entity\.owner\.recordId === recordId\)/,
  "the registered owner lookup matches exact store and record id within its chat reader",
);
assert.match(serverApp, /app\.addHook\("onRequest", basicAuthHook\)/, "the route tree inherits server authentication");
assert.match(
  serverApp,
  /app\.addHook\("onRequest", csrfProtectionHook\)/,
  "unsafe Wiki writes inherit CSRF protection",
);
assert.match(
  factControls,
  /export function isPinnedFact\([\s\S]*?return fact\.manualLock && wikiValueRecord\(fact\.value\)\?\.pinned === true/,
  "pin state reflects the persisted pinned value and its manual mutation lock",
);
assert.match(
  factControls,
  /pinned && \([\s\S]*?aria-label=\{t\("ui\.game\.campaignWiki\.facts\.pinnedMark"/,
  "existing pinned facts retain a read-only pinned marker",
);
assert.doesNotMatch(
  factControls,
  /lockedBeforePin|ui\.game\.campaignWiki\.facts\.(?:pin|unpin)"|onClick=\{(?:pin|unpin)\}/,
  "read-only pinned values are not rewritten or stripped by Wiki pin actions",
);
assert.match(
  factEditor,
  /label=\{t\("ui\.game\.campaignWiki\.editor\.manualLock"\)\}[\s\S]*?checked=\{factLock\}[\s\S]*?onChange=\{\(checked\) => \{\s*setFactLock\(checked\);\s*updateDirty\(\);/,
  "ordinary fact editing still exposes its independent manual-lock control",
);
assert.match(
  factControls,
  /onError: \(failure\) => \{[\s\S]*?setError\(detail !== null \? "crossSession" : isWikiRevisionConflict\(failure\) \? "conflict" : "generic"\)/,
  "fact mutation failures are categorized for the UI",
);
assert.match(
  wikiUi,
  /const body = \(error\.payload \?\? \{\}\) as WikiErrorBody;[\s\S]*?typeof body\.code === "string"[\s\S]*?body\.error\.code/,
  "Wiki API error codes are read from the payload supported by ApiError",
);
assert.match(ownerLink, /from "\.\.\/characters\/AvatarImage"/, "owner portraits use the repository avatar fallback");
assert.match(
  ownerLink,
  /if \(lore\.target\.entryId\) openLorebookEntry\(lore\.target\.lorebookId, lore\.target\.entryId\)/,
  "stable lorebook-entry owners open their exact entry",
);
assert.match(
  lorebookEntryFocus,
  /openLorebookDetail\(lorebookId,\s*\{\s*initialTab: "entries",\s*entryId,\s*\}\)/,
  "entry focus sends its ID through the shared reactive detail request",
);
assert.doesNotMatch(lorebookEntryFocus, /pending|sessionStorage/i, "entry focus has no second pending queue");
assert.match(
  lorebookEditor,
  /useUIStore\(\(s\) => s\.lorebookDetailInitialEntryId\)/,
  "the lorebook editor subscribes to the reactive focus request",
);
assert.match(
  lorebookEditor,
  /if \(!lorebookId \|\| !lorebookDetailInitialEntryId \|\| !rawEntries \|\| isLoading \|\| !lorebook\) return;[\s\S]*?if \(!entries\.some\(\(entry\) => entry\.id === lorebookDetailInitialEntryId\)\) return;/,
  "the lorebook editor waits for loaded rows and the requested entry",
);
assert.match(
  lorebookEditor,
  /current\.lorebookDetailId !== lorebookId \|\|\s*current\.lorebookDetailInitialEntryId !== lorebookDetailInitialEntryId/,
  "a stale effect cannot consume another book's or a newer request",
);
assert.match(
  lorebookEditor,
  /setState\(\{ lorebookDetailInitialEntryId: null \}\);\s*jumpToEntry\(lorebookDetailInitialEntryId\)/,
  "the effect clears only the matching request before jumping to it",
);
assert.doesNotMatch(
  lorebookEditor,
  /hasPendingLorebookEntryFocus|takePendingLorebookEntryFocus|initialEntryIdRef/,
  "the editor no longer uses a pending queue or mount-time request snapshot",
);
assert.match(
  factControls,
  /\{error && \([\s\S]*?<div role="alert"[\s\S]*?ui\.game\.campaignWiki\.facts\.saveError/,
  "mutation failures reach an accessible visible error state",
);

assert.match(
  wiki,
  /useCampaignMemoryTimeline\(chatId, \{ entityId, locationId, cursor: cursors\[cursors\.length - 1\] \}\)/,
  "timeline pages by cursor history",
);
assert.match(wiki, /timelineLoading[\s\S]*timelineEmpty/, "timeline has explicit loading and empty states");
assert.match(
  wiki,
  /timeline\.isError && <ErrorState onRetry=\{\(\) => void timeline\.refetch\(\)\}/,
  "timeline error state is retryable",
);
assert.match(
  wiki,
  /locationId=\{entity\.kind === "location" \? entity\.entityId : undefined\}/,
  "location pages filter by locationId",
);
assert.match(
  wiki,
  /fact\.status === "retracted" \|\| conflicting\) return "disputed"/,
  "retracted or conflicting supersession is disputed",
);
assert.match(
  wiki,
  /fact\.status === "held" \|\| fact\.status === "proposed"\) return "pending"/,
  "held and proposed are pending",
);
assert.match(wiki, /freshness === "stale"\) return "stale"/, "changed source is stale");
assert.match(
  wiki,
  /freshness === "legacy" \|\| fact\.provenance\.actor === "import"\) return "legacy"/,
  "import or legacy provenance is legacy",
);
assert.match(wiki, /const \[perspective, setPerspective\] = useState\("gm"\)/, "perspective is local display state");
assert.doesNotMatch(
  wiki.slice(wiki.indexOf("function Detail("), wiki.indexOf("function CampaignWikiTimeline(")),
  /useMutation|mutateAsync|api\.post/,
  "perspective and co-holder rendering never mutate",
);
assert.match(
  wiki,
  /groupByMatchTier\(entities\.data\?\.items \?\? \[\], query\)/,
  "search results group by match tier",
);

assert.match(
  wiki,
  /<pre className="whitespace-pre-wrap[^"]*">\s*\{\(entity as \{ body\?: string \}\)\.body\}/,
  "entity notes render as preformatted text, never as HTML",
);
for (const key of [
  "ui.game.campaignWiki.campaignTimeline",
  "ui.game.campaignWiki.notes",
  "ui.game.campaignWiki.coHolders",
  "ui.game.campaignWiki.factLabel.disputed",
  "ui.game.campaignWiki.factLabel.legacy",
  "ui.game.campaignWiki.factLabel.pending",
  "ui.game.campaignWiki.factLabel.stale",
  "ui.game.campaignWiki.factLabel.verified",
  "ui.game.campaignWiki.matchTier.alias",
  "ui.game.campaignWiki.matchTier.id",
  "ui.game.campaignWiki.matchTier.prefix",
  "ui.game.campaignWiki.matchTier.text",
  "ui.game.campaignWiki.perspective.gm",
  "ui.game.campaignWiki.perspective.holder",
  "ui.game.campaignWiki.perspectiveNote",
  "ui.game.campaignWiki.timeline",
  "ui.game.campaignWiki.timelineEmpty",
  "ui.game.campaignWiki.timelineLoading",
  "ui.game.campaignWiki.timelineUnknownTime",
]) {
  assert.equal(typeof locale[key], "string", `missing localization key: ${key}`);
}
process.stdout.write("campaign-memory-wiki-reader-ui regression passed\n");
