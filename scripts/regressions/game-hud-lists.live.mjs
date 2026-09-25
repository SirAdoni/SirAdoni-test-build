// Hiding the party bar and the Currently present strip, against a running client:
//   node scripts/regressions/game-hud-lists.live.mjs URL GAME_CHAT_ID
// The chat must be a game with party members and a Currently present strip. Read-only on the server:
// every non-GET API request is aborted, and the choice itself lives in this browser's localStorage.
// Set GAME_HUD_LISTS_SHOTS to a folder to keep screenshots, GAME_HUD_LISTS_SIZES to pick viewports.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const [url, chatId] = process.argv.slice(2);
if (!url || !chatId) throw new Error("Usage: node game-hud-lists.live.mjs URL GAME_CHAT_ID");
const sizes = (process.env.GAME_HUD_LISTS_SIZES || "390x844,1440x900")
  .split(",")
  .map((size) => size.split("x").map(Number));
const shots = process.env.GAME_HUD_LISTS_SHOTS;
const health = await fetch(new URL("/api/health", url))
  .then((response) => response.json())
  .catch(() => ({}));

const PANEL = '[data-component="GameNarration.ActivePanel"]';

async function openGame(page) {
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(url, { waitUntil: "commit", timeout: 240_000 });
      await page.locator(PANEL).first().waitFor({ timeout: 180_000 });
      break;
    } catch (error) {
      if (attempt > 0) throw error;
    }
  }
  await page.waitForTimeout(3000);
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.count())
    await notNow
      .first()
      .click({ timeout: 5000 })
      .catch(() => {});
  await page.addStyleTag({ content: "[data-sonner-toaster]{display:none!important}" });
}

function measure() {
  const box = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height };
  };
  const stage = document.querySelector('[data-component="GameNarration.Stage"]');
  const style = stage ? getComputedStyle(stage) : null;
  const stageRect = stage?.getBoundingClientRect();
  // The height the narration panel may grow into: the stage minus its reserved top and bottom.
  const room = stageRect
    ? stageRect.height - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom)
    : 0;
  const hidden = {};
  for (const key of Object.keys(localStorage))
    if (key.startsWith("marinara-game-hud:")) hidden[key] = localStorage[key];
  const presence = document.querySelector('[data-component="GameSurface.ScenePresence"]');
  const presenceCard = presence?.querySelector("[data-floating-widget-avoid]") ?? null;
  const presenceCardRect = presenceCard?.getBoundingClientRect();
  return {
    party: box('[data-tour="game-party"]'),
    presence: presence ? true : false,
    presenceCard: presenceCardRect ? { top: presenceCardRect.top, bottom: presenceCardRect.bottom } : null,
    stageTop: stageRect ? stageRect.top + Number.parseFloat(style.paddingTop) : 0,
    room,
    panel: box('[data-component="GameNarration.ActivePanel"]'),
    actions: box('[aria-label="Game actions"]'),
    hidden,
  };
}

/** Clicks one of the two toggles, through the ⋯ menu on phones and the toolbar on desktop. */
async function toggle(page, list, width) {
  if (width < 768) {
    const menuOpen = await page
      .locator(`[data-chat-toolbar-overflow-menu] [data-game-hud-list-toggle="${list}"]`)
      .count();
    if (!menuOpen) await page.getByRole("button", { name: "Game actions" }).click();
    await page.locator(`[data-chat-toolbar-overflow-menu] [data-game-hud-list-toggle="${list}"]`).click();
  } else {
    await page.locator(`[data-game-hud-list-toggle="${list}"]:visible`).first().click();
  }
  await page.waitForTimeout(600);
}

async function pressed(page, list, width) {
  if (width < 768) {
    const menuOpen = await page
      .locator(`[data-chat-toolbar-overflow-menu] [data-game-hud-list-toggle="${list}"]`)
      .count();
    if (!menuOpen) await page.getByRole("button", { name: "Game actions" }).click();
    return page
      .locator(`[data-chat-toolbar-overflow-menu] [data-game-hud-list-toggle="${list}"]`)
      .getAttribute("aria-pressed");
  }
  return page.locator(`[data-game-hud-list-toggle="${list}"]:visible`).first().getAttribute("aria-pressed");
}

async function closeMenu(page, width) {
  if (width >= 768) return;
  if (await page.locator("[data-chat-toolbar-overflow-menu]").count()) {
    await page.getByRole("button", { name: "Game actions" }).click();
    await page.waitForTimeout(300);
  }
}

