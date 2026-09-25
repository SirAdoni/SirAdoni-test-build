// Widget auto expand: a list widget that auto expands shows every entry with no inner scroll box, and one that
// keeps the fixed size limits scrolls inside a 16rem box as before. Renders the real desktop HUD panel and the
// phone and tablet widget tray at 390x844, 1024x768 and 1440x900, with the game default on and off and with
// per-widget Auto, Always expand and Fixed size. A long stat widget must stay fully visible too.
// Run from the repo root: node scripts/regressions/widget-auto-expand.browser.mjs
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

// Runs in the page: how the list with this entry prefix renders, and whether stat rows are fully visible.
function inspect(prefix) {
  const list = Array.from(document.querySelectorAll("[data-widget-list]")).find((element) =>
    element.textContent.includes(`${prefix} 1`),
  );
  const hiddenStats = Array.from(document.querySelectorAll("[data-stat-row]")).filter((row) => {
    const box = row.getBoundingClientRect();
    return box.width === 0 || box.right > window.innerWidth + 1;
  }).length;
  if (!list) return { found: false, hiddenStats };
  const style = getComputedStyle(list);
  return {
    found: true,
    entries: list.children.length,
    scrolls: list.scrollHeight > list.clientHeight + 1,
    overflowY: style.overflowY,
    maxHeight: style.maxHeight,
    hiddenStats,
  };
}

// [case, query, widget ids, list entry prefix, tray icon to open, expected to expand]
const CASES = [
  ["game on, widget Auto", "", ["w-auto", "w-stats"], "Arrival", "A", true],
  ["game on, widget Fixed size", "", ["w-fixed"], "Roster", "R", false],
  ["game off, widget Auto", "&off=1", ["w-auto", "w-stats"], "Arrival", "A", false],
  ["game off, widget Always expand", "&off=1", ["w-expand"], "Pinned", "P", true],
];
const VIEWPORTS = [
  [390, 844],
  [1024, 768],
  [1440, 900],
];
const shotDir = process.env.AUTO_EXPAND_SCREENSHOT_DIR;
const browser = await chromium.launch({ headless: true });
const failures = [];
try {
  for (const [width, height] of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 1024 });
    await context.route("http://fixture.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: html });
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: script });
      return route.fulfill({ json: [] });
    });
    for (const [name, query, ids, prefix, icon, expanded] of CASES) {
      // The desktop HUD panel shows from 1024px; the tray opens one widget at a time.
      for (const part of width >= 1024 ? ["desktop", "tray"] : ["tray"]) {
        const label = `${width}x${height} ${part} ${name}`;
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error.stack ?? error).slice(0, 600)));
        await page.goto(`http://fixture.test/?part=${part}&ids=${ids.join(",")}${query}`);
        if (part === "tray") await page.getByText(icon, { exact: true }).first().click({ timeout: 15000 });
        await page
          .getByText(`${prefix} 1`, { exact: true })
          .first()
          .waitFor({ state: "attached", timeout: 15000 })
          .catch(() => {});
        await page.waitForTimeout(200);
        const state = await page.evaluate(inspect, prefix);
        if (shotDir)
          await page.screenshot({
            path: resolve(shotDir, `auto-expand-${width}-${part}-${prefix}${query ? "-off" : ""}.png`),
            fullPage: true,
          });
        if (errors.length) failures.push(`${label}: page error ${errors.join("; ")}`);
        if (!state.found) {
          failures.push(`${label}: list widget did not render`);
        } else if (expanded) {
          if (state.scrolls || state.overflowY !== "visible")
            failures.push(`${label}: expanded list still scrolls inside (${state.overflowY}, ${state.maxHeight})`);
          if (state.entries !== ENTRY_COUNT)
            failures.push(`${label}: expanded list shows ${state.entries} of ${ENTRY_COUNT} entries`);
        } else if (!state.scrolls || state.maxHeight !== "256px") {
          failures.push(`${label}: fixed-size list lost its 16rem scroll box (${state.overflowY}, ${state.maxHeight})`);
        }
        if (state.hiddenStats) failures.push(`${label}: ${state.hiddenStats} stat rows hidden or off screen`);
        await page.close();
      }
    }
    await context.close();
  }
} finally {
  await browser.close();
  await fs.rm(tempDirectory, { recursive: true, force: true });
}
assert.deepEqual(failures, [], failures.join("\n"));
console.log("Auto expand: expanding lists show every entry, fixed-size lists keep their scroll box, on desktop and in the tray.");
