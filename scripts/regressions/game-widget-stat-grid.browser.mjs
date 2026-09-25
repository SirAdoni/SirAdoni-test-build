// Stat block widgets are one aligned label/value table. A long value used to stay on one line and squeeze its
// label to one letter per line, then run past the panel edge; a later layout mixed full-row and half-width pairs,
// so value edges were ragged. Renders the real widget panel (desktop HUD, also at a hand-set 540px width, and
// the phone widget tray) at phone, tablet, laptop and desktop sizes and checks every pair: the label never
// breaks inside a word, values are left-aligned in one column shared by every row (per side-by-side table)
// and wrap inside the widget, the label column is at most 40% unless a single word needs more, and only an
// all-short block may split into two tables. Obligations terms get the squeeze check.
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
  { id: 'w-short', type: 'stat_block', label: 'Ship Systems', icon: 'Y', position: 'hud_right',
    config: { stats: [
      { name: 'Shields', value: 'Online' }, { name: 'Sensors', value: 3 },
      { name: 'Jump Drive', value: 'Charging' }, { name: 'Hull', value: '82%' },
    ] } },
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
    if (getComputedStyle(value).textAlign === "right") problems.push(`value of "${name}" is right-aligned`);
    for (let node = row.parentElement; node && node !== document.body; node = node.parentElement) {
      if (/(hidden|clip)/.test(getComputedStyle(node).overflowX) && node.getBoundingClientRect().right < box.right - 1)
        problems.push(`value of "${name}" is clipped by an ancestor`);
    }
  }
  // Table alignment: per table, rows fall into one or two column groups; within a group every label starts at
  // the same x and every value starts at the same x. A block with a long value is one single table.
  for (const table of document.querySelectorAll("[data-stat-table]")) {
    const tableRows = Array.from(table.querySelectorAll("[data-stat-row]"));
    const groups = new Map();
    for (const row of tableRows) {
      const left = Math.round(row.getBoundingClientRect().left);
      groups.set(left, [...(groups.get(left) ?? []), row]);
    }
    const long = tableRows.some((row) => row.children[1].textContent.length > 12);
    if (long && (table.dataset.statTable !== "single" || groups.size !== 1))
      problems.push(`a block with long values is not one single table (${table.dataset.statTable}, ${groups.size} groups)`);
    if (groups.size > 2) problems.push(`stat table has ${groups.size} column groups`);
    const width = table.getBoundingClientRect().width;
    for (const rowsInGroup of groups.values()) {
      const valueLefts = new Set(rowsInGroup.map((row) => Math.round(row.children[1].getBoundingClientRect().left)));
      if (valueLefts.size !== 1) problems.push(`values do not share one column edge (${[...valueLefts].join(", ")})`);
      const labelWidth = Math.max(...rowsInGroup.map((row) => row.children[0].getBoundingClientRect().width));
      const longestWord = Math.max(
        ...rowsInGroup.map((row) => {
          const probe = document.createElement("span");
          probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap";
          probe.className = row.children[0].className;
          probe.textContent = row.children[0].textContent
            .split(/\s+/)
            .reduce((a, b) => (b.length > a.length ? b : a), "");
          row.appendChild(probe);
          const measured = probe.getBoundingClientRect().width;
          probe.remove();
          return measured;
        }),
      );
      if (labelWidth > Math.max(width * 0.4, longestWord) + 2)
        problems.push(`label column is ${Math.round(labelWidth)}px of ${Math.round(width)}px`);
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
      ...(width >= 1024
        ? [
            { name: "desktop", open: null, rows: STATS.length + 4, terms: 1 },
            { name: "desktop", open: null, rows: STATS.length + 4, terms: 1, handWidth: 540 },
          ]
        : []),
      { name: "tray", open: "S", rows: STATS.length, terms: 0 },
      { name: "tray", open: "Y", rows: 4, terms: 0 },
      { name: "tray", open: "D", rows: 0, terms: 1 },
    ];
    for (const part of parts) {
      const label = `${width}x${height} ${part.name}${part.open ? ` ${part.open}` : ""}${part.handWidth ? ` at ${part.handWidth}px` : ""}`;
      // A width set by hand in Edit layout, as in the reported screenshot.
      if (part.handWidth)
        await context.addInitScript((handWidth) => {
          for (const id of ["w-status", "w-short"])
            localStorage.setItem(
              `marinara-game-panel:fixture-chat:floating:widget:${id}:size-v2`,
              JSON.stringify({ width: handWidth, manualWidth: true }),
            );
        }, part.handWidth);
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
          path: resolve(shotDir, `stat-grid-${width}-${part.name}${part.open ?? ""}${part.handWidth ?? ""}.png`),
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
console.log("Stat blocks are aligned label/value tables: whole-word labels, one left-aligned value column, nothing clipped.");
