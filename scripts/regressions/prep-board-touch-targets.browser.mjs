// GM prep board on phones: every visible control is a 36px touch target, text
// stays readable, and nothing scrolls sideways.
//
// Run against a Vite dev server (the modal is opened through its source module):
//   node scripts/regressions/prep-board-touch-targets.browser.mjs <url> <gameChatId> [screenshotDir] [tag]
// The prep board GET is answered with an invented fixture board; every write is
// blocked, so the engine's data is never changed.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const [url, chatId, shotDir, tag = "run"] = process.argv.slice(2);
if (!url || !chatId) throw new Error("Expected URL and game chat ID");
if (shotDir) mkdirSync(shotDir, { recursive: true });

const MIN_TARGET = 36;
const MIN_TEXT_PX = 11;
const now = "2026-01-01T00:00:00.000Z";
const item = (id, sectionId, text, extra = {}) => ({
  id,
  sectionId,
  text,
  done: false,
  archived: false,
  tags: [],
  link: null,
  session: 4,
  createdSession: 3,
  usedSession: null,
  carried: 0,
  createdAt: now,
  updatedAt: now,
  ...extra,
});
const board = {
  version: 1,
  session: 4,
  sections: ["strong_start", "scenes", "secrets", "npcs"].map((preset) => ({ id: preset, title: "", preset })),
  items: [
    item("i1", "strong_start", "The lighthouse keeper rings the storm bell at midnight", {
      tags: ["storm", "harbor"],
      carried: 2,
      link: { kind: "character", id: "c-placeholder", label: "Keeper Placeholder" },
    }),
    item("i2", "strong_start", "A sealed letter arrives with a wax crest nobody recognizes", {
      done: true,
      usedSession: 4,
    }),
    item("i3", "scenes", "Market chase through the rope bridges", { tags: ["chase"] }),
    item("i4", "secrets", "The mayor owes the smugglers a favor", {
      link: { kind: "lorebook_entry", id: "e-placeholder", lorebookId: "l-placeholder", label: "Old Harbor Ledger" },
    }),
    item("i5", "npcs", "Quartermaster Example, gruff but fair"),
  ],
};
const boardResponse = {
  gameId: "game-placeholder",
  sessionNumber: 4,
  chatName: "Test Game, Session 4",
  board,
  revision: 1,
  updatedAt: now,
};

const VIEWPORTS = [
  { width: 360, height: 740, phone: true },
  { width: 390, height: 844, phone: true },
  { width: 412, height: 915, phone: true },
  { width: 844, height: 390, phone: true, landscape: true },
  // Desktop with a mouse keeps the compact controls.
  { width: 1440, height: 900, phone: false },
];

/** Controls in the dialog that are too small, too-small text, and overflow. */
async function audit(page) {
  return page.evaluate(
    ({ minTarget, minText }) => {
      const dialog = document.querySelector("[data-prep-item-id]")?.closest('[role="dialog"]');
      if (!dialog) return { error: "no dialog" };
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const small = [];
      for (const el of dialog.querySelectorAll(
        'button, a[href], input:not([type="hidden"]), select, textarea, [role="menuitem"]',
      )) {
        if (!visible(el)) continue;
        // A checkbox wrapped in a label is hit through the label.
        const target = el.matches('input[type="checkbox"], input[type="radio"]') ? (el.closest("label") ?? el) : el;
        const rect = target.getBoundingClientRect();
        if (rect.width < minTarget - 0.5 || rect.height < minTarget - 0.5) {
          small.push(
            `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40)}" ${Math.round(rect.width)}x${Math.round(rect.height)}`,
          );
        }
      }
      const tinyText = [];
      const walker = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent.trim();
        const parent = node.parentElement;
        if (!text || !parent || !visible(parent) || parent.closest(".sr-only")) continue;
        const size = parseFloat(getComputedStyle(parent).fontSize);
        if (size < minText - 0.01) tinyText.push(`"${text.slice(0, 30)}" ${size}px`);
      }
      const scroller = dialog.querySelector(".overflow-y-auto") ?? dialog;
      return {
        small,
        tinyText,
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
        dialogOverflow: scroller.scrollWidth - scroller.clientWidth,
      };
    },
    { minTarget: MIN_TARGET, minText: MIN_TEXT_PX },
  );
}

