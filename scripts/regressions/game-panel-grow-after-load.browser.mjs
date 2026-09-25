import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { resolve } from "node:path";

// Real FloatingGamePanel: panels that grow after load must never be covered by a neighbour
// while Collisions are on.
// 1. The map card mounts as a small placeholder (no autoGrow, no height), then the same panel
//    instance becomes the real map (autoGrow, height 420) and its content grows to 512px. The
//    placeholder's "fixed" growth used to stick and the layout planned around the 420px height
//    prop while the box rendered 512px, so saved neighbours covered its bottom.
// 2. A widget grows after load; the widget saved below it must reflow, not cover it.
// 3. A narration card that caps itself and scrolls inside hid its composer below that inner fold
//    on a short surface (a tablet keyboard): the composer must stay in view.
// Automatic reflow writes nothing to storage, and Collisions off leaves overlaps alone.
const panelSource = resolve("packages/client/src/components/game/FloatingGamePanel.tsx").replaceAll("\\", "/");
const collisionsKey = "marinara-game-layout-collisions";

const bundle = await build({
  stdin: {
    contents: `
      import React, { useRef, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { FloatingGamePanel, GamePanelContext } from '${panelSource}';
      function Block({ height, label }) {
        return <div data-block={label} style={{ height, width: '100%', background: '#345' }}>{label}</div>;
      }
      function App() {
        const surface = useRef(null);
        const [grown, setGrown] = useState(false);
        const [narrow] = useState(() => window.location.hash === '#narration');
        window.__grow = () => setGrown(true);
        if (narrow)
          return <div ref={surface} id="surface" style={{ position: 'relative', height: '100vh', width: '100vw', overflow: 'hidden' }}>
            <GamePanelContext.Provider value={{ chatId: 'g1', surface, layoutEditing: false, layoutRevision: 0 }}>
              <FloatingGamePanel id="narration" width={896} bottom autoGrow reserveSpace>
                <div className="card">
                  <Block height={180} label="prose" />
                  <Block height={60} label="controls" />
                  <div className="dock" data-game-panel-keep data-game-composer-dock><Block height={112} label="composer" /></div>
                </div>
              </FloatingGamePanel>
            </GamePanelContext.Provider>
          </div>;
        return <div ref={surface} id="surface" style={{ position: 'relative', height: 849, width: 1440, overflow: 'hidden' }}>
          <GamePanelContext.Provider value={{ chatId: 'g1', surface, layoutEditing: false, layoutRevision: 0 }}>
            {grown
              ? <FloatingGamePanel id="map" width={320} height={420} autoGrow autoWidth><Block height={512} label="map" /></FloatingGamePanel>
              : <FloatingGamePanel id="map" width={208} autoWidth overflowVisible><Block height={90} label="map" /></FloatingGamePanel>}
            <FloatingGamePanel id="narration" width={896} bottom autoGrow reserveSpace>
              <Block height={300} label="narration" /><div data-game-panel-keep><Block height={112} label="composer" /></div>
            </FloatingGamePanel>
            <FloatingGamePanel id="widget:widget_bonds" width={218} autoGrow allowTuck><Block height={124} label="bonds" /></FloatingGamePanel>
            <FloatingGamePanel id="widget:widget_grow" width={300} autoGrow allowTuck side="hud_right"><Block height={grown ? 360 : 100} label="grow" /></FloatingGamePanel>
            <FloatingGamePanel id="widget:widget_below" width={300} autoGrow allowTuck side="hud_right"><Block height={100} label="below" /></FloatingGamePanel>
            <FloatingGamePanel id="widget:widget_fit" width={250} autoGrow allowTuck><Block height={grown ? 300 : 100} label="fit" /></FloatingGamePanel>
            <FloatingGamePanel id="widget:widget_force" width={250} autoGrow autoGrowOverridesManual allowTuck><Block height={grown ? 300 : 100} label="force" /></FloatingGamePanel>
            <FloatingGamePanel id="widget:widget_under" width={250} autoGrow allowTuck><Block height={80} label="under" /></FloatingGamePanel>
          </GamePanelContext.Provider>
        </div>;
      }
      createRoot(document.getElementById('root')).render(<App />);
    `,
    loader: "tsx",
    resolveDir: process.cwd(),
  },
  nodePaths: [resolve("packages/client/node_modules")],
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "translation",
      setup(b) {
        b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: "translation", namespace: "fixture" }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: "export const useTranslation=()=>({t:key=>key});",
        }));
      },
    },
  ],
});

