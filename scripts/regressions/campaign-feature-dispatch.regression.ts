import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { resolveFeatureEnabled } from "../../packages/shared/src/schemas/feature-settings.schema.js";

const requireClient = createRequire(new URL("../../packages/client/package.json", import.meta.url));
const { QueryClient } = requireClient("@tanstack/react-query");
const source = readFileSync(
  new URL("../../packages/client/src/hooks/use-feature-settings.ts", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile("use-feature-settings.ts", source, ts.ScriptTarget.Latest, true);
const target = ast.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "isCampaignFeatureEnabled",
);
assert.ok(target, "actual dispatch permission helper must exist");
const code = ts.transpileModule(target.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const exports: { isCampaignFeatureEnabled?: (qc: unknown, name: string) => boolean } = {};
new Function("exports", "resolveFeatureEnabled", "featureSettingsKeys", code)(exports, resolveFeatureEnabled, {
  all: ["features"],
});
const enabled = exports.isCampaignFeatureEnabled!;
const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const names = ["gameContinuity", "campaignMemory", "campaignIndex"] as const;
try {
  for (const name of names) assert.equal(enabled(qc, name), false, `${name}: missing query is OFF`);
  const settings = { gameContinuity: true, campaignMemory: true, campaignIndex: true };
  const original = structuredClone(settings);
  qc.setQueryData(["features"], { settings, envOverrides: {}, effective: {} });
  for (const name of names) assert.equal(enabled(qc, name), true);
  const query = qc.getQueryCache().find({ queryKey: ["features"] });
  assert.ok(query);
  query.setState({ status: "error", error: new Error("synthetic settings failure") });
  for (const name of names) assert.equal(enabled(qc, name), false, `${name}: cached ON cannot survive query error`);
  query.setState({ status: "pending", error: null });
  for (const name of names) assert.equal(enabled(qc, name), false, `${name}: loading fails closed`);
  for (const disabled of names) {
    qc.setQueryData(["features"], { settings: { ...settings, [disabled]: false }, envOverrides: {}, effective: {} });
    for (const name of names) assert.equal(enabled(qc, name), name !== disabled, "switches remain independent");
  }
  qc.setQueryData(["features"], { settings, envOverrides: {}, effective: {} });
  for (const name of names) assert.equal(enabled(qc, name), true, "re-enable uses retained settings");
  assert.deepEqual(settings, original, "permission checks do not mutate saved settings");
} finally {
  qc.clear();
}
process.stdout.write("Actual Campaign feature dispatch helper missing/ON/OFF/error/pending/re-enable passed\n");

// Execute the actual provider-boundary function; disable during awaited connection lookup.
const structureSource = readFileSync(
  new URL("../../packages/server/src/services/game/continuity-structure.ts", import.meta.url),
  "utf8",
);
const structureAst = ts.createSourceFile("continuity-structure.ts", structureSource, ts.ScriptTarget.Latest, true);
const structureFunction = structureAst.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "completeStructure",
);
assert.ok(structureFunction);
const structureCode = ts.transpileModule(structureFunction.getText(structureAst), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const { applyFeatureSettingsValue } = await import("../../packages/server/src/services/features/feature-settings.js");
const { requireCampaignOptIn } = await import("../../packages/server/src/services/features/campaign-opt-in.js");
let calls = 0;
let disableDuringLookup: string | null = null;
const completeStructure = new Function(
  "readContinuityConfig",
  "createConnectionsStorage",
  "createLLMProvider",
  "resolveBaseUrl",
  "requireCampaignOptIn",
  "parseContinuityJson",
  "consumeBackgroundCallOrThrow",
  "normalizeContinuityError",
  `${structureCode}; return completeStructure;`,
)(
  async () => ({ frozen: { extractor: { connectionId: "synthetic" } }, stageTimeoutMs: { review: 1000 } }),
  () => ({
    getWithKey: async () => {
      await Promise.resolve();
      if (disableDuringLookup)
        applyFeatureSettingsValue(
          JSON.stringify({ gameContinuity: true, campaignMemory: true, [disableDuringLookup]: false }),
        );
      return { id: "synthetic", provider: "synthetic", model: "synthetic" };
    },
  }),
  () => ({
    chatComplete: async () => {
      calls++;
      return { content: "{}" };
    },
  }),
  () => "http://127.0.0.1/synthetic",
  requireCampaignOptIn,
  JSON.parse,
  () => {},
  (error: unknown) => error,
);
try {
  for (const disabled of ["gameContinuity", "campaignMemory"]) {
    applyFeatureSettingsValue(JSON.stringify({ gameContinuity: true, campaignMemory: true }));
    disableDuringLookup = disabled;
    await assert.rejects(completeStructure({}, "synthetic", "synthetic"), /FEATURE_DISABLED/);
    assert.equal(calls, 0, "late OFF must suppress provider dispatch after connection lookup");
  }
  disableDuringLookup = null;
  applyFeatureSettingsValue(JSON.stringify({ gameContinuity: true, campaignMemory: true }));
  await completeStructure({}, "synthetic", "synthetic");
  assert.equal(calls, 1, "explicit re-enable restores dispatch");
} finally {
  applyFeatureSettingsValue(null);
}