const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  headless: true,
});
const failures = [];
try {
  for (const viewport of VIEWPORTS) {
    const label = `${viewport.width}x${viewport.height}`;
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.phone,
      hasTouch: viewport.phone,
      deviceScaleFactor: 1,
    });
    await context.addInitScript((id) => localStorage.setItem("marinara-active-chat-id", id), chatId);
    const page = await context.newPage();
    await page.route("**/api/**", (route) => {
      const request = route.request();
      if (request.method() !== "GET") return route.abort();
      if (new URL(request.url()).pathname.endsWith("/prep-board")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(boardResponse) });
      }
      return route.continue();
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180_000 });
    await page.waitForFunction(() => document.querySelector("#root")?.childElementCount > 0, null, {
      timeout: 180_000,
    });
    await page.evaluate(async (id) => {
      const module = await import("/src/lib/open-prep-board.ts");
      module.openPrepBoard(id);
    }, chatId);
    const dialog = page.getByRole("dialog").filter({ has: page.locator("[data-prep-item-id]") });
    await page.locator("[data-prep-item-id]").first().waitFor({ timeout: 120_000 });
    await page.waitForTimeout(400);

    const states = [];
    const check = async (state) => {
      const result = await audit(page);
      states.push({ state, ...result });
      if (shotDir) await page.screenshot({ path: path.join(shotDir, `${tag}-${label}-${state}.png`) });
    };

    await check("board");
    // Item menu open.
    await dialog.locator('[data-prep-item-id="i1"]').getByRole("button", { name: "Item options" }).click();
    await dialog.getByRole("menu").waitFor();
    await page.waitForTimeout(300);
    await check("item-menu");
    await page.keyboard.press("Escape");
    // Item editor: text, tags, link and save controls.
    await dialog
      .locator('[data-prep-item-id="i1"]')
      .getByRole("button", { name: /lighthouse keeper/ })
      .click();
    await dialog.getByRole("textbox", { name: "Item text" }).waitFor();
    await check("editor");
    await page.keyboard.press("Escape");
    // Search with a query shows the clear button.
    await dialog.getByRole("textbox", { name: "Search the board or #tag" }).fill("harbor");
    await page.waitForTimeout(200);
    await check("search");
    const carryOverHeight = await dialog
      .getByRole("button", { name: "Carry over" })
      .evaluate((el) => el.getBoundingClientRect().height);

    for (const state of states) {
      const where = `${label} ${state.state}`;
      if (state.error) failures.push(`${where}: ${state.error}`);
      if (viewport.phone && state.small?.length) {
        failures.push(`${where}: ${state.small.length} small targets: ${state.small.join("; ")}`);
      }
      if (viewport.phone && state.tinyText?.length) {
        failures.push(`${where}: small text: ${state.tinyText.slice(0, 8).join("; ")}`);
      }
      if (state.pageOverflow > 0) failures.push(`${where}: page scrolls sideways by ${state.pageOverflow}px`);
      if (state.dialogOverflow > 0) failures.push(`${where}: dialog scrolls sideways by ${state.dialogOverflow}px`);
    }
    if (!viewport.phone && carryOverHeight >= MIN_TARGET) {
      failures.push(`${label}: desktop icon buttons grew to ${carryOverHeight}px`);
    }
    console.info(
      `${label}: ${states.map((s) => `${s.state} small=${s.small?.length ?? "?"} text=${s.tinyText?.length ?? "?"} overflow=${s.pageOverflow}/${s.dialogOverflow}`).join(", ")}`,
    );
    await context.close();
  }
  assert.deepEqual(failures, [], failures.join("\n"));
  console.info(
    "Prep board touch targets passed: 36px controls, readable text, no sideways scroll on phones; compact on desktop.",
  );
} finally {
  await browser.close();
}
