import assert from "node:assert/strict";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { startFixtureServer, stopFixtureServer } from "../lib/fixture-server.mjs";

// Screenshots land here; set GAME_HUD_SCREENSHOT_DIR to keep them.
const screenshotDir = process.env.GAME_HUD_SCREENSHOT_DIR || os.tmpdir();
let fixture;
let browser;
const geometryObservations = [];

async function runMobileWidgetAssertions(page, base) {
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 780 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`${base}/?mobile=1`);
    const tray = page.locator("[data-mobile-widget-tray]");
    await tray.waitFor();
    const buttons = tray.locator("button:not([data-mobile-arrange-button]):not([data-mobile-tray-scroll])");
    assert.equal(await buttons.count(), 6, `${viewport.width}: all mobile widget buttons render`);
    const firstBox = await buttons.nth(0).boundingBox();
    const lastBox = await buttons.nth(5).boundingBox();
    assert.ok(firstBox && firstBox.height >= 44 && firstBox.width >= 44, `${viewport.width}: first target is 44px`);
    assert.ok(lastBox && lastBox.height >= 44 && lastBox.width >= 44, `${viewport.width}: last target is 44px`);
    assert.equal(Math.round(firstBox.y), Math.round(lastBox.y), `${viewport.width}: widgets stay in one row`);
    const trayBefore = await tray.boundingBox();
    assert.ok(trayBefore, `${viewport.width}: tray has a bounding box`);
    await buttons.nth(4).scrollIntoViewIfNeeded();
    await buttons.nth(4).click();
    const dialog = page.getByRole("dialog").last();
    await dialog.waitFor();
    const panel = dialog.locator(".mari-modal-panel");
    const dialogBox = await panel.boundingBox();
    assert.ok(dialogBox, `${viewport.width}: expanded widget modal panel is visible`);
    assert.ok(
      dialogBox.x >= 0 && dialogBox.y >= 0,
      `${viewport.width}: modal panel stays within top-left viewport bounds`,
    );
    assert.ok(
      dialogBox.x + dialogBox.width <= viewport.width + 1 && dialogBox.y + dialogBox.height <= viewport.height + 1,
      `${viewport.width}: expanded widget modal stays within viewport`,
    );
    const trayAfter = await tray.boundingBox();
    assert.ok(
      trayAfter && Math.abs(trayAfter.height - trayBefore.height) <= 1,
      `${viewport.width}: modal does not resize tray`,
    );
    assert.equal(
      await panel.getByRole("button", { name: /edit/i }).count(),
      1,
      `${viewport.width}: edit action is present`,
    );
    assert.equal(
      await panel.getByRole("button", { name: /collapse/i }).count(),
      1,
      `${viewport.width}: collapse action is present`,
    );
    await dialog.getByRole("button", { name: /close/i }).click();
    await dialog.waitFor({ state: "hidden" });
    await buttons.nth(5).scrollIntoViewIfNeeded();
    const lastReachableBox = await buttons.nth(5).boundingBox();
    assert.ok(
      lastReachableBox &&
        lastReachableBox.x >= 0 &&
        lastReachableBox.x + lastReachableBox.width <= viewport.width &&
        lastReachableBox.y >= 0 &&
        lastReachableBox.y + lastReachableBox.height <= viewport.height,
      `${viewport.width}: last widget remains reachable in the viewport after scroll`,
    );
    await buttons.nth(5).click();
    const lastDialog = page.getByRole("dialog").last();
    await lastDialog.waitFor();
    await lastDialog.getByRole("button", { name: /close/i }).click();
    await lastDialog.waitFor({ state: "hidden" });
  }
  await runMobileArrangeAssertions(page, base);
  await runMobileTrayFitAssertions(page, base);
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log("mobile widget fixture passed: horizontal row, 44px targets, scroll reachability, bounded modal");
}

/** Tabs fully inside the tray's scroll window or fully outside it; none is cut mid-button. */
function clippedTrayTabs() {
  const tray = document.querySelector("[data-mobile-widget-tray]");
  const box = tray.querySelector("[data-mobile-tray-scroller]").getBoundingClientRect();
  return [...tray.querySelectorAll("button")].flatMap((button) => {
    const rect = button.getBoundingClientRect();
    const visible = Math.min(rect.right, box.right, innerWidth) - Math.max(rect.left, box.left, 0);
    return visible > 1 && visible < rect.width - 1
      ? [`${button.getAttribute("aria-label")} ${Math.round(visible)}`]
      : [];
  });
}

