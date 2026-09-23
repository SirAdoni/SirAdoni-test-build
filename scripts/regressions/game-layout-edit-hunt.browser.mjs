import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { resolve } from "node:path";

// Edit layout bug-hunt fixture: the real FloatingGamePanel + GameLayoutEditToolbar, two layout
// scopes (chat switching resets editing, as GameSurface does), and three stacked widgets.
const panelSource = resolve("packages/client/src/components/game/FloatingGamePanel.tsx").replaceAll("\\", "/");
const toolbarSource = resolve("packages/client/src/components/game/GameLayoutEditToolbar.tsx").replaceAll("\\", "/");
const bundle = await build({
  stdin: {
    contents: `
      import React, { useEffect, useRef, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { FloatingGamePanel, GamePanelContext } from '${panelSource}';
      import { GameLayoutEditToolbar } from '${toolbarSource}';
      function App() {
        const surface = useRef(null);
        const [scope, setScope] = useState('hunt-a');
        const [layoutEditing, setEditing] = useState(false);
        const [layoutRevision, setRevision] = useState(0);
        const [value, setValue] = useState(1);
        useEffect(() => setEditing(false), [scope]);
        return <>
          <button id="edit" aria-pressed={layoutEditing} onClick={() => setEditing((v) => !v)}>Toggle editing</button>
          <button id="scope" onClick={() => setScope((s) => (s === 'hunt-a' ? 'hunt-b' : 'hunt-a'))}>{scope}</button>
          <textarea id="composer" aria-label="Composer"></textarea>
          <button id="bump" onClick={() => setValue((v) => v + 1)}>Bump value</button>
          <div ref={surface} style={{ position: 'relative', height: 640, width: 1100, overflow: 'hidden' }}>
            <GamePanelContext.Provider value={{ chatId: scope, surface, layoutEditing, layoutRevision }}>
              <FloatingGamePanel id="widget:alpha" width={240} tuckLabel="Alpha" allowTuck revealOnValueChangeKey={String(value)}>
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
          contents: "export const useTranslation=()=>({t:key=>key});",
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
  await page.route("http://hunt.fixture/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<style>[data-game-floating-panel]{position:absolute;top:0;left:0}</style><body style="margin:0"><div id="root"></div></body>',
    }),
  );
  await page.goto("http://hunt.fixture/");
  await page.evaluate(() => {
    localStorage.clear();
    const put = (scope, id, x, y) =>
      localStorage.setItem(
        `marinara-game-panel:${scope}:floating:${id}`,
        JSON.stringify({ locked: false, x, y, surfaceWidth: 1100, surfaceHeight: 640 }),
      );
    for (const scope of ["hunt-a", "hunt-b"]) {
      // Alpha and beta are stacked tightly: one resolver gap between them.
      put(scope, "widget:alpha", 40, 120);
      put(scope, "widget:beta", 40, 228);
      put(scope, "map", 600, 200);
    }
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const alpha = page.locator('[data-game-floating-panel="widget:alpha"]');
  const beta = page.locator('[data-game-floating-panel="widget:beta"]');
  const map = page.locator("[data-game-floating-panel=map]");
  await map.waitFor();
  await page.waitForTimeout(200);
  const surfaceBox = await page.evaluate(() => {
    const rect = document.querySelector("[data-game-floating-panel=map]").parentElement.getBoundingClientRect();
    return { x: rect.x, y: rect.y };
  });
  const position = async (locator) => {
    const box = await locator.boundingBox();
    return { x: box.x - surfaceBox.x, y: box.y - surfaceBox.y, width: box.width, height: box.height };
  };
  const intersects = (a, b) =>
    a.x < b.x + b.width - 0.5 && a.x + a.width > b.x + 0.5 && a.y < b.y + b.height - 0.5 && a.y + a.height > b.y + 0.5;
  const startDrag = async (locator, dx, dy) => {
    const box = await locator.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 10 });
  };
  const editButton = page.locator("#edit");
  await editButton.click();
  await page.locator("[data-layout-toolbar]").waitFor();

  // 1. Name tags on tightly stacked panels stay inside their own panel instead of covering
  //    the bottom edge of the panel above.
  const betaChip = await beta.locator("[data-panel-layout-controls]").boundingBox();
  const alphaBox = await alpha.boundingBox();
  assert.ok(
    !intersects(
      { x: betaChip.x, y: betaChip.y, width: betaChip.width, height: betaChip.height },
      { x: alphaBox.x, y: alphaBox.y, width: alphaBox.width, height: alphaBox.height },
    ),
    "beta's name tag does not cover alpha",
  );
  const mapChip = await map.locator("[data-panel-layout-controls]").boundingBox();
  const mapBox = await map.boundingBox();
  assert.ok(mapChip.y < mapBox.y, "a panel with room above keeps its tag on the top border");

  // 2. Esc during a drag cancels the drag and stays in edit mode.
  const alphaStart = await position(alpha);
  const storedBefore = await page.evaluate(() =>
    localStorage.getItem("marinara-game-panel:hunt-a:floating:widget:alpha"),
  );
  await startDrag(alpha, 300, 40);
  assert.ok((await position(alpha)).x > alphaStart.x + 100, "the drag is under way");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.waitForTimeout(250);
  assert.deepEqual(await position(alpha), alphaStart, "Esc puts the dragged panel back");
  assert.equal(await editButton.getAttribute("aria-pressed"), "true", "Esc during a drag does not leave edit mode");
  assert.equal(await page.locator("[data-layout-guides]").count(), 0, "the drag overlay is cleared");
  assert.equal(
    await page.evaluate(() => localStorage.getItem("marinara-game-panel:hunt-a:floating:widget:alpha")),
    storedBefore,
    "a cancelled drag persists nothing",
  );
  // The automatic resolver still runs afterwards: an overlap made with collisions off is
  // separated once collisions are switched back on.
  await page.locator('[data-layout-tool="collisions"]').click();
  const mapPos = await position(map);
  const betaPos = await position(beta);
  await startDrag(beta, mapPos.x + 30 - betaPos.x, mapPos.y + 20 - betaPos.y);
  await page.mouse.up();
  await page.waitForTimeout(250);
  assert.ok(intersects(await position(beta), await position(map)), "collisions off allows the overlap");
  await page.locator('[data-layout-tool="collisions"]').click();
  await page.waitForTimeout(300);
  assert.ok(!intersects(await position(beta), await position(map)), "the resolver is not left suspended");

  // 3. Undo during a drag: panels remount from storage and the resolver is released.
  await startDrag(alpha, 200, 0);
  await page.keyboard.press("Control+z");
  await page.mouse.up();
  await page.waitForTimeout(300);
  await page.locator('[data-layout-tool="collisions"]').click();
  const betaNow = await position(beta);
  const mapNow = await position(map);
  await startDrag(beta, mapNow.x + 30 - betaNow.x, mapNow.y + 20 - betaNow.y);
  await page.mouse.up();
  await page.waitForTimeout(250);
  await page.locator('[data-layout-tool="collisions"]').click();
  await page.waitForTimeout(300);
  assert.ok(!intersects(await position(beta), await position(map)), "undo during a drag does not freeze reflow");
  assert.equal(await page.locator("[data-layout-guides]").count(), 0, "undo during a drag clears the overlay");

  // 4. Ctrl+Z while typing in the composer is the text field's own undo.
  const historyBefore = await page.evaluate(() => localStorage.getItem("marinara-game-panel:hunt-a:floating:map"));
  await page.locator("#composer").click();
  await page.keyboard.type("hello");
  await page.keyboard.press("Control+z");
  assert.equal(
    await page.evaluate(() => localStorage.getItem("marinara-game-panel:hunt-a:floating:map")),
    historyBefore,
    "Ctrl+Z in a text field does not undo the layout",
  );

  // 5. Switching chats while editing ends that chat's edit session. Returning later starts a
  //    fresh undo baseline, so a change made outside edit mode is not undone.
  const moveHandle = alpha.getByRole("button", { name: "ui.game.floatingPanel.move" });
  await moveHandle.focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(700);
  await page.locator("#scope").click();
  await page.waitForTimeout(200);
  await page.locator("#scope").click();
  await page.waitForTimeout(200);
  assert.equal(await editButton.getAttribute("aria-pressed"), "false", "switching chats leaves edit mode");
  await page.evaluate(() =>
    localStorage.setItem("marinara-game-panel:hunt-a:floating:widget:beta:outside-edit", "kept"),
  );
  await editButton.click();
  await page.locator("[data-layout-toolbar]").waitFor();
  await alpha.getByRole("button", { name: "ui.game.floatingPanel.move" }).focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(700);
  await page.locator('[data-layout-tool="undo"]').click();
  await page.waitForTimeout(200);
  assert.equal(
    await page.evaluate(() => localStorage.getItem("marinara-game-panel:hunt-a:floating:widget:beta:outside-edit")),
    "kept",
    "undo after returning to a chat only reverts this session's edits",
  );

  // 6. Stack menu: the current stack option is localized.
  await alpha.locator("[data-panel-options-button]").click();
  const options = page.getByRole("dialog", { name: /ui\.game\.layoutEditor\.options/ });
  await options.waitFor();
  await options.getByRole("button", { name: "ui.game.floatingPanel.newStack" }).click();
  await page.waitForTimeout(200);
  if (!(await options.count())) await alpha.locator("[data-panel-options-button]").click();
  const optionTexts = await page
    .getByRole("dialog", { name: /ui\.game\.layoutEditor\.options/ })
    .locator("select option")
    .allTextContents();
  assert.ok(
    optionTexts.every((text) => !text.includes("This widget stack")),
    `stack options carry no hard-coded English (${optionTexts.join(" / ")})`,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);

  // 6b. A stacked member's edge is not blocked by its own stack sibling: growing the top
  //     member pushes the member below down instead of stopping one gap short of it.
  await beta.locator("[data-panel-options-button]").click();
  const betaOptions = page.getByRole("dialog", { name: /ui\.game\.layoutEditor\.options/ });
  await betaOptions.waitFor();
  const stackSelect = betaOptions.locator("select");
  const alphaGroup = await stackSelect
    .locator("option")
    .evaluateAll((items) => items.map((item) => item.value).find((value) => value.includes("widget:alpha")));
  await stackSelect.selectOption(alphaGroup);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const stackedAlpha = await position(alpha);
  const stackedBeta = await position(beta);
  assert.ok(stackedBeta.y >= stackedAlpha.y + stackedAlpha.height, "beta sits below alpha in the stack");
  const handle = await alpha.locator('[data-panel-resize-handle="s"]').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 + 60, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const grownAlpha = await position(alpha);
  const pushedBeta = await position(beta);
  assert.ok(
    grownAlpha.height >= stackedAlpha.height + 40,
    `the stacked member grows (${stackedAlpha.height} -> ${grownAlpha.height})`,
  );
  assert.ok(!intersects(grownAlpha, pushedBeta), "the member below moves down with the stack");

  // 6c. A value-change reveal still closes after five seconds when the tuck edge changes
  //     while it is open (the edge change used to cancel the close timer for good).
  await alpha.locator("[data-panel-options-button]").click();
  await page
    .getByRole("dialog", { name: /ui\.game\.layoutEditor\.options/ })
    .getByRole("button", { name: "ui.game.floatingPanel.tuck" })
    .click();
  await page.waitForTimeout(200);
  await editButton.click();
  await page.mouse.move(1200, 780);
  assert.ok((await alpha.boundingBox()).width <= 40, "alpha is tucked");
  await page.locator("#bump").click();
  await page.mouse.move(1200, 780);
  await page.waitForTimeout(200);
  assert.ok((await alpha.boundingBox()).width > 100, "a value change reveals the tucked widget");
  await editButton.click();
  await alpha.locator("[data-panel-options-button]").click();
  await page
    .getByRole("dialog", { name: /ui\.game\.layoutEditor\.options/ })
    .getByRole("radio", { name: "ui.game.floatingPanel.tuckRight" })
    .click();
  await page.keyboard.press("Escape");
  await editButton.click();
  await page.mouse.move(1200, 780);
  await page.waitForTimeout(5400);
  assert.ok((await alpha.boundingBox()).width <= 40, "the reveal closes after five seconds");
  await editButton.click();
  await page.locator("[data-layout-toolbar]").waitFor();

  // 7. Tablets (768-1023px) keep panels inline: editing ends instead of leaving an invisible mode.
  await page.setViewportSize({ width: 900, height: 800 });
  await page.waitForTimeout(300);
  assert.equal(await editButton.getAttribute("aria-pressed"), "false", "edit mode ends below the desktop width");
  assert.equal(await page.locator("[data-layout-toolbar]").count(), 0, "no layout toolbar on tablets");

  assert.deepEqual(errors, [], "no page errors");
  console.info("Game layout edit hunt fixture passed: tags, Esc/undo mid-drag, composer undo, chat switch, tablets");
} finally {
  await browser.close();
}
