// Phone and tablet Game map popover (MobileMapButton): whatever a capability package renders into the
// "World map" view, the host popover must fit the visible viewport, scroll to every control and never
// push past the right edge. A fixture package element taller and wider than the screen mounts inside the
// real host components (MobileMapButton -> CapabilityElement).
// Run from the repo root: node scripts/regressions/game-map-phone-popover.browser.mjs
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { buildClientCss } from "../ui-fixtures/lib/build-client-css.mjs";

const english = JSON.parse(await fs.readFile(resolve("packages/client/src/localization/locales/en.json"), "utf8"));
const tempDirectory = await fs.mkdtemp(resolve(os.tmpdir(), "marinara-map-popover-"));
const cssPath = resolve(tempDirectory, "client.css");
await buildClientCss(cssPath);
const css = await fs.readFile(cssPath, "utf8");
const source = resolve("packages/client/src/components/game/GameMap.tsx").replaceAll("\\", "/");

const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MobileMapButton } from '${source}';

// Fixture capability package: a place-details view taller and wider than any phone screen.
class FixtureWorldMap extends HTMLElement {
  connectedCallback() {
    if (this.dataset.ready) return;
    this.dataset.ready = 'true';
    const rows = Array.from({ length: 24 }, (_, index) =>
      '<button type="button" style="display:block;width:100%;min-height:44px;margin:4px 0">Placeholder place ' + (index + 1) + '</button>').join('');
    const cards = Array.from({ length: 5 }, (_, index) =>
      '<button type="button" style="flex:none;width:180px;min-height:44px">Linked place ' + (index + 1) + '</button>').join('');
    this.innerHTML = '<section data-fixture-package>' + rows +
      '<div data-fixture-linked style="display:flex;gap:6px;width:960px">' + cards + '</div>' +
      '<div style="display:flex;justify-content:flex-end;gap:6px">' +
      '<button type="button" data-fixture-step style="min-height:44px">Step by step</button>' +
      '<button type="button" data-fixture-last style="min-height:44px">Travel now</button></div></section>';
  }
}
customElements.define('marinara-capability-hierarchical-maps', FixtureWorldMap);

const spatialContext = {
  definition: { enabled: true, locations: [{ id: 'loc-a', name: 'Placeholder Hall', status: 'active' }] },
  currentLocationId: 'loc-a',
  breadcrumb: [{ id: 'loc-a', name: 'Placeholder Hall' }],
  destinations: [],
  warnings: [],
};
const noop = () => {};
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}>
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#123' }}>
      {/* Same anchor as GameSurface: the HUD row below the top bar, in its own z-20 stacking context. */}
      <div className="pointer-events-auto absolute left-3 right-14 top-[6.5rem] z-20 flex min-w-0 items-start gap-2">
        <MobileMapButton
          chatId="fixture-chat"
          map={null}
          onMove={noop}
          selectedPosition={null}
          disabled={false}
          gameState={null}
          spatialContext={spatialContext}
          spatialContextLoading={false}
        />
      </div>
    </div>
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
        plugin.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          contents: `const MAP=${JSON.stringify(english)};const i18n={language:'en',resolvedLanguage:'en',dir:()=>'ltr',t:(key)=>MAP[key]??key};export const initReactI18next={type:'3rdParty',init(){}};export const useTranslation=()=>({i18n,t:(key,values)=>{let value=MAP[key]??key;for(const[name,replacement]of Object.entries(values??{}))value=value.replaceAll(\`{{\${name}}}\`,String(replacement));return value;}});export const Trans=({children})=>children;`,
          loader: "js",
        }));
      },
    },
  ],
});

async function inspect(page) {
  return page.evaluate(() => {
    const host = document.querySelector("marinara-capability-hierarchical-maps");
    const panel = host.closest(".flex-col.overflow-hidden");
    let scroller = host.parentElement;
    while (scroller && scroller !== panel && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY))
      scroller = scroller.parentElement;
    const rect = panel.getBoundingClientRect();
    const popover = panel.parentElement.getBoundingClientRect();
    const viewport = window.visualViewport;
    return {
      bottom: rect.bottom,
      right: popover.right,
      visibleBottom: viewport ? viewport.offsetTop + viewport.height : innerHeight,
      width: innerWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
      scrollerIsHostChild: scroller !== panel && panel.contains(scroller),
      scrollable: scroller.scrollHeight > scroller.clientHeight,
    };
  });
}

async function lastControlReachable(page) {
  return page.evaluate(() => {
    const last = document.querySelector("[data-fixture-last]");
    const panel = last.closest(".flex-col.overflow-hidden");
    let scroller = last.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    scroller.scrollTop = scroller.scrollHeight;
    const rect = last.getBoundingClientRect();
    const x = Math.min(rect.left + rect.width / 2, innerWidth - 2);
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      hittable: hit === last || last.contains(hit),
      bottom: rect.bottom,
      panelBottom: panel.getBoundingClientRect().bottom,
    };
  });
}

const browser = await chromium.launch({ headless: true });
try {
  for (const [width, height] of [
    [360, 740],
    [390, 844],
    [412, 915],
    [768, 1024],
  ]) {
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: true });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.setContent(`<style>${css}</style><div id="root"></div>`);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const openButton = page.getByRole("button", { name: english["ui.game.mobilemapbutton.openMap"] });
    await openButton.click({ timeout: 15000 }).catch((error) => {
      throw new Error(`${width}x${height}: fixture did not render (${pageErrors.join("; ") || error.message})`);
    });
    await page.locator("[data-fixture-package]").waitFor();
    await page.waitForTimeout(100);

    const state = await inspect(page);
    const label = `${width}x${height}`;
    assert.ok(
      state.bottom <= state.visibleBottom,
      `${label}: popover ends inside the visible viewport (${state.bottom} <= ${state.visibleBottom})`,
    );
    assert.ok(
      state.bottom >= state.visibleBottom - 40,
      `${label}: a tall package view uses the room down to the visible bottom, not a fixed cap (${state.bottom})`,
    );
    assert.ok(state.right <= state.width, `${label}: popover stays inside the right edge`);
    assert.equal(state.pageScrollWidth, width, `${label}: wide package content does not widen the page`);
    assert.ok(state.scrollerIsHostChild && state.scrollable, `${label}: the host container scrolls the package view`);
    const reach = await lastControlReachable(page);
    assert.ok(reach.hittable, `${label}: the package's last control can be scrolled to and tapped`);
    assert.ok(reach.bottom <= reach.panelBottom + 1, `${label}: the last control is not clipped by the popover`);

    // Browser chrome or the on-screen keyboard shrinking the viewport: the popover re-fits.
    await page.setViewportSize({ width, height: Math.round(height * 0.6) });
    await page.waitForTimeout(150);
    const shrunk = await inspect(page);
    assert.ok(
      shrunk.bottom <= shrunk.visibleBottom,
      `${label}: popover re-fits a shorter viewport (${shrunk.bottom} <= ${shrunk.visibleBottom})`,
    );
    assert.ok(
      (await lastControlReachable(page)).hittable,
      `${label}: last control still reachable after the viewport shrinks`,
    );
    await page.close();
  }
  console.log("game map phone popover: ok");
} finally {
  await browser.close();
  await fs.rm(tempDirectory, { recursive: true, force: true });
}
