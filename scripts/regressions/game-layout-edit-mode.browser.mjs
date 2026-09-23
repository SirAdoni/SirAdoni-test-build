import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { resolve } from "node:path";

// Real FloatingGamePanel + GameLayoutEditToolbar in an isolated page, no game server.
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
                <button style={{ height: 120, width: '100%' }}>Map content</button>
              </FloatingGamePanel>
              <FloatingGamePanel id="widget:alpha" width={200} tuckLabel="Alpha" autoGrow allowTuck>
                <button style={{ height: 100, width: '100%' }} onClick={() => { window.contentClicks += 1; }}>Alpha content</button>
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
      body:
        // No Tailwind in the fixture: give panels the absolute placement their classes provide in the app.
        '<style>[data-game-floating-panel]{position:absolute;top:0;left:0}</style><body style="margin:0"><div id="root"></div></body>',
    }),
  );
  await page.goto("http://layout.fixture/");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("marinara-game-panel:fixture:floating:map", JSON.stringify({ locked: true, x: 320, y: 280 }));
    localStorage.setItem(
      "marinara-game-panel:fixture:floating:widget:alpha",
      JSON.stringify({ locked: true, x: 40, y: 96 }),
    );
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const map = page.locator("[data-game-floating-panel=map]");
  const alpha = page.locator('[data-game-floating-panel="widget:alpha"]');
  await map.waitFor();
  await alpha.waitFor();
  const surfaceBox = await page.evaluate(() => {
    const rect = document.querySelector("[data-game-floating-panel=map]").parentElement.getBoundingClientRect();
    return { x: rect.x, y: rect.y };
  });
  const position = async (locator) => {
    const box = await locator.boundingBox();
    return { x: box.x - surfaceBox.x, y: box.y - surfaceBox.y, width: box.width, height: box.height };
  };
  const stored = (id) =>
    page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? "null"),
      `marinara-game-panel:fixture:floating:${id}`,
    );

  // Not editing: no chrome, content interactive.
  assert.equal(await page.locator("[data-panel-layout-controls]").count(), 0);
  assert.equal(await page.locator("[data-layout-toolbar]").count(), 0);
  await alpha.getByRole("button", { name: "Alpha content" }).click();
  assert.equal(await page.evaluate(() => window.contentClicks), 1, "content works outside edit mode");

  // Enter edit mode: grid, outlines, label chips, toolbar and the all-locked hint.
  await page.locator("#edit").click();
  await page.locator("[data-layout-toolbar]").waitFor();
  assert.equal(await page.locator("[data-layout-grid]").count(), 1, "edit mode draws the grid");
  assert.equal(await page.locator("[data-panel-edit-outline]").count(), 2, "every panel gets an outline");
  assert.equal(await page.locator("[data-panel-layout-controls]").count(), 2, "every panel gets a label chip");
  assert.equal(await map.getAttribute("data-layout-locked"), "true", "locked panels look locked");
  assert.ok(await map.getByRole("button", { name: "ui.game.floatingPanel.move" }).isDisabled());
  await page.locator("[data-layout-locked-hint]").waitFor();
  await page
    .locator("[data-layout-locked-hint]")
    .getByRole("button", { name: "ui.game.layoutEditor.unlockAll" })
    .click();
  await page.waitForFunction(() => !document.querySelector("[data-layout-locked]"));
  assert.equal(await page.locator("[data-layout-locked-hint]").count(), 0, "Unlock all clears the hint");
  assert.equal((await stored("map")).locked, false, "Unlock all persists");

  // Drag from anywhere on the panel; the content underneath is not clicked.
  const drag = async (locator, dx, dy, { hold } = {}) => {
    const box = await locator.boundingBox();
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + dx, startY + dy, { steps: 12 });
    if (hold) await hold();
    await page.mouse.up();
    await page.waitForTimeout(260);
  };
  const before = await position(alpha);
  await drag(alpha, 150, 64);
  const after = await position(alpha);
  assert.ok(Math.abs(after.x - before.x - 150) <= 16 && Math.abs(after.y - before.y - 64) <= 16, "drag anywhere moves");
  assert.equal(await page.evaluate(() => window.contentClicks), 1, "dragging over content never clicks it");
  assert.equal((await stored("widget:alpha")).x, after.x, "the drop position persists");

  // Smart snapping: bring alpha's left edge near the map's left edge, see a guide, land exactly on it.
  const mapBox = await position(map);
  const current = await position(alpha);
  await drag(alpha, mapBox.x + 5 - current.x, 20, {
    hold: async () => {
      assert.ok((await page.locator('[data-layout-guide="x"]').count()) >= 1, "a vertical guide shows while snapped");
    },
  });
  assert.equal((await position(alpha)).x, mapBox.x, "the left edge snaps to the neighbour's left edge");
  assert.equal(await page.locator("[data-layout-guides]").count(), 0, "guides disappear on release");

  // Overlap: the panel moves over a neighbour with a highlight, then settles into free space.
  const alphaNow = await position(alpha);
  await drag(alpha, mapBox.x + 40 - alphaNow.x, mapBox.y + 30 - alphaNow.y, {
    hold: async () => {
      assert.equal(await alpha.getAttribute("data-layout-overlapping"), "true", "overlap is highlighted");
      assert.ok((await page.locator("[data-layout-overlap]").count()) >= 1, "the overlap area is drawn");
      assert.equal(await page.locator("[data-layout-settle-preview]").count(), 1, "the settle spot is previewed");
    },
  });
  const settled = await position(alpha);
  const mapAfter = await position(map);
  assert.deepEqual(mapAfter, mapBox, "a manual drag never moves another panel");
  const overlaps =
    settled.x < mapAfter.x + mapAfter.width &&
    settled.x + settled.width > mapAfter.x &&
    settled.y < mapAfter.y + mapAfter.height &&
    settled.y + settled.height > mapAfter.y;
  assert.ok(!overlaps, "the dropped panel settles into the nearest free spot");

  // Collisions off: the panel phases through and stays where it was dropped.
  await page.locator('[data-layout-tool="collisions"]').click();
  assert.equal(await page.locator('[data-layout-tool="collisions"]').getAttribute("aria-pressed"), "false");
  const phaseFrom = await position(alpha);
  await drag(alpha, mapBox.x + 48 - phaseFrom.x, mapBox.y + 32 - phaseFrom.y);
  const phased = await position(alpha);
  assert.ok(
    phased.x < mapAfter.x + mapAfter.width && phased.y < mapAfter.y + mapAfter.height,
    "with collisions off panels may overlap",
  );
  await page.waitForTimeout(300);
  assert.deepEqual(await position(alpha), phased, "the resolver keeps an intentional overlap");
  await page.locator('[data-layout-tool="collisions"]').click();
  await page.waitForTimeout(200);
  const reflowed = await position(alpha);
  await drag(alpha, 600 - reflowed.x, 128 - reflowed.y);

  // Resize from edges and corners, with a live size badge.
  const resizeBy = async (handle, dx, dy) => {
    const box = await alpha.locator(`[data-panel-resize-handle="${handle}"]`).boundingBox();
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + dx, startY + dy, { steps: 8 });
    assert.equal(await alpha.locator("[data-panel-size-badge]").count(), 1, `${handle}: the size badge shows`);
    await page.mouse.up();
    await page.waitForTimeout(150);
  };
  assert.equal(await alpha.locator("[data-panel-resize-handle]").count(), 8, "eight resize handles");
  const beforeResize = await position(alpha);
  await resizeBy("e", 80, 0);
  const wider = await position(alpha);
  assert.ok(Math.abs(wider.width - beforeResize.width - 80) <= 16, "the right edge resizes width");
  assert.equal(wider.x, beforeResize.x, "the left edge stays put");
  await resizeBy("s", 0, 30);
  const taller = await position(alpha);
  assert.ok(Math.abs(taller.height - wider.height - 30) <= 16, "the bottom edge resizes height of an autoGrow panel");
  assert.equal(
    await page.evaluate(() => localStorage.getItem("marinara-game-panel:fixture:floating:widget:alpha:size-v2:growth")),
    "fixed",
    "a manual height switches growth to fixed so content cannot undo it",
  );
  await resizeBy("nw", -72, -48);
  const corner = await position(alpha);
  assert.ok(corner.width > taller.width + 20 && corner.height > taller.height + 20, "a corner resizes both axes");
  assert.ok(corner.x < taller.x && corner.y < taller.y, "the top-left corner moves the origin");

  // Options popover: opens from the chip, Esc closes it without leaving edit mode.
  const optionsButton = alpha.getByRole("button", { name: "ui.game.layoutEditor.options" });
  await optionsButton.click();
  const options = page.getByRole("dialog", { name: "ui.game.layoutEditor.options" });
  await options.waitFor();
  assert.equal(await options.getByRole("radiogroup", { name: "ui.game.floatingPanel.growth" }).count(), 1);
  assert.equal(await options.getByRole("radiogroup", { name: "ui.game.floatingPanel.tuckEdge" }).count(), 1);
  await page.keyboard.press("Escape");
  await options.waitFor({ state: "detached" });
  assert.equal(await page.locator("[data-layout-toolbar]").count(), 1, "Esc closes the popover first");
  await optionsButton.click();
  await options.waitFor();
  await page.mouse.click(surfaceBox.x + 880, surfaceBox.y + 580);
  await options.waitFor({ state: "detached" });
  await optionsButton.click();
  await options.getByRole("button", { name: "ui.game.panellockbutton.lockPanel" }).click();
  await page.waitForFunction(() =>
    document.querySelector('[data-game-floating-panel="widget:alpha"]')?.hasAttribute("data-layout-locked"),
  );
  await page.keyboard.press("Escape");
  await options.waitFor({ state: "detached" });

  // Undo and redo, one step per committed change.
  await page.waitForTimeout(200);
  await page.keyboard.press("Control+z");
  await page.waitForFunction(
    () => !document.querySelector('[data-game-floating-panel="widget:alpha"]')?.hasAttribute("data-layout-locked"),
  );
  await page.keyboard.press("Control+Shift+z");
  await page.waitForFunction(() =>
    document.querySelector('[data-game-floating-panel="widget:alpha"]')?.hasAttribute("data-layout-locked"),
  );
  await page.keyboard.press("Control+z");
  await page.waitForFunction(
    () => !document.querySelector('[data-game-floating-panel="widget:alpha"]')?.hasAttribute("data-layout-locked"),
  );
  const cornerAgain = await position(alpha);
  await page.keyboard.press("Control+z");
  await page.waitForFunction(
    (width) =>
      Math.abs(
        document.querySelector('[data-game-floating-panel="widget:alpha"]').getBoundingClientRect().width - width,
      ) > 10,
    cornerAgain.width,
  );
  assert.ok(Math.abs((await position(alpha)).width - taller.width) <= 1, "undo restores the previous resize");

  // Panels menu: hide and bring back.
  await page.locator('[data-layout-tool="panels"]').click();
  const panelsMenu = page.getByRole("dialog", { name: "ui.game.layoutEditor.panels" });
  await panelsMenu.waitFor();
  assert.equal(
    await panelsMenu.locator('[data-layout-panel-row="widget:alpha"]').getByRole("switch").getAttribute("aria-checked"),
    "true",
  );
  assert.equal(await panelsMenu.locator('[data-layout-panel-row="map"]').getByRole("switch").count(), 1);
  await panelsMenu.locator('[data-layout-panel-row="widget:alpha"]').getByRole("switch").click();
  await alpha.waitFor({ state: "detached" });
  assert.equal(await page.locator("[data-layout-hidden-count]").textContent(), "1", "the toolbar counts hidden panels");
  assert.equal(
    await panelsMenu.locator('[data-layout-panel-row="widget:alpha"]').count(),
    1,
    "hidden panels stay listed so they are easy to bring back",
  );
  await panelsMenu.locator('[data-layout-panel-row="widget:alpha"]').getByRole("switch").click();
  await alpha.waitFor();
  await page.keyboard.press("Escape");
  await panelsMenu.waitFor({ state: "detached" });

  // Saved layouts: save, move, apply restores.
  await page.locator('[data-layout-tool="layouts"]').click();
  const layoutsMenu = page.getByRole("dialog", { name: "ui.game.layoutEditor.layouts" });
  await layoutsMenu.getByRole("textbox", { name: "ui.game.layoutEditor.layoutName" }).fill("Fixture layout");
  await layoutsMenu.locator("[data-layout-save]").click();
  await layoutsMenu.locator('[data-layout-saved="Fixture layout"]').waitFor();
  await page.keyboard.press("Escape");
  const savedAt = await position(alpha);
  await drag(alpha, -120, -80);
  assert.notDeepEqual(await position(alpha), savedAt);
  await page.locator('[data-layout-tool="layouts"]').click();
  await layoutsMenu.getByRole("button", { name: "ui.game.layoutEditor.applyLayout" }).click();
  await page.waitForTimeout(200);
  const restoredLayout = await position(alpha);
  assert.ok(
    Math.abs(restoredLayout.x - savedAt.x) <= 1 && Math.abs(restoredLayout.y - savedAt.y) <= 1,
    "apply restores",
  );
  assert.equal(
    (await page.evaluate(() => JSON.parse(localStorage.getItem("marinara-game-layouts:v1"))))[0].name,
    "Fixture layout",
    "saved layouts are stored globally",
  );

  // Keyboard: arrow keys still move from the chip handle.
  const handle = alpha.getByRole("button", { name: "ui.game.floatingPanel.move" });
  const beforeKeys = await position(alpha);
  await handle.focus();
  await page.keyboard.press("Shift+ArrowLeft");
  assert.equal((await position(alpha)).x, beforeKeys.x - 40, "Shift+Arrow moves by a bigger step");

  // Esc with no popover open leaves edit mode.
  await page.keyboard.press("Escape");
  await page.locator("[data-layout-toolbar]").waitFor({ state: "detached" });
  assert.equal(await page.locator("[data-panel-layout-controls]").count(), 0, "Done removes all edit chrome");
  await alpha.getByRole("button", { name: "Alpha content" }).click();
  assert.equal(await page.evaluate(() => window.contentClicks), 2, "content is interactive again");

  // Locked layouts follow surface resizes by their relative anchors (legacy behaviour).
  await page.evaluate(() => {
    localStorage.setItem("marinara-game-panel:fixture:floating:map", JSON.stringify({ locked: true, x: 320, y: 280 }));
  });
  await page.reload();
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await map.waitFor();
  const original = await map.boundingBox();
  await map.evaluate((element) => {
    element.parentElement.style.width = "580px";
    element.parentElement.style.height = "400px";
  });
  await page.waitForFunction(() => {
    const panel = document.querySelector("[data-game-floating-panel=map]");
    return Math.abs(panel.getBoundingClientRect().left - panel.parentElement.getBoundingClientRect().left - 160) < 2;
  });
  const smaller = await map.boundingBox();
  assert.ok(smaller.y < original.y, "Vertical position follows the smaller surface while locked");
  await map.evaluate((element) => {
    element.parentElement.style.width = "900px";
    element.parentElement.style.height = "600px";
  });
  await page.waitForFunction(() => {
    const panel = document.querySelector("[data-game-floating-panel=map]");
    return Math.abs(panel.getBoundingClientRect().left - panel.parentElement.getBoundingClientRect().left - 320) < 2;
  });
  const restored = await map.boundingBox();
  assert.ok(Math.abs(restored.y - original.y) < 2, "Growing restores relative vertical placement");
  console.info(
    "Layout editor browser fixture passed: edit chrome, unlock-all hint, drag anywhere, snap guides, overlap settle, collisions off, 8-way resize, options popover, undo/redo, hide/show, saved layouts, keyboard, Esc.",
  );
} finally {
  await browser.close();
}
