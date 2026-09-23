import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { resolve } from "node:path";

// Tidy and Shift+click multi-select align in the Layout toolbar (real components, no server).
const panelSource = resolve("packages/client/src/components/game/FloatingGamePanel.tsx").replaceAll("\\", "/");
const toolbarSource = resolve("packages/client/src/components/game/GameLayoutEditToolbar.tsx").replaceAll("\\", "/");
const bundle = await build({
  stdin: {
    contents: `
      import React, { useRef, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { FloatingGamePanel, GamePanelContext } from '${panelSource}';
      import { GameLayoutEditToolbar } from '${toolbarSource}';
      window.contentClicks = 0;
      function App() {
        const surface = useRef(null);
        const [layoutEditing, setEditing] = useState(false);
        const [layoutRevision, setRevision] = useState(0);
        return <>
          <button id="edit" aria-pressed={layoutEditing} onClick={() => setEditing((v) => !v)}>Toggle editing</button>
          <div ref={surface} style={{ position: 'relative', height: 600, width: 900, overflow: 'hidden' }}>
            <GamePanelContext.Provider value={{ chatId: 'fixture', surface, layoutEditing, layoutRevision }}>
              <FloatingGamePanel id="map" width={260}>
                <div style={{ height: 200 }}>map</div>
              </FloatingGamePanel>
              <FloatingGamePanel id="widget:a" width={220}>
                <div style={{ height: 140 }}>widget:a</div>
              </FloatingGamePanel>
              <FloatingGamePanel id="widget:b" width={240}>
                <div style={{ height: 160 }}>widget:b</div>
              </FloatingGamePanel>
              <FloatingGamePanel id="widget:c" width={200}>
                <div style={{ height: 180 }}>widget:c</div>
              </FloatingGamePanel>
              <FloatingGamePanel id="widget:d" width={220}>
                <div style={{ height: 120 }}>widget:d</div>
              </FloatingGamePanel>
              <GameLayoutEditToolbar editing={layoutEditing} onDone={() => setEditing(false)} onLayoutApplied={() => setRevision((r) => r + 1)} />
            </GamePanelContext.Provider>
          </div>
        </>;
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

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.on("pageerror", (error) => console.error(error));
  await page.route("http://layout.fixture/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<style>[data-game-floating-panel]{position:absolute;top:0;left:0}</style><body style="margin:0"><div id="root"></div></body>',
    }),
  );
  await page.goto("http://layout.fixture/");
  await page.evaluate(() => {
    localStorage.clear();
    // A crowded pile: everything overlaps near the top left.
    const at = { map: [40, 40], "widget:a": [80, 60], "widget:b": [120, 90], "widget:c": [60, 200], "widget:d": [500, 300] };
    for (const [id, [x, y]] of Object.entries(at))
      localStorage.setItem(`marinara-game-panel:fixture:floating:${id}`, JSON.stringify({ locked: false, x, y }));
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.locator("[data-game-floating-panel=map]").waitFor();
  await page.locator("#edit").click();
  await page.locator("[data-layout-toolbar]").waitFor();
  const rects = () =>
    page.evaluate(() => {
      const host = document.querySelector("[data-game-floating-panel]").parentElement.getBoundingClientRect();
      return Object.fromEntries(
        [...document.querySelectorAll("[data-game-floating-panel]")].map((el) => {
          const r = el.getBoundingClientRect();
          return [el.dataset.gameFloatingPanel, { x: r.x - host.x, y: r.y - host.y, width: r.width, height: r.height }];
        }),
      );
    });
  const tool = (name) => page.locator(`[data-layout-tool="${name}"]`);
  const panel = (id) => page.locator(`[data-game-floating-panel="${id}"]`);

  assert.equal(await tool("tidy").count(), 1, "Tidy is always shown");
  assert.equal(await tool("align-left").count(), 0, "align hidden without a selection");

  // Shift+click selects without dragging; two selected shows the align tools.
  const before = await rects();
  await panel("widget:b").click({ modifiers: ["Shift"], position: { x: 20, y: 60 } });
  await panel("widget:d").click({ modifiers: ["Shift"], position: { x: 20, y: 60 } });
  assert.equal(await panel("widget:b").getAttribute("data-layout-selected"), "true");
  assert.equal(await panel("widget:d").getAttribute("data-layout-selected"), "true");
  assert.deepEqual((await rects())["widget:d"], before["widget:d"], "Shift+click does not drag");
  await tool("align-left").waitFor();
  assert.equal(await tool("match-width").count(), 1);
  await tool("align-left").click();
  await page.waitForTimeout(400);
  const aligned = await rects();
  assert.ok(Math.abs(aligned["widget:b"].x - aligned["widget:d"].x) < 1.5, `aligned left: ${JSON.stringify(aligned)}`);
  assert.equal(await page.locator("[data-layout-tool=undo]").isDisabled(), false, "align is an undo step");

  // Esc clears the selection before it leaves edit mode.
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[data-layout-selected]"));
  assert.equal(await page.locator("[data-layout-toolbar]").count(), 1, "first Esc only clears the selection");
  await panel("map").click({ modifiers: ["Shift"], position: { x: 20, y: 60 } });
  await page.mouse.click(870, 560);
  await page.waitForFunction(() => !document.querySelector("[data-layout-selected]"));

  // Tidy leaves no overlap, keeps everything on the surface, and undoes in one step.
  await tool("tidy").click();
  await page.waitForTimeout(600);
  const tidy = Object.entries(await rects());
  for (const [id, r] of tidy) assert.ok(r.x >= -0.5 && r.y >= -0.5 && r.x + r.width <= 900.5 && r.y + r.height <= 600.5, `${id} on surface`);
  for (let i = 0; i < tidy.length; i += 1)
    for (let j = i + 1; j < tidy.length; j += 1) {
      const [a, b] = [tidy[i][1], tidy[j][1]];
      const overlap = a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
      assert.ok(!overlap, `${tidy[i][0]} overlaps ${tidy[j][0]}: ${JSON.stringify(Object.fromEntries(tidy))}`);
    }
  await tool("undo").click();
  await page.waitForTimeout(400);
  const undone = await rects();
  assert.ok(Math.abs(undone["widget:d"].x - aligned["widget:d"].x) < 1.5 && Math.abs(undone["widget:d"].y - aligned["widget:d"].y) < 1.5, "undo restores the aligned layout");
  console.log("game-layout-tidy browser regression passed");
} finally {
  await browser.close();
}
