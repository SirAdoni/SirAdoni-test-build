import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(here, "../../packages/client");
const panelPath = join(clientRoot, "src/components/game/GameContinuityPanel.tsx");
const panelSource = readFileSync(panelPath, "utf8");
const english = JSON.parse(readFileSync(join(clientRoot, "src/localization/locales/en.json"), "utf8")) as Record<
  string,
  any
>;
const reactRequire = createRequire(join(clientRoot, "package.json"));
const React = reactRequire("react");
const renderToStaticMarkup = reactRequire("react-dom/server").renderToStaticMarkup;

function translation(key: string, fallback: unknown, options: Record<string, unknown>): string {
  const value = english[key];
  let result = String(value ?? fallback ?? key);
  for (const [name, replacement] of Object.entries(options)) {
    if (name !== "defaultValue" && typeof replacement !== "object" && replacement !== undefined) {
      result = result.replaceAll("{{" + name + "}}", String(replacement));
    }
  }
  return result;
}

const mockModules: Record<string, string> = {
  tanstack: `
    export function useQuery() {
      const index = globalThis.__panelQueryIndex++;
      return index === 0
        ? { data: globalThis.__panelStatus, isPending: globalThis.__panelLoading, isError: false }
        : { data: undefined, isLoading: false, isError: false };
    }
    export function useMutation() { return { mutate() {}, mutateAsync: async () => undefined, isPending: false }; }
    export function useQueryClient() { return { invalidateQueries() {} }; }
  `,
  i18n: `
    export function useTranslation() {
      return { i18n: { language: "en" }, t(key, options = {}) {
        return globalThis.__panelTranslate(key, options.defaultValue, options);
      }};
    }
  `,
  api: "export const api = {};",
  dialogs: "export function showConfirmDialog() {}",
  utils: "export function cn(...values) { return values.filter(Boolean).join(' '); }",
  connections: "export function useConnections() { return { data: [], isLoading: false }; }",
  chats: "export const chatKeys = { detail: (id) => ['chat', id] };",
  wiki: "export function WikiChip({ children }) { return children; } export const factKindTone = {};",
  settings: "export function GameMemorySettings() { return null; }",
};

const lucideImports = [...panelSource.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']lucide-react["']/gu)]
  .flatMap((match) => match[1]!.split(","))
  .map((name) => name.trim().split(/\s+as\s+/u)[0]!)
  .filter(Boolean);
const lucideMock = [...new Set(lucideImports)].map((name) => `export const ${name} = () => null;`).join("\n");