const browser = await chromium.launch({ headless: true });
let checks = 0;
try {
  for (const [width, height] of sizes) {
    const tag = `${width}x${height}`;
    const phone = width < 768;
    // A fresh context per viewport: a clean profile with nothing hidden yet.
    const context = await browser.newContext({
      viewport: { width, height },
      isMobile: phone,
      hasTouch: phone,
      serviceWorkers: "block",
    });
    await context.addInitScript(
      ({ id, version }) => {
        localStorage.setItem("marinara-active-chat-id", id);
        if (version) localStorage.setItem("marinara:whats-new:seen-version", version);
      },
      { id: chatId, version: health.version },
    );
    const page = await context.newPage();
    await page.route("**/api/**", (route) => (route.request().method() === "GET" ? route.continue() : route.abort()));
    try {
      await openGame(page);
      const shot = async (name) => {
        if (shots) await page.screenshot({ path: `${shots}/hud-lists-${tag}-${name}.png` });
      };

      // Default: both lists are shown, nothing is stored.
      const initial = await page.evaluate(measure);
      await shot("1-default");
      assert.ok(initial.party && initial.party.height > 0, `${tag}: the party bar is shown by default`);
      assert.ok(initial.presence, `${tag}: Currently present is shown by default`);
      assert.deepEqual(initial.hidden, {}, `${tag}: nothing is stored until the player chooses`);
      assert.equal(await pressed(page, "partyBar", width), "true", `${tag}: party toggle reads as shown`);
      assert.equal(await pressed(page, "presence", width), "true", `${tag}: presence toggle reads as shown`);
      checks += 5;

      // Hide the party bar.
      await toggle(page, "partyBar", width);
      await closeMenu(page, width);
      const noParty = await page.evaluate(measure);
      await shot("2-party-hidden");
      assert.equal(noParty.party, null, `${tag}: the party bar is gone`);
      assert.ok(noParty.presence, `${tag}: Currently present stays`);
      assert.equal(Object.values(noParty.hidden).length, 1, `${tag}: one choice is stored`);
      assert.ok(
        Object.keys(noParty.hidden)[0].endsWith(":party-bar:hidden"),
        `${tag}: the party choice is stored per game`,
      );
      checks += 4;
      if (phone) {
        // The strip moves into the top row and the narration takes the freed row.
        assert.ok(
          noParty.presenceCard.top <= initial.presenceCard.top - 40,
          `${tag}: Currently present moves up into the top row`,
        );
        assert.ok(
          noParty.room > initial.room + 24,
          `${tag}: narration gains room (${initial.room} -> ${noParty.room})`,
        );
        assert.ok(noParty.stageTop >= noParty.presenceCard.bottom, `${tag}: narration still clears the strip`);
        checks += 3;
      }

      // Hide Currently present as well.
      await toggle(page, "presence", width);
      await closeMenu(page, width);
      const bothHidden = await page.evaluate(measure);
      await shot("3-both-hidden");
      assert.equal(bothHidden.presence, false, `${tag}: Currently present is gone`);
      assert.equal(Object.values(bothHidden.hidden).length, 2, `${tag}: both choices are stored`);
      assert.ok(bothHidden.room >= noParty.room, `${tag}: narration keeps or gains room`);
      if (bothHidden.panel && initial.panel)
        assert.ok(
          bothHidden.panel.height >= initial.panel.height - 1,
          `${tag}: the narration panel is never squeezed by hiding the lists`,
        );
      checks += 4;
      if (phone) {
        assert.ok(bothHidden.room > initial.room + 48, `${tag}: narration gains the strip's room`);
        assert.ok(bothHidden.stageTop >= bothHidden.actions.bottom, `${tag}: narration clears the top row`);
        checks += 2;
      }

      // The choice survives a reload.
      await openGame(page);
      const reloaded = await page.evaluate(measure);
      await shot("4-reloaded");
      assert.equal(reloaded.party, null, `${tag}: the party bar stays hidden after a reload`);
      assert.equal(reloaded.presence, false, `${tag}: Currently present stays hidden after a reload`);
      assert.equal(await pressed(page, "partyBar", width), "false", `${tag}: party toggle reads as hidden`);
      assert.equal(await pressed(page, "presence", width), "false", `${tag}: presence toggle reads as hidden`);
      checks += 4;

      // Show both again: back to today's layout, and nothing left behind.
      await toggle(page, "partyBar", width);
      await toggle(page, "presence", width);
      await closeMenu(page, width);
      const restored = await page.evaluate(measure);
      await shot("5-restored");
      assert.ok(restored.party && restored.party.height > 0, `${tag}: the party bar comes back`);
      assert.ok(restored.presence, `${tag}: Currently present comes back`);
      assert.deepEqual(restored.hidden, {}, `${tag}: showing clears the stored choice`);
      assert.ok(Math.abs(restored.room - initial.room) <= 1, `${tag}: narration room is back to the default`);
      checks += 4;
    } catch (error) {
      if (shots) await page.screenshot({ path: `${shots}/hud-lists-${tag}-failure.png` }).catch(() => {});
      throw error;
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`game-hud-lists.live: ${checks} checks passed`);