async function runMobileTrayFitAssertions(page, base) {
  for (const [width, height] of [
    [320, 568],
    [360, 740],
    [390, 844],
    [412, 915],
    [844, 390],
    [915, 412],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto(`${base}/?mobile=1`);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    const tray = page.locator("[data-mobile-widget-tray]");
    await tray.waitFor();
    await page.waitForTimeout(100);
    const tag = `${width}x${height}`;
    assert.equal(
      await page.evaluate(() => document.scrollingElement.scrollWidth),
      width,
      `${tag}: no page-level horizontal overflow`,
    );
    const scrollbar = await tray
      .locator("[data-mobile-tray-scroller]")
      .evaluate((node) => node.offsetHeight - node.clientHeight);
    assert.equal(scrollbar, 0, `${tag}: the tray draws no scrollbar`);
    assert.deepEqual(await page.evaluate(clippedTrayTabs), [], `${tag}: no clipped tab at rest`);
    const arrange = tray.locator("[data-mobile-arrange-button]");
    const arrangeBox = await arrange.boundingBox();
    assert.ok(arrangeBox && arrangeBox.x + arrangeBox.width <= width, `${tag}: Arrange is on screen without scrolling`);
    const pager = tray.locator("[data-mobile-tray-scroll]");
    const overflowing = await page.evaluate(() => {
      const node = document.querySelector("[data-mobile-tray-scroller]");
      return node.scrollWidth > node.clientWidth + 1;
    });
    assert.equal(await pager.count(), overflowing ? 1 : 0, `${tag}: the pager shows only when tabs overflow`);
    if (!overflowing) continue;
    assert.match((await pager.textContent()) ?? "", /\+\d/, `${tag}: the pager counts the hidden tabs`);
    const mask = await tray.locator("[data-mobile-tray-scroller]").evaluate((node) => node.style.maskImage);
    assert.match(mask, /transparent\)$/, `${tag}: the trailing edge fades while more tabs wait`);
    for (let step = 0; step < 6 && (await pager.getAttribute("aria-label")) === "Show more widgets"; step++) {
      await pager.click();
      await page.waitForTimeout(600);
      assert.deepEqual(await page.evaluate(clippedTrayTabs), [], `${tag}: no clipped tab after paging`);
    }
    assert.equal(await pager.getAttribute("aria-label"), "Back to the first widgets", `${tag}: paging reaches the end`);
    const last = tray.locator("button:not([data-mobile-arrange-button]):not([data-mobile-tray-scroll])").last();
    const lastBox = await last.boundingBox();
    assert.ok(lastBox && lastBox.x + lastBox.width <= width, `${tag}: the last tab is reachable by paging`);
    await page.screenshot({ path: `${screenshotDir}/mobile-tray-paged-${tag}.png` });
  }
  console.log("mobile tray fit passed: whole tabs, no scrollbar, edge fade, pager, Arrange on screen");
}

