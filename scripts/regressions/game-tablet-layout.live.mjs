// Game mode on tablets, against a running client: node scripts/regressions/game-tablet-layout.live.mjs URL CHAT_ID...
// Read-only: every non-GET API request is aborted, so shared UI settings and chat touch times never change.
// Set GAME_TABLET_SHOTS to a folder to keep screenshots, GAME_TABLET_SIZES (for example "768x1024,1025x768")
// to narrow the viewports, and GAME_TABLET_REPORT=1 to print every finding instead of stopping at the first.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const [url, ...chatIds] = process.argv.slice(2);
if (!url || chatIds.length === 0) throw new Error("Usage: node game-tablet-layout.live.mjs URL CHAT_ID [CHAT_ID...]");
const sizes = (process.env.GAME_TABLET_SIZES || "768x1024,820x1180,1023x768,1024x768,1025x768,1180x820,1366x1024")
  .split(",")
  .map((size) => size.split("x").map(Number));
const shots = process.env.GAME_TABLET_SHOTS;
const reportOnly = process.env.GAME_TABLET_REPORT === "1";
const health = await fetch(new URL("/api/health", url))
  .then((response) => response.json())
  .catch(() => ({}));

/** Comfortable reading measure for narration prose below the floating layout, in CSS pixels (48rem column). */
const MAX_NARRATION_MEASURE = 800;
/** Landscape phones: max-height 32rem, covered by game-mobile-layout.live.mjs. */
const LANDSCAPE_PHONE_MAX_HEIGHT = 512;
/** Minimum touch target edge on touch tablets. */
const MIN_TARGET = 36;

async function newGameContext(browser, chatId) {
  const context = await browser.newContext({
    viewport: { width: 1024, height: 768 },
    isMobile: true,
    hasTouch: true,
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
  return { context, page };
}

async function openGame(page, width, height) {
  await page.setViewportSize({ width, height });
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(url, { waitUntil: "commit", timeout: 240_000 });
      await page.locator('[data-component="GameNarration.ActivePanel"]').first().waitFor({ timeout: 180_000 });
      break;
    } catch (error) {
      if (attempt > 0) {
        if (shots) await page.screenshot({ path: `${shots}/tablet-load-failure-${width}x${height}.png` }).catch(() => {});
        throw error;
      }
    }
  }
  await page.waitForTimeout(4000);
  // App-level prompts (What's New when the version lookup missed, install prompts) are not the Game layout.
  for (const name of ["Not now", "Got it"]) {
    const button = page.getByRole("button", { name, exact: true });
    if (await button.count())
      await button
        .first()
        .click({ timeout: 5000 })
        .catch(() => {});
  }
  await page.addStyleTag({ content: "[data-sonner-toaster]{display:none!important}" });
  await page.waitForTimeout(600);
}

