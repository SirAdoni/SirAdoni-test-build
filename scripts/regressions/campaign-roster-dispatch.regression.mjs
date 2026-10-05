import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
const clientRequire = createRequire(new URL("../../packages/client/package.json", import.meta.url));
const { QueryClient } = clientRequire("@tanstack/react-query");
const { resolveFeatureEnabled } = await import("../../packages/shared/dist/index.js");
const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const invalidateQueries = qc.invalidateQueries.bind(qc);
const featureSettingsKeys = { all: ["features"] };
const source = readFileSync(
  new URL("../../packages/client/src/hooks/use-library-campaigns.ts", import.meta.url),
  "utf8",
);
const parsed = ts.createSourceFile("hooks.ts", source, ts.ScriptTarget.Latest, true);
const body = parsed.statements
  .filter((n) => !ts.isImportDeclaration(n) && !ts.isExportDeclaration(n))
  .map((n) => n.getText(parsed))
  .join("\n")
  .replace(/export /g, "");
const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const campaigns = [{ id: "campaign", characterIds: ["character"] }];
let query,
  gets = 0,
  posts = 0,
  invalidations = 0;
let getResult = async () => ({ campaigns });
qc.invalidateQueries = async () => {
  invalidations++;
};
const enabled = () =>
  qc.getQueryState(featureSettingsKeys.all)?.status === "success" &&
  resolveFeatureEnabled(qc.getQueryData(featureSettingsKeys.all)?.settings, "campaignRoster");
const hooks = new Function(
  "useMemo",
  "useMutation",
  "useQuery",
  "useQueryClient",
  "useFeatureEnabled",
  "featureSettingsKeys",
  "resolveFeatureEnabled",
  "api",
  "characterKeys",
  "lorebookKeys",
  "getCampaignItemIds",
  `${js}; return {useLibraryCampaigns,useCampaignMembership,useUpdateLibraryCampaignItems};`,
)(
  (fn) => fn(),
  (options) => options,
  (options) => {
    query = options;
    return { data: campaigns };
  },
  () => qc,
  enabled,
  featureSettingsKeys,
  resolveFeatureEnabled,
  {
    get: async () => {
      gets++;
      return getResult();
    },
    post: async () => {
      posts++;
    },
  },
  { list: () => ["characters"] },
  { list: () => ["lorebooks"] },
  (campaign) => campaign.characterIds,
);
const set = (on) => qc.setQueryData(featureSettingsKeys.all, { settings: { campaignRoster: on } });
const variables = { campaignId: "campaign", itemType: "character", itemIds: ["character"], action: "add" };
try {
  assert.equal(hooks.useLibraryCampaigns().data, undefined);
  assert.equal(query.enabled, false);
  await assert.rejects(query.queryFn(), /FEATURE_DISABLED:campaignRoster/);
  assert.equal(gets, 0);
  const mutation = hooks.useUpdateLibraryCampaignItems();
  await assert.rejects(mutation.mutationFn(variables), /FEATURE_DISABLED/);
  set(true);
  assert.deepEqual(hooks.useLibraryCampaigns().data, campaigns);
  assert.equal(query.enabled, true);
  assert.deepEqual(await query.queryFn(), campaigns);
  assert.equal(hooks.useCampaignMembership(campaigns, "character").get("character").length, 1);
  await mutation.mutationFn(variables);
  assert.equal(posts, 1);
  let release;
  getResult = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const inFlight = query.queryFn();
  set(false);
  release({ campaigns });
  assert.deepEqual(await inFlight, campaigns, "an admitted result is retained without displaying it while OFF");
  assert.equal(hooks.useLibraryCampaigns().data, undefined);
  assert.equal(hooks.useCampaignMembership(campaigns, "character").size, 0);
  await assert.rejects(mutation.mutationFn(variables), /FEATURE_DISABLED/);
  await mutation.onSuccess(undefined, variables);
  assert.ok(invalidations > 0, "an admitted successful mutation invalidates cache even after OFF");
  set(true);
  qc.getQueryCache()
    .find({ queryKey: featureSettingsKeys.all })
    .setState({ status: "error", error: new Error("synthetic") });
  await assert.rejects(mutation.mutationFn(variables), /FEATURE_DISABLED/);
  set(true);
  await mutation.mutationFn(variables);
  assert.equal(posts, 2);
  assert.deepEqual(campaigns, [{ id: "campaign", characterIds: ["character"] }]);
  // Exercise the captured production query through QueryClient, including its retryer.
  qc.invalidateQueries = invalidateQueries;
  hooks.useLibraryCampaigns();
  const key = query.queryKey;
  qc.setQueryData(key, campaigns);
  set(false);
  const getsBeforeCancel = gets;
  let attempts = 0;
  const cancelled = {
    ...query,
    staleTime: 0,
    retry: 2,
    retryDelay: 0,
    queryFn: () => {
      attempts++;
      return query.queryFn();
    },
  };
  await assert.rejects(qc.fetchQuery(cancelled), /FEATURE_DISABLED:campaignRoster/);
  assert.equal(gets, getsBeforeCancel, "OFF retries must never dispatch HTTP");
  assert.ok(attempts >= 1 && attempts <= 3);
  assert.deepEqual(qc.getQueryData(key), campaigns, "cancellation preserves the previous roster");
  assert.equal(qc.getQueryState(key).fetchStatus, "idle");
  qc.removeQueries({ queryKey: key });
  await assert.rejects(qc.fetchQuery(cancelled), /FEATURE_DISABLED:campaignRoster/);
  assert.equal(qc.getQueryData(key), undefined, "OFF must not cache an empty successful roster");
  set(true);
  let admit;
  getResult = () =>
    new Promise((resolve) => {
      admit = resolve;
    });
  const admitted = qc.fetchQuery({ ...query, staleTime: 0 });
  set(false);
  admit({ campaigns });
  assert.deepEqual(await admitted, campaigns);
  assert.deepEqual(qc.getQueryData(key), campaigns);
  assert.equal(hooks.useLibraryCampaigns().data, undefined);
  await mutation.onSuccess(undefined, variables);
  assert.equal(qc.getQueryState(key).isInvalidated, true);
  set(true);
  const freshCampaigns = [{ id: "campaign", characterIds: [] }];
  getResult = async () => ({ campaigns: freshCampaigns });
  assert.deepEqual(await qc.fetchQuery({ ...query, staleTime: 0 }), freshCampaigns);
  console.info("Actual roster hooks/current QueryClient missing/ON/OFF/late-result/error/re-enable PASS");
} finally {
  qc.clear();
}