async function runMobileArrangeAssertions(page, base) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/?mobile=1`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const tray = page.locator("[data-mobile-widget-tray]");
  await tray.waitFor();
  const pills = tray.locator("button:not([data-mobile-arrange-button]):not([data-mobile-tray-scroll])");
  const labels = async () => pills.evaluateAll((items) => items.map((item) => item.getAttribute("aria-label")));
  assert.deepEqual(await labels(), ["Left 1", "Left 2", "Left 3", "Left 4", "Left 5", "Right 1"]);
  const arrange = tray.getByRole("button", { name: "Arrange widgets" });
  await arrange.scrollIntoViewIfNeeded();
  const arrangeBox = await arrange.boundingBox();
  assert.ok(arrangeBox && arrangeBox.width >= 40 && arrangeBox.height >= 40, "arrange button is a 40px target");
  await arrange.click();
  const sheet = page.getByRole("dialog", { name: "Arrange widgets" });
  await sheet.waitFor();
  // Layout sizes, not bounding boxes: the modal's open animation scales the panel.
  const sizes = await sheet
    .locator("[data-mobile-arrange-item] button")
    .evaluateAll((items) => items.map((item) => [item.offsetWidth, item.offsetHeight]));
  assert.equal(sizes.length, 18, "six rows with up, down and hide controls");
  assert.ok(sizes.every(([w, h]) => w >= 40 && h >= 40), `arrange sheet controls are 40px targets ${JSON.stringify(sizes)}`);
  assert.ok(await sheet.getByRole("button", { name: "Move Left 1 up" }).isDisabled(), "first item cannot move up");
  await sheet.getByRole("button", { name: "Move Left 3 up" }).click();
  await sheet.getByRole("button", { name: "Move Left 3 up" }).click();
  await sheet.getByRole("button", { name: "Hide Left 5" }).click();
  await sheet.getByRole("button", { name: "Show Left 5" }).waitFor();
  await page.screenshot({ path: `${screenshotDir}/mobile-arrange-sheet-390.png` });
  // The tray behind the sheet updates live because both rails share one hook.
  assert.deepEqual(await labels(), ["Left 3", "Left 1", "Left 2", "Left 4", "Right 1"], "reorder and hide apply live");
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });
  await page.reload();
  await tray.waitFor();
  assert.deepEqual(await labels(), ["Left 3", "Left 1", "Left 2", "Left 4", "Right 1"], "reorder persists, hidden stays hidden");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `no horizontal page scroll at 390px (overflow=${overflow})`);
  await page.screenshot({ path: `${screenshotDir}/mobile-arrange-tray-390.png` });
  await page.evaluate(() => localStorage.clear());
  console.log("mobile arrange fixture passed: reorder persists, hidden stays hidden, 40px targets, no page scroll");
}

try {
  fixture = startFixtureServer(fileURLToPath(new URL("component-server.mjs", import.meta.url)));
  const { base } = await fixture.ready;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // Per-panel layout options (collapse to edge, edge, bottom pin) live in the chip's options popover.
  const optionsDialog = () => page.getByRole("dialog", { name: /options for/i });
  const panelOptions = async (panel) => {
    const button = panel.locator("[data-panel-options-button]").first();
    if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
    await optionsDialog().waitFor();
    return optionsDialog();
  };
  const closeOptions = async () => {
    if (!(await optionsDialog().count())) return;
    await page.keyboard.press("Escape");
    await optionsDialog().waitFor({ state: "detached" });
  };
  const collapseViaOptions = async (panel) => {
    const dialog = await panelOptions(panel);
    await dialog.getByRole("button", { name: /collapse to edge/i }).click();
    await dialog.waitFor({ state: "detached" });
  };
  const setTuckEdge = async (panel, edge) => {
    const dialog = await panelOptions(panel);
    await dialog.getByRole("radio", { name: new RegExp(`^${edge} edge$`, "i") }).click();
    await closeOptions();
  };
  await runMobileWidgetAssertions(page, base);
  await page.goto(base);
  await page.getByText("Real NPC", { exact: true }).waitFor();
  let contact = page.getByRole("dialog").last();
  assert.equal(await contact.getByText(/Recorded opinion: 0/).count(), 1, "numeric zero opinion renders");
  assert.match(await contact.innerText(), /Relationship status: Friend/, "friend status renders");
  assert.match(
    await contact.locator("article").filter({ hasText: "Unknown" }).innerText(),
    /Recorded opinion: Unknown[\s\S]*Relationship status: Unknown/,
    "missing opinion and relationship stay unknown on the second contact",
  );
  await page.screenshot({ path: `${screenshotDir}/contact-book-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileContactPanel = contact.locator(".mari-modal-panel");
  const mobileContactBox = await mobileContactPanel.boundingBox();
  assert.ok(
    mobileContactBox &&
      mobileContactBox.x >= 0 &&
      mobileContactBox.y >= 0 &&
      mobileContactBox.x + mobileContactBox.width <= 391 &&
      mobileContactBox.y + mobileContactBox.height <= 845,
    "contact book fits a phone viewport",
  );
  await contact.getByText(/Relationship status: Friend/).waitFor();
  await page.screenshot({ path: `${screenshotDir}/contact-book-mobile.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await contact.getByRole("button", { name: "Real NPC", exact: true }).click();
  assert.equal(
    await page.locator("[data-profile-callback]").textContent(),
    "char-real",
    "profile callback receives character id",
  );

  await page.reload();
  await page.getByText("Real NPC", { exact: true }).waitFor();
  contact = page.getByRole("dialog").last();
  const name = contact.locator("aside input").first();
  await name.fill("Parent");
  await contact.getByRole("button", { name: /add category/i }).click();
  await name.fill("Child");
  await contact.getByRole("combobox", { name: /parent category/i }).selectOption({ label: "Parent" });
  await contact.getByRole("button", { name: /add category/i }).click();
  const article = contact.locator("article").filter({ hasText: "Real NPC" });
  await article.locator("select").first().selectOption({ label: "Child" });
  await contact.getByRole("button", { name: "Parent", exact: true }).click();
  assert.equal(await article.count(), 1, "nested parent category includes child contact");

  await page.keyboard.press("Escape");
  await contact.waitFor({ state: "hidden" });
  const photo = page.locator("[data-character-photo-fixture]");
  const openButton = photo.getByRole("button", { name: "Open Real NPC photo" });
  assert.equal(
    await photo.getByRole("button", { name: "Update Real NPC photo" }).count(),
    0,
    "thumbnail does not render an update camera",
  );
  assert.equal(await photo.locator("[data-photo-updates]").textContent(), "0", "photo update starts idle");
  await openButton.click();
  await page.getByRole("button", { name: /close image/i }).waitFor();
  assert.equal(await photo.locator("[data-photo-updates]").textContent(), "0", "photo preview does not update");
  const viewerUpdateButton = page.getByRole("button", { name: "Update Real NPC photo" });
  assert.equal(await viewerUpdateButton.isEnabled(), true, "viewer update camera is enabled");
  await viewerUpdateButton.click();
  await page.getByRole("button", { name: /close image/i }).waitFor({ state: "hidden" });
  assert.equal(await photo.locator("[data-photo-updates]").textContent(), "1", "viewer update invokes callback");
  await openButton.focus();
  await openButton.click();
  await page.getByRole("button", { name: /close image/i }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /close image/i }).waitFor({ state: "hidden" });
  assert.equal(await photo.locator("[data-photo-updates]").textContent(), "1", "viewer close does not update");
  const customWidget = page.locator('[data-game-floating-widget="open-file"]');
  await customWidget.waitFor();
  assert.match(await customWidget.textContent(), /Open File/, "real custom widget renders");
  await collapseViaOptions(customWidget);
  const customTab = customWidget.locator("[data-game-tuck-tab]");
  await customTab.waitFor();
  assert.match(await customTab.textContent(), /📄/, "collapsed custom widget shows its icon");
  assert.equal(
    await customTab.evaluate((tab) => {
      const surface = tab.closest("[data-chat-resource-drop-surface]");
      const rect = tab.getBoundingClientRect();
      const host = surface.getBoundingClientRect();
      const neighborTools = document.createElement("button");
      neighborTools.textContent = "Neighbor edit controls";
      Object.assign(neighborTools.style, {
        position: "absolute",
        zIndex: "40",
        left: `${rect.x - host.x}px`,
        top: `${rect.y - host.y}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
      surface.append(neighborTools);
      try {
        return tab.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      } finally {
        neighborTools.remove();
      }
    }),
    true,
    "bookmark remains reachable above neighboring HUD edit controls",
  );
  await page.locator("[data-editing-toggle]").click();
  await page.evaluate(() => {
    const samples = [];
    const sample = () => {
      const panel = document.querySelector('[data-game-floating-widget="open-file"]');
      if (panel) {
        const rect = panel.getBoundingClientRect();
        const tab = panel.querySelector("[data-game-tuck-tab]")?.getBoundingClientRect();
        samples.push({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          tabCenterY: tab ? tab.y + tab.height / 2 : null,
        });
      }
      if (samples.length < 12) requestAnimationFrame(sample);
    };
    window.__customWidgetSamples = samples;
    requestAnimationFrame(sample);
  });
  await customTab.hover();
  await page.waitForFunction(
    () => !document.querySelector('[data-game-panel-content="widget:open-file"]')?.classList.contains("hidden"),
  );
  await page.waitForFunction(() => (window.__customWidgetSamples?.length ?? 0) >= 12);
  const hoverSamples = await page.evaluate(() => window.__customWidgetSamples ?? []);
  console.log(`custom hover x samples: ${JSON.stringify(hoverSamples)}`);
  const expandedHoverSamples = hoverSamples.filter((sample) => sample.width > 100);
  assert.ok(
    expandedHoverSamples.length >= 4 &&
      Math.max(...expandedHoverSamples.map((sample) => sample.x)) -
        Math.min(...expandedHoverSamples.map((sample) => sample.x)) <=
        1,
    "right custom widget hover keeps x stable across animation frames",
  );
  await page.evaluate(() => {
    const samples = [];
    const sample = () => {
      const panel = document.querySelector('[data-game-floating-widget="open-file"]');
      if (panel) samples.push(panel.getBoundingClientRect().x);
      if (samples.length < 12) requestAnimationFrame(sample);
    };
    window.__customClickSamples = samples;
    requestAnimationFrame(sample);
  });
  await customTab.click();
  await page.waitForFunction(
    () => !document.querySelector('[data-game-panel-content="widget:open-file"]')?.classList.contains("hidden"),
  );
  await page.waitForFunction(() => (window.__customClickSamples?.length ?? 0) >= 12);
  const clickSamples = await page.evaluate(() => window.__customClickSamples ?? []);
  console.log(`custom click x samples: ${JSON.stringify(clickSamples)}`);
  assert.ok(
    Math.max(...clickSamples) - Math.min(...clickSamples) <= 16,
    "right custom widget click-open avoids a large x jump",
  );
  await page.locator("[data-editing-toggle]").click();
  await collapseViaOptions(customWidget);
  await customTab.waitFor();
  await page.waitForFunction(() => {
    const panel = document.querySelector('[data-game-floating-widget="open-file"]');
    return panel
      ? panel.getBoundingClientRect().width === 36 && Math.abs(panel.getBoundingClientRect().right - innerWidth) <= 1
      : false;
  });
  const customBeforeDrag = await customWidget.boundingBox();
  assert.ok(customBeforeDrag, "collapsed custom widget has a bounding rect");
  const customTabBox = await customTab.boundingBox();
  assert.ok(customTabBox, "collapsed custom widget has a bookmark");
  const customX = customTabBox.x + customTabBox.width / 2;
  const customY = customTabBox.y + customTabBox.height / 2;
  await page.mouse.move(customX, customY);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) await page.mouse.move(customX, customY - 12 * step);
  await page.mouse.up();
  await page.waitForFunction((previousY) => {
    const panel = document.querySelector('[data-game-floating-widget="open-file"]');
    return panel ? Math.abs(panel.getBoundingClientRect().y - previousY) > 20 : false;
  }, customBeforeDrag.y);
  const customAfterDrag = await customWidget.boundingBox();
  assert.ok(customAfterDrag, "dragged custom widget has a bounding rect");
  const customSavedPosition = await page.evaluate(() => {
    const raw = localStorage.getItem("marinara-game-panel:hud-chat:floating:widget:open-file");
    return raw ? JSON.parse(raw) : null;
  });
  assert.ok(
    customSavedPosition && Math.abs(customSavedPosition.y - customAfterDrag.y) <= 1,
    "custom drag saves its y coordinate",
  );
  assert.equal(
    await customWidget
      .locator('[data-game-panel-content="widget:open-file"]')
      .evaluate((element) => element.classList.contains("hidden")),
    true,
    "dragging the collapsed bookmark does not untuck the widget",
  );
  await customTab.click();
  await page.waitForFunction(
    () => !document.querySelector('[data-game-panel-content="widget:open-file"]')?.classList.contains("hidden"),
  );
  const customOpenedBox = await customWidget.boundingBox();
  assert.ok(customOpenedBox && customOpenedBox.x + customOpenedBox.width <= 1440, "click-open stays on the right edge");
  await collapseViaOptions(customWidget);
  await customWidget.locator("[data-game-tuck-tab]").waitFor();
  const status = page.locator('[data-game-floating-panel="game-status"]');
  const tuckTab = status.locator("[data-game-tuck-tab]");
  const waitStatusOpen = () =>
    page.waitForFunction(
      () => !document.querySelector('[data-game-panel-content="game-status"]')?.classList.contains("hidden"),
    );
  const waitStatusClosed = () =>
    page.waitForFunction(
      () => document.querySelector('[data-game-panel-content="game-status"]')?.classList.contains("hidden") === true,
    );
  const readStatusBox = async () => {
    const box = await status.boundingBox();
    assert.ok(box, "game status has a bounding rect");
    return box;
  };
  const collapseStatus = async () => {
    await collapseViaOptions(status);
    await tuckTab.waitFor();
  };
  await collapseStatus();
  const collapsedBox = await readStatusBox();
  const tabBox = await tuckTab.boundingBox();
  assert.ok(tabBox, "tucked game status has a tab");
  assert.equal(Math.round(tabBox.height), 40, "left bookmark uses a fixed 40px hit box");
  await page.evaluate(() => {
    const samples = [];
    const sample = () => {
      const panel = document.querySelector('[data-game-floating-panel="game-status"]');
      if (panel) {
        const rect = panel.getBoundingClientRect();
        const tab = panel.querySelector("[data-game-tuck-tab]")?.getBoundingClientRect();
        samples.push({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          tabCenterY: tab ? tab.y + tab.height / 2 : null,
        });
      }
      if (samples.length < 12) requestAnimationFrame(sample);
    };
    window.__gameHudSamples = samples;
    requestAnimationFrame(sample);
  });
  await tuckTab.focus();
  await waitStatusOpen();
  const revealedBox = await readStatusBox();
  const revealedTabBox = await tuckTab.boundingBox();
  assert.ok(revealedTabBox, "revealed left game status keeps its tab");
  assert.ok(
    Math.abs(revealedTabBox.y + revealedTabBox.height / 2 - (tabBox.y + tabBox.height / 2)) <= 1,
    "left bookmark center stays fixed while the panel reveals",
  );
  console.log(`left reveal geometry: collapsed=${JSON.stringify(collapsedBox)} first=${JSON.stringify(revealedBox)}`);
  assert.ok(
    revealedBox.y <= collapsedBox.y && collapsedBox.y <= revealedBox.y + revealedBox.height,
    "left reveal contains the original edge tab coordinate",
  );
  assert.ok(
    parseFloat(await status.evaluate((element) => getComputedStyle(element).paddingLeft)) >= 32,
    "left reveal reserves the bookmark gutter inside panel content",
  );
  assert.equal(revealedBox.width, 284, "left reveal reserves gutter without shrinking normal panel content");
  assert.ok(revealedBox.x + revealedBox.width <= 1440, "left reveal stays within the host width");
  await page.waitForFunction(() => (window.__gameHudSamples?.length ?? 0) >= 12);
  const frameSamples = await page.evaluate(() => window.__gameHudSamples ?? []);
  assert.ok(frameSamples.length >= 4, "left reveal captured multiple animation frames");
  const expandedFrameSamples = frameSamples.filter((sample) => sample.height > 100);
  assert.ok(expandedFrameSamples.length >= 4, "left reveal captured multiple expanded animation frames");
  assert.ok(
    Math.max(...expandedFrameSamples.map((sample) => sample.y)) -
      Math.min(...expandedFrameSamples.map((sample) => sample.y)) <=
      1,
    "left reveal keeps y stable across expanded animation frames",
  );
  const expandedTabCenters = expandedFrameSamples
    .map((sample) => sample.tabCenterY)
    .filter((center) => typeof center === "number");
  assert.ok(expandedTabCenters.length >= 4, "left reveal captured bookmark centers across animation frames");
  assert.ok(
    Math.max(...expandedTabCenters) - Math.min(...expandedTabCenters) <= 1,
    "left bookmark center stays fixed across expanded animation frames",
  );
  await page.mouse.move(2, 2);
  await page.keyboard.press("Escape");
  await waitStatusClosed();
  const repeatTabBox = await tuckTab.boundingBox();
  assert.ok(repeatTabBox, "repeat tucked game status has a tab");
  assert.ok(
    Math.abs(repeatTabBox.y + repeatTabBox.height / 2 - (tabBox.y + tabBox.height / 2)) <= 1,
    "left bookmark returns to its collapsed center after hiding",
  );
  await page.evaluate(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined,
  );
  await tuckTab.focus();
  await waitStatusOpen();
  const repeatRevealBox = await readStatusBox();
  assert.ok(
    repeatRevealBox.y <= collapsedBox.y && collapsedBox.y <= repeatRevealBox.y + repeatRevealBox.height,
    "repeat left reveal contains the original edge tab coordinate",
  );
  assert.ok(
    parseFloat(await status.evaluate((element) => getComputedStyle(element).paddingLeft)) >= 32,
    "repeat left reveal reserves the bookmark gutter inside panel content",
  );
  await page.mouse.move(2, 2);
  await page.keyboard.press("Escape");
  await waitStatusClosed();
  console.log(
    `tuck reveal geometry after fix: collapsed=${JSON.stringify(collapsedBox)} first=${JSON.stringify(revealedBox)} repeat=${JSON.stringify(repeatRevealBox)} frames=${frameSamples.length}`,
  );

  await tuckTab.click();
  await setTuckEdge(status, "right");
  await collapseStatus();
  const rightTabBox = await tuckTab.boundingBox();
  assert.ok(
    rightTabBox && rightTabBox.x + rightTabBox.width >= (await page.evaluate(() => innerWidth)) - 1,
    "right edge tab is clamped to the viewport",
  );
  assert.equal(Math.round(rightTabBox.height), 40, "right bookmark uses a fixed 40px hit box");
  await page.mouse.move(rightTabBox.x + rightTabBox.width / 2, rightTabBox.y + rightTabBox.height / 2);
  await tuckTab.focus();
  await waitStatusOpen();
  const rightBox = await readStatusBox();
  const rightRevealedTabBox = await tuckTab.boundingBox();
  assert.ok(rightRevealedTabBox, "revealed right game status keeps its tab");
  assert.ok(
    Math.abs(rightRevealedTabBox.y + rightRevealedTabBox.height / 2 - (rightTabBox.y + rightTabBox.height / 2)) <= 1,
    "right bookmark center stays fixed while the panel reveals",
  );
  console.log(
    `right reveal geometry: ${JSON.stringify(rightBox)} viewport=${JSON.stringify(await page.evaluate(() => ({ width: innerWidth, height: innerHeight })))}`,
  );
  assert.ok(
    rightBox.x + rightBox.width <= (await page.evaluate(() => innerWidth)) + 1,
    "right reveal stays within the viewport",
  );
  assert.ok(rightBox.x >= 0, "right reveal stays within the left host boundary");
  assert.ok(
    parseFloat(await status.evaluate((element) => getComputedStyle(element).paddingRight)) >= 32,
    "right reveal reserves the bookmark gutter inside panel content",
  );
  assert.equal(rightBox.width, 284, "right reveal reserves gutter without shrinking normal panel content");
  await tuckTab.click();

  await page.setViewportSize({ width: 1024, height: 768 });
  await setTuckEdge(status, "left");
  await collapseStatus();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "20px";
  });
  const largeFontTabBox = await tuckTab.boundingBox();
  assert.ok(largeFontTabBox, "large-font left edge tab has a bounding rect");
  assert.equal(Math.round(largeFontTabBox.width), 36, "left edge tab width stays fixed at 36px with a 20px root font");
  assert.equal(
    Math.round(largeFontTabBox.height),
    40,
    "left edge tab height stays fixed at 40px with a 20px root font",
  );
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "16px";
  });
  const resizedTabBox = await tuckTab.boundingBox();
  assert.ok(resizedTabBox && resizedTabBox.x <= 1, "left edge tab remains clamped after viewport resize");
  await page.mouse.move(resizedTabBox.x + resizedTabBox.width / 2, resizedTabBox.y + resizedTabBox.height / 2);
  await tuckTab.focus();
  await waitStatusOpen();
  const resizedBox = await readStatusBox();
  assert.ok(
    resizedBox.x <= 1 && resizedBox.y + resizedBox.height <= 768,
    "resized reveal stays within the viewport while preserving its collapsed anchor",
  );
  assert.ok(
    parseFloat(await status.evaluate((element) => getComputedStyle(element).paddingLeft)) >= 32,
    "resized left reveal reserves the bookmark gutter inside panel content",
  );
  await tuckTab.click();
  await page.setViewportSize({ width: 1440, height: 900 });

  await setTuckEdge(status, "top");
  await collapseStatus();
  const topTabBox = await tuckTab.boundingBox();
  assert.ok(topTabBox && topTabBox.y <= 1, "top edge tab is clamped to the viewport");
  await page.evaluate(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined,
  );
  await tuckTab.focus();
  await waitStatusOpen();
  const topBox = await readStatusBox();
  assert.ok(topBox.y <= 1, "keyboard focus reveal stays at the top edge");
  await page.keyboard.press("Enter");
  await collapseViaOptions(status);
  await page.locator("[data-status-update]").click({ force: true });
  await waitStatusOpen();
  assert.ok((await readStatusBox()).y <= 1, "value-change reveal stays at the top edge");
  await page.keyboard.press("Escape");
  const narrationPanel = page.locator('[data-game-floating-panel="narration"]');
  const bottomLock = (await panelOptions(narrationPanel)).getByRole("button", { name: /bottom/i });
  await bottomLock.click();
  assert.equal(await bottomLock.getAttribute("aria-pressed"), "true", "bottom pin toggles");
  await closeOptions();
  const bottomPinned = () =>
    page.evaluate(() => localStorage.getItem("marinara-game-panel:hud-chat:floating:narration:bottom-lock"));
  assert.equal(
    await page.evaluate(() => localStorage.getItem("marinara-game-panel:hud-chat:floating:narration:bottom-lock")),
    "true",
    "bottom pin persists",
  );
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(250);
    assert.equal(await bottomPinned(), "true", `${viewport.width}: bottom pin remains enabled`);
    await page.waitForFunction(
      () => {
        const panel = document.querySelector('[data-game-floating-panel="narration"]');
        if (!panel) return false;
        const rect = panel.getBoundingClientRect();
        return Math.abs(rect.bottom - (window.innerHeight - 16)) <= 2;
      },
      undefined,
      { timeout: 5000 },
    );
    const box = await page.locator('[data-game-floating-panel="narration"]').boundingBox();
    assert.ok(box, `${viewport.width}: narration panel has a bounding rect`);
    geometryObservations.push(`${viewport.width}x${viewport.height}: bottom=${box.y + box.height}`);
  }
  await page.reload();
  await page.locator('[data-game-floating-panel="narration"]').waitFor();
  assert.equal(
    await page.evaluate(() => localStorage.getItem("marinara-game-panel:hud-chat:floating:widget:open-file:tucked")),
    "true",
    "custom bookmark placement survives reload",
  );
  const customReloadSaved = await page.evaluate(() => {
    const raw = localStorage.getItem("marinara-game-panel:hud-chat:floating:widget:open-file");
    return raw ? JSON.parse(raw) : null;
  });
  assert.ok(
    customReloadSaved && Math.abs(customReloadSaved.y - customSavedPosition.y) <= 1,
    `custom drag coordinate survives reload (saved=${customReloadSaved?.y}, expected=${customSavedPosition.y})`,
  );
  const reopenedContact = page.getByRole("dialog").last();
  if (await reopenedContact.isVisible().catch(() => false)) await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 900 });
  const continuityTab = status.locator("[data-game-tuck-tab]");
  if (await continuityTab.count()) {
    await continuityTab.focus();
    await waitStatusOpen();
  }
  await setTuckEdge(status, "right");
  await collapseViaOptions(status);
  await continuityTab.waitFor();
  await continuityTab.focus();
  await waitStatusOpen();
  const continuityRightBox = await readStatusBox();
  assert.equal(continuityRightBox.width, 284, "continuity right reveal reserves the bookmark gutter");
  await continuityTab.click();
  await page.waitForFunction(
    () =>
      (document.querySelector('[data-game-floating-panel="game-status"]')?.getBoundingClientRect().width ?? 0) < 284,
  );
  const continuityUntuckedBox = await readStatusBox();
  const continuityRelativeX = continuityUntuckedBox.x / (1440 - continuityUntuckedBox.width);
  await page.setViewportSize({ width: 1280, height: 800 });
  const continuityResizedBox = await readStatusBox();
  assert.ok(
    Math.abs(continuityResizedBox.x / (1280 - continuityResizedBox.width) - continuityRelativeX) <= 0.01,
    "untucked right anchor preserves its relative x after resize",
  );
  await page.reload();
  await page.getByText("Real NPC", { exact: true }).waitFor();
  const continuityDialog = page.getByRole("dialog").last();
  if (await continuityDialog.isVisible().catch(() => false)) await page.keyboard.press("Escape");
  await continuityDialog.waitFor({ state: "hidden" });
  const continuityReloadedBox = await page.locator('[data-game-floating-panel="game-status"]').boundingBox();
  assert.ok(continuityReloadedBox, "reloaded untucked right panel has a bounding rect");
  assert.ok(
    Math.abs(continuityReloadedBox.x / (1280 - continuityReloadedBox.width) - continuityRelativeX) <= 0.01,
    "untucked right anchor preserves its relative x after reload",
  );
  const afterReloadLock = (await panelOptions(page.locator('[data-game-floating-panel="narration"]'))).getByRole(
    "button",
    { name: /bottom/i },
  );
  assert.equal(await afterReloadLock.getAttribute("aria-pressed"), "true", "bottom pin survives reload");
  await closeOptions();
  await page.waitForFunction(
    () => {
      const panel = document.querySelector('[data-game-floating-panel="narration"]');
      if (!panel) return false;
      const rect = panel.getBoundingClientRect();
      return Math.abs(rect.bottom - (window.innerHeight - 16)) <= 2;
    },
    undefined,
    { timeout: 5000 },
  );
  const afterReloadBox = await page.locator('[data-game-floating-panel="narration"]').boundingBox();
  assert.ok(afterReloadBox, "reload: narration panel has a bounding rect");
  geometryObservations.push(
    `reload ${page.viewportSize()?.width}x${page.viewportSize()?.height}: bottom=${afterReloadBox.y + afterReloadBox.height}`,
  );
  console.log(
    `game HUD component fixture passed: numeric zero, profile callback, nested categories, bottom pin across viewports and reload (${geometryObservations.join(", ")})`,
  );
} finally {
  await browser?.close();
  await stopFixtureServer(fixture?.server);
}