// Saved anchors [x, y, width, height at save] from the reported layout: bonds and narration sit
// just below where the map card used to end.
const SAVED = {
  map: [12, 2, 208, 90],
  narration: [272, 437, 896, 412],
  "widget:widget_bonds": [12, 437, 218, 124],
  "widget:widget_grow": [1128, 48, 300, 100],
  "widget:widget_below": [1128, 160, 300, 100],
  "widget:widget_fit": [400, 48, 250, 120],
  "widget:widget_force": [720, 48, 250, 120],
  "widget:widget_under": [720, 176, 250, 80],
};
// Widgets the player resized by hand to 120px: "fit" keeps that height, "force" grows past it.
const MANUAL = ["widget:widget_fit", "widget:widget_force"];

// The narration card mirrors GameNarration: capped to the viewport and scrolling inside, until the
// layout limits the panel; then the card opens up and the composer dock pins to the box bottom.
const FIXTURE_CSS = `[data-game-floating-panel]{position:absolute;top:0;left:0}
.card{max-height:calc(100dvh - 7rem);overflow-y:auto;padding:12px}
[data-game-panel-limited=true] .card{max-height:none;overflow:visible}
[data-game-panel-limited=true] .dock{position:sticky;bottom:-1px;z-index:10}`;

const boxesOf = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-game-floating-panel]")].map((element) => {
      const rect = element.getBoundingClientRect();
      const content = element.querySelector("[data-game-panel-content]");
      return {
        id: element.getAttribute("data-game-floating-panel"),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        // The fixture has no Tailwind CSS: read the scroll class the panel sets on a limited box.
        scrolls: /(^|\s)overflow-auto(\s|$)/.test(content.className) && content.style.maxHeight !== "",
        natural: content.scrollHeight,
      };
    }),
  );
const overlaps = (a, b) =>
  a.x < b.x + b.width - 0.5 && a.x + a.width > b.x + 0.5 && a.y < b.y + b.height - 0.5 && a.y + a.height > b.y + 0.5;
const storageSnapshot = (page) => page.evaluate(() => Object.entries(localStorage).sort());

async function openFixture(browser, { collisions = true, hash = "", viewport = { width: 1440, height: 900 } } = {}) {
  const page = await browser.newPage({ viewport });
  page.on("pageerror", (error) => console.error(error));
  await page.route("http://grow.fixture/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<style>${FIXTURE_CSS}</style><body style="margin:0"><div id="root"></div></body>`,
    }),
  );
  await page.goto(`http://grow.fixture/${hash}`);
  await page.evaluate(
    ({ saved, collisions, collisionsKey, manual }) => {
      localStorage.clear();
      if (!collisions) localStorage.setItem(collisionsKey, "false");
      const prefix = "marinara-game-panel:g1:floating:";
      for (const [id, [x, y, width, height]] of Object.entries(saved)) {
        const maxX = 1440 - width;
        localStorage.setItem(
          `${prefix}${id}`,
          JSON.stringify({
            locked: true,
            x,
            y,
            bottom: y + height,
            surfaceWidth: 1440,
            surfaceHeight: 849,
            relativeX: maxX > 0 ? x / maxX : 0,
            relativeY: y / (849 - height),
          }),
        );
        localStorage.setItem(`${prefix}${id}:size-v2`, JSON.stringify({ width, manualWidth: false }));
        localStorage.setItem(`${prefix}${id}:size-v2:placed`, "true");
      }
      localStorage.setItem(`${prefix}narration:size-v2:growth`, "bottom");
      for (const id of manual) {
        localStorage.setItem(`${prefix}${id}:size-v2`, JSON.stringify({ width: 250, height: 120, manualWidth: false }));
        localStorage.setItem(`${prefix}${id}:size-v2:growth`, "fixed");
        localStorage.setItem(`${prefix}${id}:size-v2:growth-explicit`, "true");
      }
    },
    { saved: SAVED, collisions, collisionsKey, manual: MANUAL },
  );
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.locator('[data-game-floating-panel="narration"]').waitFor();
  await page.waitForTimeout(700);
  return page;
}

