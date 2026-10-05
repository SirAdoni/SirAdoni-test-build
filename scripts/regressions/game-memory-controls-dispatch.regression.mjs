import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const clientRequire = createRequire(new URL("../../packages/client/package.json", import.meta.url));
const { QueryClient } = clientRequire("@tanstack/react-query");
const { resolveFeatureEnabled } = await import("../../packages/shared/dist/index.js");
const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const keys = { all: ["features"] };
const hook = readFileSync(new URL("../../packages/client/src/hooks/use-feature-settings.ts", import.meta.url), "utf8");
const helper = hook.match(/export function isCampaignFeatureEnabled\([\s\S]*?^}/m)?.[0];
assert.ok(helper);
const compile = (source) =>
  ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
const enabled = new Function(
  "featureSettingsKeys",
  "resolveFeatureEnabled",
  `${compile(helper.replace("export ", ""))}; return isCampaignFeatureEnabled;`,
)(keys, resolveFeatureEnabled);
const source = readFileSync(
  new URL("../../packages/client/src/components/game/GameMemorySettings.tsx", import.meta.url),
  "utf8",
);
const parsed = ts.createSourceFile("GameMemorySettings.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const body = parsed.statements
  .filter((node) => !ts.isImportDeclaration(node))
  .map((node) => node.getText(parsed))
  .join("\n")
  .replace(/export /g, "");
const patches = [];
const render = new Function(
  "React",
  "useEffect",
  "useState",
  "useMutation",
  "useQueryClient",
  "useTranslation",
  "useFeatureEnabled",
  "useUpdateChatMetadata",
  "isCampaignFeatureEnabled",
  "api",
  "chatKeys",
  `${compile(body)}; return GameMemorySettings;`,
)(
  { createElement: (type, props, ...children) => ({ type, props, children }) },
  () => {},
  (value) => [value, () => {}],
  ({ mutationFn }) => ({ mutate: mutationFn, isPending: false }),
  () => qc,
  () => ({ t: (key) => key }),
  (name) => enabled(qc, name),
  () => ({ mutate: (patch) => patches.push(patch), isPending: false }),
  enabled,
  { patch: () => assert.fail("No ownership request expected") },
  { detail: (id) => ["chat", id] },
);
const props = {
  chatId: "synthetic",
  metadata: {},
  ownership: null,
  ownershipLoaded: false,
  onContinuityChanged: () => {},
};
const find = (node, label) => {
  if (!node || typeof node !== "object") return undefined;
  if (node.props?.["aria-label"] === label) return node;
  for (const child of [node.children ?? []].flat(3)) {
    const found = find(child, label);
    if (found) return found;
  }
};
try {
  assert.equal(render(props), null, "Missing flag hides controls");
  qc.setQueryData(keys.all, { settings: { gameMemoryControls: true } });
  const tree = render(props);
  const recaps = find(tree, "ui.game.memorySettings.recapsLabel");
  const scope = find(tree, "ui.game.memorySettings.scopeLabel");
  assert.ok(recaps && scope);
  recaps.props.onChange({ target: { value: "2" } });
  assert.deepEqual(patches.pop(), { id: "synthetic", gamePromptRecentSessionLimit: 2 });
  qc.setQueryData(keys.all, { settings: { gameMemoryControls: false } });
  recaps.props.onChange({ target: { value: "3" } });
  scope.props.onChange({ target: { value: "session" } });
  assert.equal(patches.length, 0, "Stale ON callbacks must not dispatch after OFF");
  qc.setQueryData(keys.all, { settings: { gameMemoryControls: true } });
  qc.getQueryCache()
    .find({ queryKey: keys.all })
    .setState({ status: "error", error: new Error("synthetic settings failure") });
  recaps.props.onChange({ target: { value: "5" } });
  assert.equal(patches.length, 0, "Retained ON cache with query error must not dispatch");
  qc.setQueryData(keys.all, { settings: { gameMemoryControls: true } });
  recaps.props.onChange({ target: { value: "" } });
  assert.deepEqual(patches.pop(), { id: "synthetic", gamePromptRecentSessionLimit: null });
  console.info("Actual Memory settings callbacks with real QueryClient OFF/ON/stale-OFF/error/re-enable PASS");
} finally {
  qc.clear();
}
