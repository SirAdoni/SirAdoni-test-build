// Game HUD full names: a map place, region or location name, and every other HUD name (widget titles and
// entries, contact book, inventory, journal, character sheet, storyboard title), must be readable in full.
// Long invented names render in the real components at phone, tablet, landscape-phone and desktop sizes.
// For every text node holding a fixture name: no ellipsis, no line clamp, the name element does not
// overflow sideways, and no clipping ancestor cuts the text off (a scroll container may, since the name
// stays reachable by scrolling).
// Run from the repo root: node scripts/regressions/game-hud-full-names.browser.mjs
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { buildClientCss } from "../ui-fixtures/lib/build-client-css.mjs";
import { layoutNodeLabel, wrapNodeLabel } from "../../packages/client/src/components/game/game-node-map-label.ts";

const TOKEN = "Qzv";
const NAMES = {
  map: `${TOKEN} Ostrevanthelmquadrisbergenhollowmarch Fastness of the Sevenfold Glimmering Tides`,
  here: `${TOKEN} Underhallowdeepcavernsofthewhisperingstone Landing`,
  there: `${TOKEN} Grandamberlightcathedralofthefallenlanterns Nave`,
  region: `${TOKEN} Northernmostfrostwindhighlandsprovince Reach`,
  town: `${TOKEN} Kelderwynnthornhalloway Township`,
  place: `${TOKEN} Silvermoonbrewedlanternglowtavernhouse Commons`,
  widget: `${TOKEN} Expeditionarysupplyquartermasterledger Register`,
  stat: `${TOKEN} Stubbornunyieldingironwillfortitude`,
  gridItem: `${TOKEN} Everburningcrystallinedragonheartlantern`,
  listItem: `${TOKEN} Ropeofwovenmoonlitspidersilkandbrass Coil`,
  contact: `${TOKEN} Maribellanorthwindeversongthistledown Ashgrove`,
  item: `${TOKEN} Longforgottenstarmetalcompassofthewestern Wardens`,
  entry: `${TOKEN} Arrivalatthesunkenobservatoryofthetwinmoons Chapter`,
  npc: `${TOKEN} Theodorabellawinterbournequicksilver Fairweather`,
  sheet: `${TOKEN} Seraphinaevangelinemoonwhisperstarling Vale`,
  storyboard: `${TOKEN} Theprocessionbeneaththeamberlanternsofthecity Scene`,
};

// Pure check of the node map label helpers first: nothing is dropped and no line runs long.
for (const label of [NAMES.here, NAMES.there, "Short", "A b c", "x".repeat(50)]) {
  const lines = wrapNodeLabel(label);
  assert.equal(
    lines.join("").replace(/\s/g, ""),
    label.replace(/\s/g, ""),
    `node label keeps every character: ${label}`,
  );
  assert.ok(
    lines.every((line) => Array.from(line).length <= 14),
    `node label lines fit: ${lines.join(" | ")}`,
  );
}
{
  const view = { minX: 0, minY: 0, width: 200, height: 200 };
  const top = layoutNodeLabel({ x: 2, y: 10 }, 4, 1, view);
  assert.ok(top.y >= view.minY, "a grown label near the top edge flips below the node");
  assert.ok(top.x >= view.minX && top.x + top.width <= view.minX + view.width, "label stays inside the view");
  const mid = layoutNodeLabel({ x: 100, y: 150 }, 3, 1, view);
  assert.ok(mid.y + mid.height <= 150, "label sits above the node when there is room");
}

const english = JSON.parse(await fs.readFile(resolve("packages/client/src/localization/locales/en.json"), "utf8"));
const tempDirectory = await fs.mkdtemp(resolve(os.tmpdir(), "marinara-hud-names-"));
const cssPath = resolve(tempDirectory, "client.css");
await buildClientCss(cssPath);
const css = await fs.readFile(cssPath, "utf8");
const game = (file) => resolve("packages/client/src/components/game", file).replaceAll("\\", "/");

