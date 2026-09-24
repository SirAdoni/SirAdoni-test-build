// Widget auto expand and a hand-set height: an Auto widget keeps a height the player set by hand, and an
// "Always expand" widget grows past it to show every entry (the hand-set height stays stored). Renders the
// real desktop HUD panel at 1024x768 and 1440x900 with a saved hand-set height of 120px.
// Run from the repo root: node scripts/regressions/widget-auto-expand-manual-height.browser.mjs
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { buildClientCss } from "../ui-fixtures/lib/build-client-css.mjs";

const english = JSON.parse(await fs.readFile(resolve("packages/client/src/localization/locales/en.json"), "utf8"));
const tempDirectory = await fs.mkdtemp(resolve(os.tmpdir(), "marinara-auto-expand-"));
const cssPath = resolve(tempDirectory, "client.css");
await buildClientCss(cssPath);
const css = await fs.readFile(cssPath, "utf8");
const game = (file) => resolve("packages/client/src/components/game", file).replaceAll("\\", "/");

const ENTRY_COUNT = 22;
const entries = (prefix) => Array.from({ length: ENTRY_COUNT }, (_, index) => `${prefix} ${index + 1}`);
const WIDGETS = [
  { id: "w-auto", type: "list", label: "Arrivals", icon: "A", position: "hud_right", config: { items: entries("Arrival") } },
  {
    id: "w-fixed",
    type: "list",
    label: "Roster",
    icon: "R",
    position: "hud_right",
    config: { items: entries("Roster"), autoExpand: "fixed" },
  },
  {
    id: "w-expand",
    type: "list",
    label: "Pinned",
    icon: "P",
    position: "hud_left",
    config: { items: entries("Pinned"), autoExpand: "expand" },
  },
  {
    id: "w-stats",
    type: "stat_block",
    label: "Status",
    icon: "S",
    position: "hud_left",
    config: {
      stats: [
        { name: "Cover", value: "Weathered local look; fen work clothes; outer layer hidden under a patched coat" },
        { name: "HP", value: 12 },
      ],
    },
  },
];

const fixture = `
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GamePanelContext } from '${game("FloatingGamePanel.tsx")}';
import { GameWidgetPanel, MobileWidgetPanel, WidgetAutoExpandContext } from '${game("GameWidgetPanel.tsx")}';

const params = new URLSearchParams(location.search);
const ids = (params.get('ids') ?? '').split(',');
const widgets = ${JSON.stringify(WIDGETS)}.filter((widget) => ids.includes(widget.id));

function Surface({ children }) {
  const surface = useRef(null);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return (
    <GamePanelContext.Provider value={{ chatId: 'fixture-chat', surface, layoutEditing: false }}>
      <section ref={surface} style={{ position: 'relative', height: '100vh', overflow: 'hidden', background: '#123' }}>
        {ready ? children : null}
      </section>
    </GamePanelContext.Provider>
  );
}

function Desktop({ position }) {
  const context = React.useContext(GamePanelContext);
  return <GameWidgetPanel widgets={widgets} position={position} chatId="fixture-chat" constraintsRef={context.surface} />;
}

function Part({ part }) {
  if (part === 'desktop') return <Surface><Desktop position="hud_left" /><Desktop position="hud_right" /></Surface>;
  return (
    <div style={{ padding: 12, display: 'flex', gap: 8 }}>
      <MobileWidgetPanel widgets={widgets} position="hud_left" chatId="fixture-chat" />
      <MobileWidgetPanel widgets={widgets} position="hud_right" chatId="fixture-chat" />
    </div>
  );
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}>
    <WidgetAutoExpandContext.Provider value={params.get('off') !== '1'}>
      <Part part={params.get('part')} />
    </WidgetAutoExpandContext.Provider>
  </QueryClientProvider>,
);
`;