const bundle = await build({
  stdin: { contents: panelSource, resolveDir: dirname(panelPath), sourcefile: panelPath, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  plugins: [
    {
      name: "panel-test-mocks",
      setup(plugin) {
        plugin.onResolve({ filter: /.*/ }, (args) => {
          if (["react", "react/jsx-runtime", "react-dom/server"].includes(args.path)) {
            return { path: args.path, external: true };
          }
          if (args.path === "lucide-react") return { path: "lucide", namespace: "panel-mock" };
          if (args.path === "@tanstack/react-query") return { path: "tanstack", namespace: "panel-mock" };
          if (args.path === "react-i18next") return { path: "i18n", namespace: "panel-mock" };
          if (args.path.startsWith(".") || args.path.startsWith("@/")) {
            const key = args.path.endsWith("app-dialogs")
              ? "dialogs"
              : args.path.endsWith("api-client")
                ? "api"
                : args.path.endsWith("/utils")
                  ? "utils"
                  : args.path.endsWith("use-connections")
                    ? "connections"
                    : args.path.endsWith("use-chats")
                      ? "chats"
                      : args.path.endsWith("campaign-wiki-ui")
                        ? "wiki"
                        : args.path.endsWith("GameMemorySettings")
                          ? "settings"
                          : null;
            assert.ok(key, `unexpected panel dependency ${args.path}`);
            return { path: key!, namespace: "panel-mock" };
          }
          return { path: args.path, external: true };
        });
        plugin.onLoad({ filter: /.*/, namespace: "panel-mock" }, (args) => ({
          contents: args.path === "lucide" ? lucideMock : mockModules[args.path]!,
          loader: "js",
        }));
      },
    },
  ],
});

const outputModule = { exports: {} as Record<string, unknown> };
const elements: any[] = [];
const stateWrites: unknown[] = [];
const runtime = reactRequire("react/jsx-runtime");
function testRequire(name: string) {
  if (name === "react")
    return {
      ...React,
      useState(initial: unknown) {
        const [value, setValue] = React.useState(initial);
        return [
          value,
          (next: unknown) => {
            stateWrites.push(next);
            setValue(next);
          },
        ];
      },
    };
  if (name === "react/jsx-runtime") return { ...runtime, jsx: capture(runtime.jsx), jsxs: capture(runtime.jsxs) };
  return reactRequire(name);
}
function capture(factory: (...args: any[]) => any) {
  return (...args: any[]) => {
    const element = factory(...args);
    elements.push(element);
    return element;
  };
}
new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(
  testRequire,
  outputModule,
  outputModule.exports,
);
const { GameContinuityPanel } = outputModule.exports as {
  GameContinuityPanel: (props: { chatId: string; metadata: unknown }) => any;
};

function render(status: unknown, mode = "active", loading = false): string {
  elements.length = 0;
  stateWrites.length = 0;
  (globalThis as any).__panelStatus = status;
  (globalThis as any).__panelLoading = loading;
  (globalThis as any).__panelQueryIndex = 0;
  (globalThis as any).__panelTranslate = translation;
  return renderToStaticMarkup(
    React.createElement(GameContinuityPanel, {
      chatId: "render-proof-chat",
      metadata: { gameContinuity: { mode, extractionInstructions: "extract", verificationInstructions: "verify" } },
    }),
  );
}

const batches = Array.from({ length: 6 }, (_, index) => ({
  id: `batch-${index + 1}`,
  status: "published",
  messageId: `message-${index + 1}`,
}));
const base = {
  connectionAvailable: true,
  counts: { published: 6 },
  batches,
  gaps: [
    {
      status: "published",
      reason: "CONTINUITY_REVIEW_WITHHELD",
      batchId: "batch-6",
      messageId: "message-6",
      message: "A secret personal fact was withheld from memory.",
    },
  ],
  verifiedThroughMessageId: null,
};

const withheld = render(base);
assert.match(withheld, /data-health="attention"/u, "a withheld fact changes header health");
assert.match(withheld, /Memory needs attention/u);
const coverage = elements.find((element) => element.props["data-component"] === "GameContinuityPanel.Gaps");
const showProblems = elements.find(
  (element) => element.type === "button" && element.props.children === "Show problems",
);
assert.ok(coverage && showProblems);
const calls: string[] = [];
coverage.props.ref.current = { focus: () => calls.push("focus"), scrollIntoView: () => calls.push("scroll") };
showProblems.props.onClick();
assert.deepEqual(calls, ["focus", "scroll"]);
assert.deepEqual(stateWrites, [], "coverage-only action must not open an empty failed-batch filter");
assert.doesNotMatch(
  withheld,
  /Every turn checked|All turns checked|Recorded batches checked/u,
  "published batch totals cannot claim full-turn review",
);
assert.match(withheld, /6 of 6 memory batches checked/u, "shows the batch-check count precisely");
assert.match(
  withheld,
  /Some proposed facts were withheld during review\. Accepted facts remain available\./u,
  "explains withheld facts while confirming accepted facts remain available",
);
assert.match(
  withheld,
  /Continuous checked coverage has not been established yet\./u,
  "describes the absent coverage watermark",
);
assert.doesNotMatch(withheld, /A secret personal fact was withheld/u, "does not disclose the withheld fact");

const clean = render({ ...base, gaps: [], verifiedThroughMessageId: "message-6" });
assert.match(clean, /Recorded batches checked/u, "clean full coverage can show the checked state");
assert.match(
  clean,
  /Continuous checked coverage reaches the recorded turn\./u,
  "shows the verified coverage watermark",
);

const laterGap = render({
  ...base,
  gaps: [{ status: "published", reason: "CONTINUITY_REVIEW_WITHHELD", batchId: "batch-6", messageId: "message-6" }],
  verifiedThroughMessageId: "message-5",
});
assert.match(laterGap, /data-health="attention"/u, "a later gap stays visible after an earlier watermark");

const pending = render({
  ...base,
  counts: { published: 5, queued: 1 },
  batches: [...batches.slice(0, 5), { id: "batch-6", status: "queued", messageId: "message-6" }],
  gaps: [],
  verifiedThroughMessageId: null,
});
assert.match(pending, /catching up|being checked|checking memory/iu, "pending work remains a normal catching-up state");

const missingMessageGap = render({
  ...base,
  gaps: [{ status: "published", reason: "CONTINUITY_PUBLICATION_INVALID", batchId: "batch-6" }],
  verifiedThroughMessageId: null,
});
assert.match(
  missingMessageGap,
  /data-health="attention"/u,
  "a published turn without a valid receipt creates attention",
);

assert.match(render(base, "off"), /Memory is off/u, "off mode keeps its existing priority");
assert.match(render(base, "active", true), /Checking memory/u, "loading keeps its existing priority");
assert.match(
  render({ ...base, connectionAvailable: false }),
  /Paused: no memory connection/u,
  "connection failure keeps its existing priority",
);
const blocked = (errorCode: string) => ({
  ...base,
  counts: { published: 5, queued: 1 },
  batches: [...batches.slice(0, 5), { id: "batch-6", status: "queued", errorCode }],
});
assert.match(
  render(blocked("PROVIDER_AUTH")),
  /Paused: API key rejected/u,
  "credential failure keeps its existing priority",
);
assert.match(
  render(blocked("PROVIDER_LIMITED")),
  /Paused: usage limit reached/u,
  "usage limit keeps its existing priority",
);
assert.match(
  render(blocked("BACKGROUND_BUDGET")),
  /Paused: hourly call cap reached/u,
  "hourly cap keeps its existing priority",
);

assert.match(render({ ...base, counts: {}, batches: [], gaps: [] }), /data-health="empty"/u);
render({ ...base, counts: { failed: 1 }, batches: [{ id: "failed", status: "failed" }] });
elements.find((element) => element.type === "button" && element.props.children === "Show problems").props.onClick();
assert.equal(stateWrites[0], "attention", "ordinary failed batches retain attention filtering");
assert.equal(stateWrites.at(-1), true, "ordinary failed batches open the list");
console.log("game continuity panel coverage regression passed (SSR and captured callback, not browser click)");