const browser = await chromium.launch({ headless: true });
try {
  // Collisions on: grow after load.
  {
    const page = await openFixture(browser);
    const loaded = await storageSnapshot(page);
    await page.evaluate(() => window.__grow());
    await page.waitForTimeout(900);
    const boxes = await boxesOf(page);
    await page.waitForTimeout(600);
    assert.deepEqual(await boxesOf(page), boxes, "the grown layout settles without flipping between solutions");
    const byId = new Map(boxes.map((box) => [box.id, box]));
    const map = byId.get("map");
    assert.equal(map.width, 320, "the placeholder became the real map");
    for (const grownId of ["map", "widget:widget_grow", "widget:widget_force"]) {
      const grown = byId.get(grownId);
      for (const other of boxes)
        if (other.id !== grownId)
          assert.ok(
            !overlaps(grown, other),
            `${other.id} does not cover the grown ${grownId} ${JSON.stringify([grown, other])}`,
          );
      // Whatever does not fit scrolls inside the panel, so all of it stays reachable.
      assert.ok(
        grown.height >= grown.natural - 1 || grown.scrolls,
        `${grownId} shows or scrolls all of its content ${JSON.stringify(boxes)}`,
      );
    }
    // Narration keeps its reading priority: its anchor, and a box that still holds the composer.
    const narration = byId.get("narration");
    assert.ok(
      Math.abs(narration.y - 437) < 1 && Math.abs(narration.x - 272) < 1,
      `narration keeps its anchor ${JSON.stringify(narration)}`,
    );
    assert.ok(narration.height >= 412 - 1, `narration keeps its full height (${narration.height})`);
    assert.ok(map.height >= Math.max(160, Math.round(849 / 3)) - 1, `the map stays readable (${map.height})`);
    // The widget grew to its full height; the one below moved away rather than covering it.
    const grow = byId.get("widget:widget_grow");
    assert.ok(
      Math.abs(grow.height - 360) < 1 && Math.abs(grow.x - 1128) < 1,
      `the grown widget keeps its column and height ${JSON.stringify(grow)}`,
    );
    // A manual height wins over growth unless the panel forces growth past it.
    assert.ok(Math.abs(byId.get("widget:widget_fit").height - 120) < 1, "autoGrow keeps a manual height");
    assert.ok(Math.abs(byId.get("widget:widget_force").height - 300) < 1, "autoGrowOverridesManual grows past it");
    const changed = (await storageSnapshot(page)).filter(
      ([key, value]) => !loaded.some(([k, v]) => k === key && v === value),
    );
    // The real map's autoWidth prop (208 to 320px) is a prop change, not reflow; heights are never saved.
    assert.deepEqual(
      changed.filter(([key]) => !key.endsWith(":growth")),
      [["marinara-game-panel:g1:floating:map:size-v2", JSON.stringify({ width: 320, manualWidth: false })]],
      "growing and reflowing write no position or height",
    );
    await page.close();
  }

  // Collisions off: panels keep their anchors and may overlap on purpose.
  {
    const page = await openFixture(browser, { collisions: false });
    await page.evaluate(() => window.__grow());
    await page.waitForTimeout(900);
    const byId = new Map((await boxesOf(page)).map((box) => [box.id, box]));
    assert.ok(Math.abs(byId.get("widget:widget_below").y - 160) < 1, "with Collisions off the widget below stays put");
    assert.ok(Math.abs(byId.get("map").height - 512) < 1, "with Collisions off the map shows at full height");
    assert.ok(overlaps(byId.get("map"), byId.get("narration")), "with Collisions off the overlap is left alone");
    await page.close();
  }

  // A short surface (a tablet keyboard): the self-capped narration card must not hide the composer.
  {
    const page = await openFixture(browser, { hash: "#narration", viewport: { width: 1024, height: 768 } });
    await page.setViewportSize({ width: 1024, height: 330 });
    await page.waitForTimeout(1200);
    const dock = await page.evaluate(() => {
      const rect = document.querySelector("[data-game-composer-dock]").getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { top: rect.top, bottom: rect.bottom, hit: !!hit?.closest("[data-game-composer-dock]"), vh: innerHeight };
    });
    assert.ok(
      dock.top >= 0 && dock.bottom <= dock.vh + 1 && dock.hit,
      `the composer stays in view ${JSON.stringify(dock)}`,
    );
    await page.close();
  }
  console.info("Game panel grow-after-load regression passed: grown panels are never covered with Collisions on");
} finally {
  await browser.close();
}
