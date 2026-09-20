import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { resolve } from "node:path";

// Run the real panel and storage hook in an isolated browser, without a game server.
const bundle = await build({
  stdin: {
    contents: `
      import React, { useRef } from 'react';
      import { createRoot } from 'react-dom/client';
      import { FloatingGamePanel, GamePanelContext } from './src/components/game/FloatingGamePanel';
      function App({ width, epoch }) {
        const surface = useRef(null);
        return <div ref={surface} style={{position:'relative', width:1000, height:700}}>
          <GamePanelContext.Provider value={{chatId:'proof', surface, layoutEditing:true}}>
            <FloatingGamePanel key={epoch} id="widget:proof" width={width} autoWidth>
              <div style={{height:100}}>Layout proof</div>
            </FloatingGamePanel>
          </GamePanelContext.Provider>
        </div>;
      }
      const root = createRoot(document.getElementById('root'));
      window.renderPanel = (width, epoch=0) => root.render(<App width={width} epoch={epoch}/>);
      window.renderPanel(240);
    `,
    loader: "tsx",
    resolveDir: resolve("packages/client"),
  },
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
  await page.route("http://layout.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<div id="root"></div>',
    }),
  );
  await page.goto("http://layout.test/");
  await page.evaluate(() =>
    localStorage.setItem(
      "marinara-game-panel:proof:floating:widget:proof",
      JSON.stringify({
        locked: false,
        x: 75,
        y: 220,
        relativeX: 0.1,
        relativeY: 0.2,
      }),
    ),
  );
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const panel = page.locator("[data-game-floating-panel]");
  await panel.waitFor();
  const sizeKey = "marinara-game-panel:proof:floating:widget:proof:size-v2";
  const readPosition = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem("marinara-game-panel:proof:floating:widget:proof")));
  assert.equal((await readPosition()).y, 220, "legacy pixel position must not be rescaled on mount");
  const resize = page.getByRole("button", { name: "ui.game.floatingPanel.resize", exact: true });
  await resize.press("ArrowRight");
  await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key)).manualWidth === true, sizeKey);
  assert.equal(Math.round((await panel.boundingBox()).width), 250);
  await page.evaluate(() => window.renderPanel(180));
  await page.waitForTimeout(50);
  assert.equal(Math.round((await panel.boundingBox()).width), 250, "content changes cannot undo manual width");
  await page.evaluate(() => window.renderPanel(180, 1));
  await page.waitForTimeout(50);
  assert.equal(Math.round((await panel.boundingBox()).width), 250, "remount must retain manual width");
  assert.equal((await readPosition()).y, 220, "remount must retain position");
  await page.reload();
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await panel.waitFor();
  assert.equal(Math.round((await panel.boundingBox()).width), 250, "page reload must retain manual width");
  assert.equal((await readPosition()).y, 220, "page reload must retain position");
  await page.getByRole("button", { name: "ui.game.floatingPanel.reset", exact: true }).click();
  await page.evaluate(() => window.renderPanel(320, 1));
  await page.waitForFunction(() => document.querySelector("[data-game-floating-panel]").offsetWidth === 320);
  console.info(
    "Floating panel regression passed: manual width survives updates/remount, coordinates survive remount, reset restores automatic sizing.",
  );
} finally {
  await browser.close();
}
