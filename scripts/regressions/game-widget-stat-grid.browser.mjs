// Stat block widgets lay label | value pairs out in as many columns as fit. A long value used to stay on one
// line and squeeze its label to one letter per line, then run past the panel edge and get cut off.
// Renders the real widget panel (desktop HUD and the phone widget tray) with long values at phone, tablet,
// laptop and desktop sizes and checks every pair: the label never breaks inside a word, the value wraps and
// stays inside the widget, and a pair with a long value spans the whole row. Obligations terms get the same check.
// Run from the repo root: node scripts/regressions/game-widget-stat-grid.browser.mjs
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { buildClientCss } from "../ui-fixtures/lib/build-client-css.mjs";

const english = JSON.parse(await fs.readFile(resolve("packages/client/src/localization/locales/en.json"), "utf8"));
const tempDirectory = await fs.mkdtemp(resolve(os.tmpdir(), "marinara-stat-grid-"));
const cssPath = resolve(tempDirectory, "client.css");
await buildClientCss(cssPath);
const css = await fs.readFile(cssPath, "utf8");
const game = (file) => resolve("packages/client/src/components/game", file).replaceAll("\\", "/");

const STATS = [
  { name: "Region", value: "Lower marsh district, far from the coast" },
  {
    name: "Cover",
    value:
      "Weathered, underfed local look (male baseline); fen work clothes; outer self-cleaning layer hidden under a patched coat",
  },
  { name: "Signal", value: "Carried behind sternum; untested" },
  { name: "Microdrones", value: 3 },
  { name: "Language", value: "Riverside dialect (fluent)" },
  { name: "Ambient Frequency Scan", value: "Natural only; no transmitters" },
  { name: "HP", value: 12 },
];

const fixture = `
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GamePanelContext } from '${game("FloatingGamePanel.tsx")}';
import { GameWidgetPanel, MobileWidgetPanel } from '${game("GameWidgetPanel.tsx")}';

const widgets = [
  { id: 'w-status', type: 'stat_block', label: 'Operative Status', icon: 'S', position: 'hud_right',
    config: { stats: ${JSON.stringify(STATS)} } },
  { id: 'w-debts', type: 'obligations', label: 'Debts', icon: 'D', position: 'hud_right',
    config: { tasks: [
      { text: 'Owe the broker | three thousand credits, payable at the next station before the customs inspection', done: false },
      { text: 'Promised safe passage | favour', done: true },
    ] } },
];

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

function Desktop() {
  const context = React.useContext(GamePanelContext);
  return <GameWidgetPanel widgets={widgets} position="hud_right" chatId="fixture-chat" constraintsRef={context.surface} />;
}

function Part({ part }) {
  if (part === 'desktop') return <Surface><Desktop /></Surface>;
  if (part === 'tray') return <div style={{ padding: 12 }}><MobileWidgetPanel widgets={widgets} position="hud_right" chatId="fixture-chat" layout="vertical" /></div>;
  return null;
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}><Part part={new URLSearchParams(location.search).get('part')} /></QueryClientProvider>,
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

// Runs in the page: measures every stat pair and obligations row.
function inspect() {
  const problems = [];
  // Words of the element's text that are split across lines (more than one line box).
  const brokenWords = (element) => {
    const broken = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      for (const match of text.matchAll(/\S+/g)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const lines = new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top)));
        if (lines.size > 1) broken.push(match[0]);
      }
    }
    return broken;
  };
  const rows = Array.from(document.querySelectorAll("[data-stat-row]"));
  for (const row of rows) {
    const [label, value] = row.children;
    const grid = row.parentElement.getBoundingClientRect();
    const name = label.textContent.trim();
    const broken = brokenWords(label);
    if (broken.length) problems.push(`label "${name}" breaks inside ${broken.join(", ")}`);
    const box = value.getBoundingClientRect();
    if (box.right > grid.right + 1 || box.left < grid.left - 1) problems.push(`value of "${name}" leaves the widget`);
    if (value.scrollWidth > value.clientWidth + 1) problems.push(`value of "${name}" overflows its box`);
    if (label.getBoundingClientRect().right > grid.right + 1) problems.push(`label "${name}" leaves the widget`);
    if (value.textContent.length > 60 && row.getBoundingClientRect().width < grid.width - 2)
      problems.push(`long value of "${name}" does not span the row`);
    for (let node = row.parentElement; node && node !== document.body; node = node.parentElement) {
      if (/(hidden|clip)/.test(getComputedStyle(node).overflowX) && node.getBoundingClientRect().right < box.right - 1)
        problems.push(`value of "${name}" is clipped by an ancestor`);
    }
  }
  const terms = Array.from(document.querySelectorAll("span")).filter(
    (span) => span.children.length === 0 && span.textContent.startsWith("three thousand credits"),
  );
  for (const span of terms) {
    const row = span.parentElement;
    if (row.children[1].getBoundingClientRect().width < 40) problems.push("obligations text squeezed by long terms");
    if (span.getBoundingClientRect().right > row.getBoundingClientRect().right + 1)
      problems.push("obligations terms leave the row");
  }
  return { rows: rows.length, terms: terms.length, problems };
}

const VIEWPORTS = [
  [390, 844],
  [820, 1180],
  [1024, 768],
  [1440, 900],
];
const shotDir = process.env.STAT_GRID_SCREENSHOT_DIR;
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
    // The desktop HUD panel shows from 1024px; the phone and tablet tray opens one widget at a time.
    const parts = [
      ...(width >= 1024 ? [{ name: "desktop", open: null, rows: STATS.length, terms: 1 }] : []),
      { name: "tray", open: "S", rows: STATS.length, terms: 0 },
      { name: "tray", open: "D", rows: 0, terms: 1 },
    ];
    for (const part of parts) {
      const label = `${width}x${height} ${part.name}${part.open ? ` ${part.open}` : ""}`;
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error.stack ?? error).slice(0, 600)));
      await page.goto(`http://fixture.test/?part=${part.name}`);
      await page.getByText(part.open ?? "Operative Status", { exact: true }).first().waitFor({ timeout: 15000 });
      if (part.open) await page.getByText(part.open, { exact: true }).first().click();
      await page.waitForTimeout(250);
      const state = await page.evaluate(inspect);
      if (shotDir)
        await page.screenshot({
          path: resolve(shotDir, `stat-grid-${width}-${part.name}${part.open ?? ""}.png`),
          fullPage: true,
        });
      if (errors.length) failures.push(`${label}: page error ${errors.join("; ")}`);
      if (state.rows !== part.rows) failures.push(`${label}: rendered ${state.rows} stat rows, expected ${part.rows}`);
      if (state.terms !== part.terms) failures.push(`${label}: rendered ${state.terms} obligations terms, expected ${part.terms}`);
      failures.push(...state.problems.map((problem) => `${label}: ${problem}`));
      await page.close();
    }
    await context.close();
  }
} finally {
  await browser.close();
  await fs.rm(tempDirectory, { recursive: true, force: true });
}
assert.deepEqual(failures, [], failures.join("\n"));
console.log("Stat block pairs keep whole-word labels, wrap long values inside the widget, and span the row when long.");
