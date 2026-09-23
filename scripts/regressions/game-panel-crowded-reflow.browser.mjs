import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { resolve } from "node:path";

// Real FloatingGamePanel with the 11 panels of a crowded HUD on a 1440x900
// screen (surface 1440x849). The rebuild regression crushed every panel, narration
// included, to 64px here. This also covers stored layouts from before the rebuild,
// positions saved while panels were crushed, and that automatic reflow writes nothing.
const panelSource = resolve("packages/client/src/components/game/FloatingGamePanel.tsx").replaceAll("\\", "/");
const PANELS = [
  { id: "toolbar", width: 900, height: 34, props: "side='hud_right'" },
  { id: "map", width: 320, height: 382, props: "height={420} autoGrow" },
  { id: "narration", width: 896, height: 225, props: "bottom autoGrow reserveSpace" },
  { id: "widget:widget_a", width: 384, height: 306, props: "autoGrow allowTuck" },
  { id: "widget:widget_b", width: 336, height: 217, props: "autoGrow allowTuck" },
  { id: "widget:widget_c", width: 448, height: 161, props: "autoGrow allowTuck" },
  { id: "widget:widget_d", width: 348, height: 87, props: "autoGrow allowTuck" },
  { id: "widget:widget_e", width: 325, height: 68, props: "allowTuck" },
  { id: "widget:widget_f", width: 727, height: 199, props: "autoGrow allowTuck side='hud_right'" },
  { id: "scene-presence", width: 320, height: 87, props: "side='hud_right' bottom" },
  { id: "storyboard", width: 368, height: 392, props: "side='hud_right' autoGrow overflowVisible fillHeight" },
];
const bundle = await build({
  stdin: {
    contents: `
      import React, { useRef } from 'react';
      import { createRoot } from 'react-dom/client';
      import { FloatingGamePanel, GamePanelContext } from '${panelSource}';
      function App() {
        const surface = useRef(null);
        return <div ref={surface} id="surface" style={{ position: 'relative', height: 849, width: 1440, overflow: 'hidden' }}>
          <GamePanelContext.Provider value={{ chatId: 's12', surface, layoutEditing: false, layoutRevision: 0 }}>
            ${PANELS.map(
              (panel) =>
                `<FloatingGamePanel id="${panel.id}" width={${panel.width}} ${panel.props}><div style={{ height: ${panel.height}, width: '100%', background: '#345' }}>${panel.id}</div></FloatingGamePanel>`,
            ).join("\n")}
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

// Positions saved while every panel was 64px tall: the left column piled 72px apart.
const CRUSHED_ERA = {
  toolbar: [528, 48],
  map: [12, 29],
  narration: [272, 766],
  "widget:widget_a": [12, 316],
  "widget:widget_b": [12, 388],
  "widget:widget_c": [12, 460],
  "widget:widget_d": [12, 532],
  "widget:widget_e": [12, 680],
  "widget:widget_f": [701, 483],
  "scene-presence": [560, 694],
  storyboard: [1060, 70],
};

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (error) => console.error(error));
  await page.route("http://crowded.fixture/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<style>[data-game-floating-panel]{position:absolute;top:0;left:0}</style><body style="margin:0"><div id="root"></div></body>',
    }),
  );
  await page.goto("http://crowded.fixture/");
  await page.evaluate(
    ({ panels, positions }) => {
      localStorage.clear();
      const prefix = "marinara-game-panel:s12:floating:";
      for (const panel of panels) {
        const [x, y] = positions[panel.id];
        const maxX = 1440 - panel.width;
        const maxY = Math.max(1, 849 - 64);
        localStorage.setItem(
          `${prefix}${panel.id}`,
          JSON.stringify({
            locked: true,
            x,
            y,
            bottom: y + 64,
            surfaceWidth: 1440,
            surfaceHeight: 849,
            relativeX: maxX > 0 ? x / maxX : 0,
            relativeY: y / maxY,
          }),
        );
        // A layout saved before the rebuild: widths only, content growth, bottom panels placed.
        localStorage.setItem(
          `${prefix}${panel.id}:size-v2`,
          JSON.stringify({ width: panel.width, manualWidth: false }),
        );
        localStorage.setItem(`${prefix}${panel.id}:size-v2:placed`, "true");
      }
      localStorage.setItem(`${prefix}map:size-v2`, JSON.stringify({ width: 320, height: 420, manualWidth: false }));
      localStorage.setItem(`${prefix}narration:size-v2:growth`, "bottom");
      // A fixed-height widget whose stored height is below the minimum: treat it as unset.
      localStorage.setItem(
        `${prefix}widget:widget_e:size-v2`,
        JSON.stringify({ width: 325, height: 40, manualWidth: false }),
      );
      localStorage.setItem(`${prefix}widget:widget_e:size-v2:growth`, "fixed");
    },
    { panels: PANELS, positions: CRUSHED_ERA },
  );
  const before = await page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort()));
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.locator('[data-game-floating-panel="storyboard"]').waitFor();
  await page.waitForTimeout(800);

  const boxes = await page.evaluate(() =>
    [...document.querySelectorAll("[data-game-floating-panel]")].map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        id: element.getAttribute("data-game-floating-panel"),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    }),
  );
  assert.equal(boxes.length, PANELS.length, "all 11 panels render");
  // The layout settles: no feedback between height limits, anchors and measurement.
  await page.waitForTimeout(600);
  const settled = await page.evaluate(() =>
    [...document.querySelectorAll("[data-game-floating-panel]")].map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        id: element.getAttribute("data-game-floating-panel"),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    }),
  );
  assert.deepEqual(settled, boxes, "the crowded layout is stable, not flipping between solutions");
  const byId = new Map(boxes.map((box) => [box.id, box]));
  const floor = Math.max(160, Math.round(849 / 3));
  for (const id of ["narration", "map", "storyboard"]) {
    const natural = PANELS.find((panel) => panel.id === id).height;
    assert.ok(
      byId.get(id).height >= Math.min(natural, floor) - 1,
      `${id} is not crushed (${byId.get(id).height}px of ${natural}px)`,
    );
  }
  assert.ok(Math.abs(byId.get("narration").height - 225) < 1, "narration keeps its full height");
  const crushed = boxes.filter((box) => box.height <= 64.5 && PANELS.find((panel) => panel.id === box.id).height > 64);
  assert.deepEqual(
    crushed.map((box) => box.id),
    [],
    "no panel is crushed to the 64px minimum",
  );
  assert.ok(
    // The old code clamped it to a firm 64px; unset, it sizes to its content (reflow may trim a few px).
    byId.get("widget:widget_e").height > 64.5,
    `a stored height below the minimum is treated as unset (${byId.get("widget:widget_e").height})`,
  );
  const overlapping = [];
  for (let i = 0; i < boxes.length; i += 1)
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      if (
        a.x < b.x + b.width - 0.5 &&
        a.x + a.width > b.x + 0.5 &&
        a.y < b.y + b.height - 0.5 &&
        a.y + a.height > b.y + 0.5
      )
        overlapping.push(`${a.id} x ${b.id}`);
    }
  assert.deepEqual(overlapping, [], "crushed-era positions recover to a non-overlapping layout");
  for (const box of boxes) assert.ok(box.y >= -0.5 && box.y + box.height <= 849.5, `${box.id} stays on the surface`);

  const after = await page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort()));
  const changed = JSON.parse(after).filter(
    ([key, value]) => !JSON.parse(before).some(([k, v]) => k === key && v === value),
  );
  const sizeWrites = changed.filter(([key]) => key.includes(":size-v2") && !key.endsWith(":growth"));
  // The only size rewrite is dropping the invalid stored height; reflow heights are never saved.
  assert.deepEqual(
    sizeWrites,
    [["marinara-game-panel:s12:floating:widget:widget_e:size-v2", JSON.stringify({ width: 325, manualWidth: false })]],
    "automatic reflow never writes a size",
  );
  assert.deepEqual(
    changed.filter(([key]) => PANELS.some((panel) => key === `marinara-game-panel:s12:floating:${panel.id}`)),
    [],
    "automatic reflow never persists a position",
  );
  console.info("Game panel crowded reflow regression passed: 11 panels at 1440x900 keep readable heights");
} finally {
  await browser.close();
}
