import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
const requireClient = createRequire(new URL("../../packages/client/package.json", import.meta.url));
const { QueryClient } = requireClient("@tanstack/react-query");
const { resolveFeatureEnabled, FEATURE_SETTINGS_KEY } = await import("../../packages/shared/dist/index.js");
const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
function body(path) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const parsed = ts.createSourceFile("hook.ts", source, ts.ScriptTarget.Latest, true);
  return ts.transpileModule(
    parsed.statements
      .filter((n) => !ts.isImportDeclaration(n) && !ts.isExportDeclaration(n))
      .map((n) => n.getText(parsed))
      .join("\n")
      .replace(/export /g, ""),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
}
const feature = new Function(
  "FEATURE_SETTINGS_KEY",
  "resolveFeatureEnabled",
  `${body("../../packages/client/src/hooks/use-feature-settings.ts")}; return {isCampaignFeatureEnabled,featureSettingsKeys};`,
)(FEATURE_SETTINGS_KEY, resolveFeatureEnabled);
const enabled = () => feature.isCampaignFeatureEnabled(qc, "sceneTimeline");
const scenes = { scenes: [{ id: "retained-scene" }], pending: false, remaining: 0 };
let query,
  gets = 0,
  posts = 0,
  invalidations = 0,
  effect;
let response = async () => scenes;
const currentChat = { current: null };
qc.invalidateQueries = async () => {
  invalidations++;
};
const useSceneTimeline = new Function(
  "useEffect",
  "useRef",
  "useQuery",
  "useMutation",
  "useQueryClient",
  "useFeatureEnabled",
  "isCampaignFeatureEnabled",
  "api",
  `${body("../../packages/client/src/hooks/use-scene-timeline.ts")}; return useSceneTimeline;`,
)(
  (fn) => {
    effect = fn;
  },
  () => currentChat,
  (options) => {
    query = options;
    return { data: scenes };
  },
  (options) => ({
    ...options,
    mutate: () => {
      throw new Error("unexpected auto-sync");
    },
  }),
  () => qc,
  enabled,
  feature.isCampaignFeatureEnabled,
  {
    get: async () => {
      gets++;
      return response();
    },
    post: async () => {
      posts++;
    },
  },
);
const set = (value) => qc.setQueryData(feature.featureSettingsKeys.all, { settings: { sceneTimeline: value } });
const surface = readFileSync(
  new URL("../../packages/client/src/components/game/GameSurface.tsx", import.meta.url),
  "utf8",
);
const presenceExpression = surface.match(
  /const scenePresentNames = useMemo\(\s*\(\) =>([\s\S]*?),\s*\[gameSnapshot\?\.presentCharacters/,
)[1];
const presence = new Function(
  "sceneTimelineEnabled",
  "sceneTimeline",
  "gameSnapshot",
  `return (${presenceExpression});`,
);
assert.deepEqual(presence(true, {}, { presentCharacters: [{ name: "Mara" }] }), ["Mara"]);
assert.deepEqual(presence(true, { data: { scenes: [] } }, { presentCharacters: [{ name: "Mara" }] }), ["Mara"]);
assert.deepEqual(
  presence(true, { data: { scenes: [{ present: [] }] } }, { presentCharacters: [{ name: "Mara" }] }),
  [],
);
assert.deepEqual(
  presence(false, { data: { scenes: [{ present: ["Lyra"] }] } }, { presentCharacters: [{ name: "Mara" }] }),
  ["Mara"],
);
try {
  let hook = useSceneTimeline("chat");
  assert.equal(query.enabled, false);
  assert.equal(hook.data, undefined);
  await assert.rejects(query.queryFn(), /disabled/);
  await assert.rejects(async () => hook.sync.mutationFn(), /disabled/);
  assert.equal(gets + posts, 0);
  set(true);
  hook = useSceneTimeline("chat");
  const stale = hook.sync;
  assert.equal(query.enabled, true);
  assert.deepEqual(await query.queryFn(), scenes);
  await stale.mutationFn();
  assert.equal(posts, 1);
  let release;
  response = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = query.queryFn();
  set(false);
  release(scenes);
  await assert.rejects(pending, /disabled/);
  assert.equal(query.refetchInterval({ state: { data: scenes } }), false);
  await assert.rejects(async () => stale.mutationFn(), /disabled/);
  stale.onSuccess();
  assert.equal(invalidations, 0);
  assert.equal(useSceneTimeline("chat").data, undefined);
  set(true);
  qc.getQueryCache()
    .find({ queryKey: feature.featureSettingsKeys.all })
    .setState({ status: "error", error: new Error("synthetic") });
  await assert.rejects(async () => stale.mutationFn(), /disabled/);
  set(true);
  hook = useSceneTimeline("chat");
  assert.deepEqual(hook.data, scenes);
  useSceneTimeline(null);
  await assert.rejects(async () => hook.sync.mutationFn(), /disabled/);
  hook = useSceneTimeline("chat");
  await hook.sync.mutationFn();
  assert.equal(posts, 2);
  const key = ["game-scene-timeline", "chat"];
  qc.setQueryData(key, scenes);
  useSceneTimeline("chat");
  const queryPromise = qc.fetchQuery({ queryKey: key, queryFn: query.queryFn, staleTime: 0 });
  useSceneTimeline("other-chat");
  release({ scenes: [{ id: "stale-result" }] });
  await assert.rejects(queryPromise, /disabled/);
  assert.deepEqual(qc.getQueryData(key), scenes, "late chat-switch GET preserves existing cache");
  hook = useSceneTimeline("chat");
  assert.deepEqual(hook.data, scenes);
  effect();
  assert.deepEqual(scenes.scenes, [{ id: "retained-scene" }]);
  console.info(
    "Actual timeline hooks and current QueryClient missing/ON/OFF/late-result/error/chat-change/re-enable PASS",
  );
} finally {
  qc.clear();
}
