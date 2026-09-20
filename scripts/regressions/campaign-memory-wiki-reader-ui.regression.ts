import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Static source checks for the Pulse 8 reader additions (timeline, co-holders, perspective, fact vocabulary,
// match tiers). Rendered behaviour is proven by the fetch-mocked fixture in .tmp/v3-execution/wiki-ui/run-timeline.mjs.
const wiki = readFileSync(
  new URL("../../packages/client/src/components/game/CampaignWiki.tsx", import.meta.url),
  "utf8",
);
const hooks = readFileSync(new URL("../../packages/client/src/hooks/use-campaign-memory.ts", import.meta.url), "utf8");
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