/** Everything measured in the page; kept in one function so each rule reads one field. */
function measure(minTarget) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  // The visible part of an element: clipped by the viewport and by every scrolling ancestor.
  const visibleRect = (el) => {
    const r = el.getBoundingClientRect();
    let top = Math.max(r.top, 0);
    let bottom = Math.min(r.bottom, vh);
    let left = Math.max(r.left, 0);
    let right = Math.min(r.right, vw);
    for (let parent = el.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const s = getComputedStyle(parent);
      if (s.display === "contents" || !/(auto|scroll|hidden|clip)/.test(s.overflowX + s.overflowY)) continue;
      const p = parent.getBoundingClientRect();
      if (p.width === 0 && p.height === 0) continue;
      top = Math.max(top, p.top);
      bottom = Math.min(bottom, p.bottom);
      left = Math.max(left, p.left);
      right = Math.min(right, p.right);
    }
    return { top, bottom, left, right, height: Math.max(0, bottom - top), width: Math.max(0, right - left) };
  };
  const describe = (el) =>
    el
      ? `${el.tagName.toLowerCase()}${el.getAttribute("data-component") ? `[${el.getAttribute("data-component")}]` : ""}.${String(el.className).slice(0, 80)}`
      : "nothing";
  /**
   * Visible for at least minHeight, and a point in its visible part hits the element itself: the centre
   * for the composer, the first line for narration (the pinned composer may overlap the rest while it scrolls).
   */
  const probe = (el, minHeight, at = "centre") => {
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    const v = visibleRect(el);
    const shown = v.height >= Math.min(minHeight, r.height - 1) && v.width >= Math.min(40, r.width - 1);
    const y = at === "centre" ? v.top + v.height / 2 : v.top + Math.min(12, v.height / 2);
    const hit = shown ? document.elementFromPoint(v.left + v.width / 2, y) : null;
    const covered = !hit || !(hit === el || el.contains(hit));
    return {
      found: true,
      shown,
      covered,
      coveredBy: covered ? describe(hit) : null,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      visibleHeight: Math.round(v.height),
    };
  };
  const composer = [...document.querySelectorAll("[data-game-composer-dock] textarea")].find(visible) ?? null;
  const composerProbe = probe(composer, 30);
  const panel = document.querySelector('[data-component="GameNarration.ActivePanel"]');
  const prose = panel ? [...panel.querySelectorAll(".game-narration-prose")].find(visible) ?? null : null;
  // Narration must show at least a couple of lines of text, not a sliver.
  const narrationProbe = probe(prose, 40, "first-line");
  const measureWidth = prose ? prose.getBoundingClientRect().width : 0;

  // Headings and labels cut by an ellipsis although they are visible.
  const truncated = [];
  const root = document.querySelector('[data-tour="game-dialogue"]')?.closest("main, #root") ?? document.body;
  for (const el of root.querySelectorAll("h1, h2, h3, h4, [role='heading'], .truncate, [class*='line-clamp']")) {
    if (!visible(el) || el.children.length > 2) continue;
    const s = getComputedStyle(el);
    if (s.position === "absolute" && el.clientWidth <= 1) continue;
    if (!el.textContent.trim() || el.clientWidth === 0) continue;
    if (el.closest("[data-component='GameNarration.ActivePanel'] p")) continue;
    // The floating map is a fixed 320px card with its own marquee and title tooltips; it has no spare room.
    if (el.closest("[data-game-panel-content='map']")) continue;
    if (el.scrollWidth > el.clientWidth + 1) truncated.push(el.textContent.trim().slice(0, 40));
  }

  // Touch targets inside the game surface: buttons and links that are visible and hittable.
  const small = [];
  const surface = document.querySelector("main[data-component='CenterContent']") ?? document.body;
  for (const el of document.querySelectorAll("button, a[href], [role='button'], [role='tab'], input[type='range']")) {
    if (!visible(el) || el.closest("[aria-hidden='true']") || el.disabled) continue;
    // App shell (top bar, toasts) is outside Game mode; links inside running text are exempt.
    if (el.closest("[data-component='TopBar'], [data-sonner-toaster], [role='dialog']")) continue;
    if (!surface.contains(el)) continue;
    if (getComputedStyle(el).display === "inline" || el.closest("p, .game-narration-prose p")) continue;
    const r = el.getBoundingClientRect();
    if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue;
    const hit = document.elementFromPoint(
      Math.min(vw - 1, Math.max(0, r.left + r.width / 2)),
      Math.min(vh - 1, Math.max(0, r.top + r.height / 2)),
    );
    if (!hit || !(hit === el || el.contains(hit) || hit.contains(el))) continue;
    if (r.width < minTarget - 0.5 || r.height < minTarget - 0.5) {
      const name = el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent.trim().slice(0, 24) || el.tagName;
      small.push(`${name} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
  }

  const columnEl = document.querySelector('[data-tour="game-dialogue"]');
  const columnRect = columnEl?.getBoundingClientRect();
  const column = columnRect
    ? { width: Math.round(columnRect.width), leftGap: Math.round(columnRect.left), rightGap: Math.round(vw - columnRect.right) }
    : null;
  const tray = document.querySelector('[data-component="GameSurface.MobileWidgetTray"]');
  const trayRect = tray && visible(tray) ? tray.getBoundingClientRect() : null;
  const floating = [...document.querySelectorAll("[data-game-panel-content]")].filter(visible).length;
  return {
    vw,
    vh,
    scrollWidth: document.scrollingElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    composer: composerProbe,
    narration: narrationProbe,
    measureWidth: Math.round(measureWidth),
    truncated,
    small,
    tray: trayRect ? { width: Math.round(trayRect.width), left: Math.round(trayRect.left) } : null,
    column,
    floating,
  };
}

const failures = [];
function check(condition, message) {
  if (condition) return;
  if (reportOnly) failures.push(message);
  else assert.fail(message);
}

const browser = await chromium.launch({ headless: true });
let checks = 0;
try {
  for (const chatId of chatIds) {
    const { context, page } = await newGameContext(browser, chatId);
    try {
      for (const [width, height] of sizes) {
        const tag = `${chatId} ${width}x${height}`;
        await openGame(page, width, height);
        let result = await page.evaluate(measure, MIN_TARGET);
        // Dismissed prompts and the reflowing HUD animate out; measure again once if either probe was blocked.
        if (result.composer.covered || result.narration.covered) {
          await page.waitForTimeout(2000);
          result = await page.evaluate(measure, MIN_TARGET);
        }
        if (shots) await page.screenshot({ path: `${shots}/tablet-${chatId}-${width}x${height}.png` });

        check(result.scrollWidth <= result.vw, `${tag}: no page-level horizontal overflow (${result.scrollWidth} > ${result.vw})`);
        check(result.composer.found && result.composer.shown && !result.composer.covered, `${tag}: composer visible and uncovered ${JSON.stringify(result.composer)}`);
        check(result.narration.found && result.narration.shown && !result.narration.covered, `${tag}: narration visible and uncovered ${JSON.stringify(result.narration)}`);
        check(result.truncated.length === 0, `${tag}: no truncated headings or labels: ${result.truncated.join(" | ")}`);
        check(result.small.length === 0, `${tag}: touch targets at least ${MIN_TARGET}px: ${result.small.join(" | ")}`);
        // Below the floating layout the phone column is reused; it must not stretch into a wall of text.
        if (width < 1024) {
          check(result.measureWidth <= MAX_NARRATION_MEASURE, `${tag}: narration measure stays readable (${result.measureWidth}px)`);
          check(result.column && Math.abs(result.column.leftGap - result.column.rightGap) <= 2, `${tag}: narration column and tray are centred ${JSON.stringify(result.column)}`);
        }

        // A software keyboard takes roughly 40 percent of the height; the composer and narration must survive it.
        // Below 1024px a height of 32rem or less is a landscape phone, whose layout has its own regression.
        const keyboardHeight = Math.round(height * 0.6);
        if (width < 1024 && keyboardHeight <= LANDSCAPE_PHONE_MAX_HEIGHT) {
          checks++;
          console.log(`ok ${tag} (keyboard height ${keyboardHeight}px is the landscape phone layout, skipped)`);
          continue;
        }
        await page.setViewportSize({ width, height: keyboardHeight });
        await page.waitForTimeout(900);
        let keyboard = await page.evaluate(measure, MIN_TARGET);
        if (keyboard.composer.covered || keyboard.narration.covered) {
          await page.waitForTimeout(2000);
          keyboard = await page.evaluate(measure, MIN_TARGET);
        }
        if (shots) await page.screenshot({ path: `${shots}/tablet-${chatId}-${width}x${height}-keyboard.png` });
        check(keyboard.composer.found && keyboard.composer.shown && !keyboard.composer.covered, `${tag} keyboard: composer visible and uncovered ${JSON.stringify(keyboard.composer)}`);
        check(keyboard.narration.found && keyboard.narration.shown && !keyboard.narration.covered, `${tag} keyboard: narration visible and uncovered ${JSON.stringify(keyboard.narration)}`);
        check(keyboard.scrollWidth <= keyboard.vw, `${tag} keyboard: no page-level horizontal overflow`);
        checks++;
        console.log(`ok ${tag}`, JSON.stringify({ ...result, keyboard: { composer: keyboard.composer, narration: keyboard.narration } }));
      }
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
if (failures.length) {
  console.log(failures.join("\n"));
  console.log(`game tablet layout: ${failures.length} finding(s)`);
  process.exitCode = 1;
} else console.log(`game tablet layout: ${checks} viewport checks passed`);