const bundle = await build({
  stdin: { contents: fixture, loader: "tsx", resolveDir: process.cwd() },
  nodePaths: [resolve("packages/client/node_modules")],
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  logLevel: "error",
  loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".jpg": "dataurl" },
  // Resolve shared from source so the fixture always matches this checkout.
  alias: { "@marinara-engine/shared": resolve("packages/shared/src/index.ts") },
  define: { "import.meta.env": "{}", "import.meta.env.DEV": "false", "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "fixture-modules",
      setup(plugin) {
        plugin.onLoad({ filter: /locale-loader\.ts$/ }, async (args) => ({
          contents: (await fs.readFile(args.path, "utf8")).replace(
            "import.meta.glob<string>",
            "((..._args: unknown[]) => ({ './locales/en.json': async () => '' }))",
          ),
          loader: "ts",
        }));
        plugin.onResolve({ filter: /^react-i18next$/ }, () => ({ path: "translation", namespace: "fixture" }));
        plugin.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: `const MAP=${JSON.stringify(english)};const i18n={language:'en',resolvedLanguage:'en',dir:()=>'ltr',t:(key)=>MAP[key]??key};export const initReactI18next={type:'3rdParty',init(){}};export const useTranslation=()=>({i18n,t:(key,values)=>{let value=MAP[key]??key;for(const[name,replacement]of Object.entries(values??{}))value=value.replaceAll(\`{{\${name}}}\`,String(replacement));return value;}});export const Trans=({children})=>children;`,
          loader: "js",
        }));
      },
    },
  ],
});
const script = bundle.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body style="margin:0;background:#101216"><div id="root"></div><script src="/bundle.js"></script></body></html>`;

// Runs in the page: the list's panel height and whether all entries are visible without an inner scroll.
function inspect(prefix) {
  const list = Array.from(document.querySelectorAll("[data-widget-list]")).find((element) =>
    element.textContent.includes(`${prefix} 1`),
  );
  if (!list) return { found: false };
  let panel = list;
  let scroller = null;
  for (let node = list; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (!scroller && /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) scroller = node;
    if (style.position === "absolute" || style.position === "fixed") {
      panel = node;
      break;
    }
  }
  return { found: true, panelHeight: Math.round(panel.getBoundingClientRect().height), scrolls: Boolean(scroller) };
}

const HAND_SET_HEIGHT = 120;
// [case, widget id, list entry prefix, expected to grow past the hand-set height]
const CASES = [
  ["Auto keeps the hand-set height", "w-auto", "Arrival", false],
  ["Always expand grows past it", "w-expand", "Pinned", true],
];
const VIEWPORTS = [
  [1024, 768],
  [1440, 900],
];
const browser = await chromium.launch({ headless: true });
const failures = [];
try {
  for (const [width, height] of VIEWPORTS) {
    for (const [name, id, prefix, grows] of CASES) {
      const label = `${width}x${height} ${name}`;
      const context = await browser.newContext({ viewport: { width, height } });
      await context.route("http://fixture.test/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: html });
        if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: script });
        return route.fulfill({ json: [] });
      });
      // What a hand resize stores: the height, a fixed growth mode and the explicit-choice flag.
      await context.addInitScript(
        ({ key, size }) => {
          localStorage.setItem(key, JSON.stringify(size));
          localStorage.setItem(`${key}:growth`, "fixed");
          localStorage.setItem(`${key}:growth-explicit`, "true");
        },
        {
          key: `marinara-game-panel:fixture-chat:floating:widget:${id}:size-v2`,
          size: { width: 220, height: HAND_SET_HEIGHT },
        },
      );
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error.stack ?? error).slice(0, 600)));
      // The game default is on; w-expand is "Always expand", w-auto follows the game.
      await page.goto(`http://fixture.test/?part=desktop&ids=${id}`);
      await page
        .getByText(`${prefix} 1`, { exact: true })
        .first()
        .waitFor({ state: "attached", timeout: 15000 })
        .catch(() => {});
      await page.waitForTimeout(300);
      const state = await page.evaluate(inspect, prefix);
      if (errors.length) failures.push(`${label}: page error ${errors.join("; ")}`);
      if (!state.found) failures.push(`${label}: list widget did not render`);
      else if (grows) {
        if (state.panelHeight <= HAND_SET_HEIGHT + 40)
          failures.push(`${label}: panel stayed near the hand-set height (${state.panelHeight}px)`);
        if (state.scrolls) failures.push(`${label}: entries still scroll inside the panel`);
      } else if (Math.abs(state.panelHeight - HAND_SET_HEIGHT) > 2) {
        failures.push(`${label}: hand-set height not kept (${state.panelHeight}px)`);
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  await fs.rm(tempDirectory, { recursive: true, force: true });
}
assert.deepEqual(failures, [], failures.join("\n"));
console.log("Auto expand: Auto widgets keep a hand-set height, Always expand widgets grow past it.");