const fixture = `
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GameMapPanel, MobileMapButton } from '${game("GameMap.tsx")}';
import { GamePanelContext } from '${game("FloatingGamePanel.tsx")}';
import { GameWidgetPanel, MobileWidgetPanel } from '${game("GameWidgetPanel.tsx")}';
import { GameContactBookWidget } from '${game("GameContactBookWidget.tsx")}';
import { GameInventory } from '${game("GameInventory.tsx")}';
import { GameJournal } from '${game("GameJournal.tsx")}';
import { GameCharacterSheet } from '${game("GameCharacterSheet.tsx")}';
import { GameStoryboardInlineViewer } from '${game("GameStoryboardViewer.tsx")}';

const NAMES = ${JSON.stringify(NAMES)};
class FixtureWorldMap extends HTMLElement {
  connectedCallback() { this.innerHTML = '<p style="padding:8px">Package view</p>'; }
}
customElements.define('marinara-capability-hierarchical-maps', FixtureWorldMap);

const nodeMap = {
  id: 'fixture-map', type: 'node', name: NAMES.map, description: '', partyPosition: 'here',
  nodes: [
    { id: 'here', emoji: 'A', label: NAMES.here, x: 30, y: 20, discovered: true },
    { id: 'there', emoji: 'B', label: NAMES.there, x: 75, y: 70, discovered: true },
  ],
  edges: [{ from: 'here', to: 'there' }],
};
const spatialContext = {
  definition: { enabled: true, locations: [{ id: 'loc-a', name: NAMES.place, status: 'active' }] },
  currentLocationId: 'loc-a',
  breadcrumb: [{ id: 'r', name: NAMES.region }, { id: 't', name: NAMES.town }, { id: 'loc-a', name: NAMES.place }],
  destinations: [],
  warnings: [],
};
const widgets = [
  { id: 'w-stats', type: 'stat_block', label: NAMES.widget, icon: 'S', position: 'hud_right',
    config: { stats: [{ name: NAMES.stat, value: '12' }] } },
  { id: 'w-grid', type: 'inventory_grid', label: 'Pack', icon: 'P', position: 'hud_right',
    config: { slots: 4, contents: [{ name: NAMES.gridItem, quantity: 2 }] } },
  { id: 'w-list', type: 'list', label: 'Gear', icon: 'L', position: 'hud_right',
    config: { items: [NAMES.listItem] } },
];
const frame = { id: 'f1', index: 0, title: NAMES.storyboard, status: 'image_complete',
  image: { url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' } };
const storyboard = { id: 's1', title: NAMES.storyboard, keyframes: [frame, { ...frame, id: 'f2', index: 1 }] };
const noop = () => {};

function Surface({ children }) {
  const surface = useRef(null);
  // Panels portal into the surface, so mount them once the surface element exists (as GameSurface does).
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

function WidgetsDesktop() {
  const context = React.useContext(GamePanelContext);
  return <GameWidgetPanel widgets={widgets} position="hud_right" chatId="fixture-chat" constraintsRef={context.surface} />;
}

// The loading card (same panel id, narrower) shows first; the loaded map card must not keep its width.
function LoadingThenMap() {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLoaded(true), 400);
    return () => clearTimeout(timer);
  }, []);
  return <GameMapPanel chatId="fixture-loading" map={loaded ? nodeMap : null} onMove={noop} selectedPosition={null}
    spatialContextLoading={!loaded} />;
}

function Part({ part }) {
  switch (part) {
    case 'map-panel':
      return <Surface><GameMapPanel chatId="fixture-chat" map={nodeMap} onMove={noop} selectedPosition={null} /></Surface>;
    case 'map-panel-loading':
      return <Surface><LoadingThenMap /></Surface>;
    case 'map-panel-narrow':
      // A narrow card with the day, time and state controls: the title must not be squeezed to a sliver.
      return (
        <Surface>
          <style>{"[data-game-panel-content='map']{max-width:208px}"}</style>
          <GameMapPanel chatId="fixture-chat" map={{ ...nodeMap, name: NAMES.map + ' World' }} onMove={noop}
            selectedPosition={null} gameState="exploration" day={1} timeOfDay="night" onDayChange={noop}
            onTimeChange={noop} />
        </Surface>
      );
    case 'popover-local':
    case 'popover-world':
      return (
        <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#123' }}>
          <div className="pointer-events-auto absolute left-3 right-14 top-[6.5rem] z-20 flex min-w-0 items-start gap-2">
            <MobileMapButton chatId="fixture-chat" map={nodeMap} onMove={noop} selectedPosition={null}
              spatialContext={part === 'popover-world' ? spatialContext : null} spatialContextLoading={false} />
          </div>
        </div>
      );
    case 'widgets':
      // Desktop: floating widget cards. Phones and tablets: the tray pills that open each widget.
      return innerWidth >= 1024 ? (
        <Surface><WidgetsDesktop /></Surface>
      ) : (
        <div style={{ padding: 12 }}><MobileWidgetPanel widgets={widgets} position="hud_right" chatId="fixture-chat" layout="horizontal" /></div>
      );
    case 'contacts':
      return <GameContactBookWidget chatId="fixture-chat" campaignKey="fixture-campaign" open onClose={noop} onOpenCharacter={noop} />;
    case 'inventory':
      return <GameInventory open onClose={noop} items={[
        { name: NAMES.item, quantity: 1 }, { name: 'Torch', quantity: 3 }, { name: NAMES.gridItem, quantity: 1 }]} />;
    case 'journal':
      return <GameJournal chatId="fixture-chat" onClose={noop}
        npcs={[{ id: 'n1', name: NAMES.npc, emoji: '', description: '', observedDescription: 'A traveller.', location: '', reputation: 0, met: true, notes: [] }]} />;
    case 'sheet':
      return <GameCharacterSheet onClose={noop} card={{ title: NAMES.sheet, subtitle: 'Scout', level: 3 }} />;
    case 'storyboard':
      return (
        <Surface>
          <GameStoryboardInlineViewer storyboard={storyboard} frame={frame} frameSectionLabel="1/2"
            generating={false} position={{ x: 0, y: 0 }} width={360} size="medium" playing={false} muted
            videoRef={{ current: null }} dragHandlers={{}} resizeHandlers={{}} onSelectFrame={noop} onClose={noop}
            onReplay={noop} onTogglePlayback={noop} onToggleMute={noop} onChangeSize={noop} onResizeByKeyboard={noop}
            onVideoPlayingChange={noop} />
        </Surface>
      );
    default:
      return null;
  }
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
        // Vite-only import.meta.glob in the locale loader: point it at an inert URL loader.
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
const apiData = {
  contacts: {
    contacts: [
      {
        id: "c1",
        characterId: "char-1",
        name: NAMES.contact,
        relationshipStatus: "ally",
        automaticCategories: [],
        evidenceMessageIds: [],
      },
    ],
    coverage: { complete: true, pendingSessions: 0 },
  },
  journal: {
    journal: {
      entries: [{ timestamp: "2026-01-01T00:00:00Z", type: "quest", title: NAMES.entry, content: "Fixture entry." }],
      quests: [],
      locations: [],
      npcLog: [{ npcName: NAMES.npc, interactions: ["Met at the gate."] }],
      inventoryLog: [],
    },
  },
};

// Every text node that holds a fixture name, checked for ellipsis, clamp, sideways overflow and clipping.
function inspectNames({ token, boxed }) {
  const problems = [];
  const describe = (el) => `${el.tagName.toLowerCase()}.${String(el.className?.baseVal ?? el.className).slice(0, 80)}`;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let checked = 0;
  while (walker.nextNode()) {
    const text = walker.currentNode;
    const nodeLabel = text.parentElement?.closest("[data-game-node-label]");
    if (!text.data.includes(token) && !nodeLabel) continue;
    const el = text.parentElement;
    if (!el || el.closest("select, option, title, style, script, [hidden]")) continue;
    const range = document.createRange();
    range.selectNodeContents(text);
    let rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue; // not rendered (collapsed menu, hidden layout variant)
    checked += 1;
    const label = text.data.trim().slice(0, 40);
    // A bordered tile (inventory slot) must grow to hold its name, not let it spill over the border.
    const tile = boxed ? el.closest(boxed) : null;
    if (tile) {
      let scrolls = false;
      for (let node = el; node && node !== tile; node = node.parentElement)
        if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) scrolls = true;
      const box = tile.getBoundingClientRect();
      if (!scrolls && (rect.top < box.top - 1 || rect.bottom > box.bottom + 1))
        problems.push(`${label}: spills out of its tile (${Math.round(rect.bottom)} > ${Math.round(box.bottom)})`);
    }
    if (text.data.includes("…")) problems.push(`${label}: cut with an ellipsis character`);
    // A squeezed name breaks inside short words ("Worl / d map"); only words too long for any line may break.
    for (const match of text.data.matchAll(/\S+/g)) {
      if (match[0].length > 12) continue;
      const word = document.createRange();
      word.setStart(text, match.index);
      word.setEnd(text, match.index + match[0].length);
      const lines = new Set([...word.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
      if (lines.size > 1) problems.push(`${label}: the word "${match[0]}" is split across lines`);
    }
    let block = el;
    while (block && ["inline", "contents"].includes(getComputedStyle(block).display)) block = block.parentElement;
    if (block && !(block instanceof SVGElement) && block.scrollWidth > block.clientWidth + 1)
      problems.push(
        `${label}: name element overflows sideways (${block.scrollWidth} > ${block.clientWidth}) ${describe(block)}`,
      );
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.textOverflow === "ellipsis" && style.overflowX !== "visible")
        problems.push(`${label}: text-overflow ellipsis on ${describe(node)}`);
      if (style.webkitLineClamp && style.webkitLineClamp !== "none")
        problems.push(`${label}: line clamp on ${describe(node)}`);
      const box = node.getBoundingClientRect();
      if (/(auto|scroll)/.test(style.overflowX + style.overflowY)) {
        // A scroll container can bring the name into its viewport, so outer ancestors only need to show that viewport.
        rect = {
          left: /(auto|scroll)/.test(style.overflowX) ? box.left : rect.left,
          right: /(auto|scroll)/.test(style.overflowX) ? Math.min(box.right, box.left + node.clientWidth) : rect.right,
          top: /(auto|scroll)/.test(style.overflowY) ? box.top : rect.top,
          bottom: /(auto|scroll)/.test(style.overflowY)
            ? Math.min(box.bottom, box.top + node.clientHeight)
            : rect.bottom,
        };
        continue;
      }
      const clipX = style.overflowX === "hidden" || style.overflowX === "clip";
      const clipY = style.overflowY === "hidden" || style.overflowY === "clip";
      if (!clipX && !clipY) continue;
      if (clipX && (rect.left < box.left - 1 || rect.right > box.right + 1))
        problems.push(`${label}: clipped sideways by ${describe(node)}`);
      if (clipY && (rect.top < box.top - 1 || rect.bottom > box.bottom + 1))
        problems.push(`${label}: clipped vertically by ${describe(node)}`);
    }
  }
  // Map titles keep a readable column: a squeezed title wraps below the controls instead.
  for (const title of document.querySelectorAll("[data-game-map-name]")) {
    const width = title.getBoundingClientRect().width;
    const room = title.parentElement.getBoundingClientRect().width;
    if (width > 0 && width < Math.min(100, room * 0.9))
      problems.push(`map title squeezed to ${Math.round(width)}px of ${Math.round(room)}px`);
  }
  return { checked, problems, pageScrollWidth: document.documentElement.scrollWidth, text: document.body.innerText };
}

const VIEWPORTS = [
  [390, 844],
  [820, 1180],
  [1024, 768],
  [1023, 461],
  [1440, 900],
];
const openMap = async (page) =>
  page.getByRole("button", { name: english["ui.game.mobilemapbutton.openMap"] }).click({ timeout: 15000 });
const openPill = (name) => async (page, width) => {
  if (width >= 1024) return;
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name, exact: true }).first().click();
  await page.getByRole("dialog").last().waitFor();
};
const PARTS = {
  // Legacy node map in the desktop card: hovering a node shows its full name as a wrapped tooltip.
  "map-panel": [{ names: ["map"], tooltip: NAMES.here, act: async (page) => page.locator("svg g").first().hover() }],
  "map-panel-narrow": [{ names: ["map"] }],
  "map-panel-loading": [{ names: ["map"], desktopMapWidth: 320 }],
  "popover-local": [
    {
      names: ["map", "here", "there"],
      tooltip: NAMES.there,
      act: async (page) => {
        await openMap(page);
        // First tap shows the node's tooltip, the second selects it (footer).
        const node = page.locator("svg g").nth(1);
        await node.dispatchEvent("click");
        await node.dispatchEvent("click");
      },
    },
  ],
  "popover-world": [{ names: ["region", "town", "place"], act: openMap }],
  widgets: [
    { names: ["widget", "stat"], act: openPill(NAMES.widget) },
    { names: ["gridItem"], act: openPill("Pack"), boxed: ".aspect-square" },
    { names: ["listItem"], act: openPill("Gear") },
  ],
  contacts: [{ names: ["contact"] }],
  inventory: [{ names: ["item", "gridItem"], boxed: "button[aria-pressed]" }],
  journal: [
    { names: ["entry"] },
    { names: ["npc"], act: async (page) => page.getByRole("button", { name: "NPCs" }).click() },
  ],
  sheet: [{ names: ["sheet"] }],
  storyboard: [
    {
      names: ["storyboard"],
      act: async (page, width) => {
        if (width >= 1024) return;
        const toggle = page.locator("button[aria-expanded=false]").first();
        if (await toggle.count()) await toggle.click();
      },
    },
  ],
};
const normalize = (value) => value.replace(/\s+/g, "");

const shotDir = process.env.GAME_HUD_NAMES_SCREENSHOT_DIR;
const browser = await chromium.launch({ headless: true });
try {
  for (const [width, height] of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 1024 });
    await context.route("http://fixture.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== "GET") return route.fulfill({ status: 405, body: "" });
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: html });
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: script });
      if (url.pathname.endsWith("/contacts")) return route.fulfill({ json: apiData.contacts });
      if (url.pathname.endsWith("/journal")) return route.fulfill({ json: apiData.journal });
      if (url.pathname.includes("scene")) return route.fulfill({ json: { scenes: [] } });
      if (url.pathname.includes("timing")) return route.fulfill({ json: { active: false, steps: [] } });
      return route.fulfill({ json: [] });
    });
    for (const [part, steps] of Object.entries(PARTS)) {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error.stack ?? error).slice(0, 600)));
      await page.goto(`http://fixture.test/?part=${part}`);
      for (const [index, step] of steps.entries()) {
        const label = `${width}x${height} ${part}#${index + 1}`;
        if (step.act) await step.act(page, width);
        await page
          .getByText(NAMES[step.names[0]].split(" ")[1], { exact: false })
          .first()
          .waitFor({ timeout: 15000 })
          .catch((error) => {
            throw new Error(`${label}: fixture did not render (${errors.join("; ") || error.message})`);
          });
        await page.waitForTimeout(120);
        const state = await page.evaluate(inspectNames, { token: TOKEN, boxed: step.boxed ?? null });
        if (shotDir)
          await page.screenshot({ path: resolve(shotDir, `names-${width}x${height}-${part}-${index + 1}.png`) });
        assert.deepEqual(errors, [], `${label}: no page errors`);
        assert.ok(state.checked > 0, `${label}: fixture names were measured`);
        assert.deepEqual(state.problems, [], `${label}:\n${state.problems.join("\n")}`);
        assert.ok(
          state.pageScrollWidth <= width,
          `${label}: the page does not scroll sideways (${state.pageScrollWidth})`,
        );
        const pageText = normalize(state.text);
        for (const key of step.names) {
          assert.ok(pageText.includes(normalize(NAMES[key])), `${label}: the full ${key} name is on screen`);
        }
        if (step.desktopMapWidth && width >= 1024) {
          await page.waitForTimeout(300);
          const boxWidth = await page
            .locator("[data-game-panel-content='map']")
            .evaluate((box) => box.getBoundingClientRect().width);
          assert.ok(boxWidth >= step.desktopMapWidth - 1, `${label}: the loaded map card is full width (${boxWidth})`);
        }
        if (step.tooltip) {
          const tooltip = await page.locator("[data-game-node-label]").first().textContent();
          assert.equal(
            normalize(tooltip ?? ""),
            normalize(step.tooltip),
            `${label}: node tooltip holds the whole name`,
          );
          const fits = await page
            .locator("[data-game-node-label]")
            .first()
            .evaluate((text) => {
              const box = text.previousElementSibling.getBBox();
              const inner = text.getBBox();
              return (
                inner.x >= box.x - 0.5 &&
                inner.x + inner.width <= box.x + box.width + 0.5 &&
                inner.y >= box.y - 0.5 &&
                inner.y + inner.height <= box.y + box.height + 0.5
              );
            });
          assert.ok(fits, `${label}: node tooltip text stays inside its box`);
        }
      }
      await page.close();
    }
    await context.close();
  }
  console.log("game hud full names: ok");
} finally {
  await browser.close();
  await fs.rm(tempDirectory, { recursive: true, force: true });
}
