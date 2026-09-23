import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { resolve } from "node:path";

// Edit layout keyboard fixture: the rename field hands focus back, handles are named per
// panel, and modifier chords (AltGr, Ctrl+Arrow) do not trigger layout shortcuts.
const panelSource = resolve("packages/client/src/components/game/FloatingGamePanel.tsx").replaceAll("\\", "/");
const toolbarSource = resolve("packages/client/src/components/game/GameLayoutEditToolbar.tsx").replaceAll("\\", "/");
const bundle = await build({
  stdin: {
    contents: `
      import React, { useRef, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { FloatingGamePanel, GamePanelContext } from '${panelSource}';
      import { GameLayoutEditToolbar } from '${toolbarSource}';
      function App() {
        const surface = useRef(null);
        const [layoutEditing, setEditing] = useState(false);
        const [layoutRevision, setRevision] = useState(0);
        return <>
          <button id="edit" aria-pressed={layoutEditing} onClick={() => setEditing((v) => !v)}>Toggle editing</button>
          <div ref={surface} style={{ position: 'relative', height: 640, width: 1100, overflow: 'hidden' }}>
            <GamePanelContext.Provider value={{ chatId: 'focus-a', surface, layoutEditing, layoutRevision }}>
              <FloatingGamePanel id="widget:alpha" width={240} tuckLabel="Alpha" allowTuck>
                <div style={{ height: 100 }}>Alpha content</div>
              </FloatingGamePanel>
              <FloatingGamePanel id="widget:beta" width={240} tuckLabel="Beta" allowTuck>
                <div style={{ height: 100 }}>Beta content</div>
              </FloatingGamePanel>
              <FloatingGamePanel id="map" width={260}>
                <div style={{ height: 120 }}>Map content</div>
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
          contents:
            "export const useTranslation=()=>({t:(key,options)=>options&&options.name!=null?key+' '+options.name:key});",
        }));
      },
    },
  ],
});

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("http://focus.fixture/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<style>[data-game-floating-panel]{position:absolute;top:0;left:0}</style><body style="margin:0"><div id="root"></div></body>',
    }),
  );
  await page.goto("http://focus.fixture/");
  await page.evaluate(() => {
    localStorage.clear();
    const put = (id, x, y) =>
      localStorage.setItem(
        `marinara-game-panel:focus-a:floating:${id}`,
        JSON.stringify({ locked: false, x, y, surfaceWidth: 1100, surfaceHeight: 640 }),
      );
    put("widget:alpha", 40, 120);
    put("widget:beta", 40, 300);
    put("map", 600, 200);
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const alpha = page.locator('[data-game-floating-panel="widget:alpha"]');
  const beta = page.locator('[data-game-floating-panel="widget:beta"]');
  const map = page.locator("[data-game-floating-panel=map]");
  await map.waitFor();
  await page.waitForTimeout(200);
  const box = async (locator) => {
    const rect = await locator.boundingBox();
    return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  };
  const focused = () =>
    page.evaluate(() => {
      const element = document.activeElement;
      return {
        panel: element?.closest("[data-game-floating-panel]")?.getAttribute("data-game-floating-panel") ?? null,
        label: element?.getAttribute("aria-label") ?? element?.tagName ?? null,
      };
    });
  await page.locator("#edit").click();
  await page.locator("[data-layout-toolbar]").waitFor();
  const moveOf = (panel) => panel.locator("[data-panel-layout-controls] button").first();
  const resizeOf = (panel) => panel.locator('button[data-panel-resize-handle="se"]');

  // 1. Move and Resize handles carry the panel name, so each one has a distinct accessible name.
  const moveLabels = await Promise.all([alpha, beta, map].map((panel) => moveOf(panel).getAttribute("aria-label")));
  const resizeLabels = await Promise.all([alpha, beta, map].map((panel) => resizeOf(panel).getAttribute("aria-label")));
  assert.equal(new Set(moveLabels).size, 3, `move handles are named per panel (${moveLabels.join(" / ")})`);
  assert.equal(new Set(resizeLabels).size, 3, `resize handles are named per panel (${resizeLabels.join(" / ")})`);
  assert.ok(moveLabels[0].includes("Alpha") && resizeLabels[2].length > 0, "the name is the panel label");

  // 2. Arrow nudges ignore Ctrl, Alt and Meta chords (browser and OS shortcuts).
  const alphaStart = await box(alpha);
  await moveOf(alpha).focus();
  for (const chord of ["Control+ArrowRight", "Alt+ArrowRight", "Meta+ArrowRight"]) await page.keyboard.press(chord);
  await page.waitForTimeout(100);
  assert.deepEqual(await box(alpha), alphaStart, "modified arrows do not nudge the panel");
  const betaStart = await box(beta);
  await resizeOf(beta).focus();
  for (const chord of ["Control+ArrowRight", "Alt+ArrowRight"]) await page.keyboard.press(chord);
  await page.waitForTimeout(100);
  assert.deepEqual(await box(beta), betaStart, "modified arrows do not resize the panel");

  // 3. AltGr (Ctrl+Alt on Windows) is a character chord, not undo.
  await moveOf(alpha).focus();
  const beforeAltGr = await box(alpha);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(650);
  await page.keyboard.press("Control+Alt+z");
  await page.keyboard.press("Control+Alt+y");
  await page.waitForTimeout(250);
  assert.equal((await box(alpha)).y, beforeAltGr.y + 10, "Ctrl+Alt+Z does not undo");

  // 4. Esc in the rename field cancels and hands focus back to the rename button.
  await page.locator('[data-layout-tool="layouts"]').click();
  const layouts = page.getByRole("dialog", { name: "ui.game.layoutEditor.layouts" });
  await layouts.waitFor();
  await layouts.getByRole("textbox", { name: "ui.game.layoutEditor.layoutName" }).fill("First");
  await layouts.locator("[data-layout-save]").click();
  const renameButton = layouts.getByRole("button", { name: "ui.game.layoutEditor.renameLayout First" });
  await renameButton.click();
  const renameField = layouts.getByRole("textbox", { name: "ui.game.layoutEditor.renameLayout First" });
  await renameField.fill("Second");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  assert.equal(await layouts.count(), 1, "Esc in the rename field leaves the popover open");
  assert.equal(await page.locator('[data-layout-saved="First"]').count(), 1, "Esc cancels the rename");
  let now = await focused();
  assert.equal(now.label, "ui.game.layoutEditor.renameLayout First", "focus returns to the rename button");
  await renameButton.click();
  await renameField.fill("Third");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(100);
  assert.equal(await page.locator('[data-layout-saved="Third"]').count(), 1, "Enter commits the rename");
  now = await focused();
  assert.equal(now.label, "ui.game.layoutEditor.renameLayout Third", "focus returns to the rename button on Enter");
  await page.keyboard.press("Escape");

  assert.deepEqual(errors, [], "no page errors");
  console.info("Game layout edit focus fixture passed: handle names, modifier chords, rename");
} finally {
  await browser.close();
}
