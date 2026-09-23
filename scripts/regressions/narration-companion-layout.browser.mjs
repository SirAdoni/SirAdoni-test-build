import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const url = process.argv[2] ?? process.env.MARINARA_GAME_URL;
if (!url) throw new Error("Pass a read-only game URL as the first argument or set MARINARA_GAME_URL.");
const storageStatePath = process.argv[3] ?? process.env.MARINARA_STORAGE_STATE;
const expectedChatId = process.argv[4] ?? process.env.MARINARA_CHAT_ID;
const replayMessageId = process.argv[5] ?? process.env.MARINARA_REPLAY_MESSAGE_ID;

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
  ...(storageStatePath ? { storageState: storageStatePath } : {}),
  serviceWorkers: "block",
  viewport: { width: 1920, height: 1080 },
});
const page = await context.newPage();
try {
  let replayMessages;
  await page.route("**/api/**", async (route) => {
    if (route.request().method() !== "GET") return route.abort();
    return route.continue();
  });
  if (expectedChatId && replayMessageId) {
    const messagesUrl = new URL(`/api/chats/${encodeURIComponent(expectedChatId)}/messages?limit=1000`, url);
    const response = await context.request.get(messagesUrl.toString());
    assert.equal(response.ok(), true, `message replay source responds: ${response.status()}`);
    const allMessages = await response.json();
    assert.ok(Array.isArray(allMessages), "message replay source is an array");
    const replayIndex = allMessages.findIndex((message) => message?.id === replayMessageId);
    assert.ok(replayIndex >= 0, "requested replay message exists");
    replayMessages = allMessages.slice(0, replayIndex + 1);
    await page.route("**/api/chats/*/messages?*", async (route) => {
      if (route.request().method() === "GET")
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(replayMessages) });
      return route.abort();
    });
  }
  await page.goto(url, { waitUntil: "domcontentloaded" });
  if (expectedChatId)
    await page.waitForFunction(
      (chatId) => document.querySelector(`[data-chat-id="${CSS.escape(chatId)}"]`) != null,
      expectedChatId,
    );
  await page.locator('[data-component="GameNarration.ActivePanel"]').waitFor();
  for (let attempt = 0; attempt < 8 && (await page.locator(".experience-side-line").count()) === 0; attempt += 1) {
    const next = page.getByRole("button", { name: /next/i }).last();
    if (!(await next.isVisible().catch(() => false))) break;
    await next.click();
    await page.waitForTimeout(150);
  }
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1280, height: 915 },
    { width: 1024, height: 650 },
    { width: 412, height: 915 },
  ]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(500);
    const result = await page.evaluate(() => {
      const narration = document.querySelector('[data-game-floating-panel="narration"]');
      const body = document.querySelector('[data-component="GameNarration.ActivePanel"]');
      const side = document.querySelector(".experience-side-line");
      const panels = [...document.querySelectorAll("[data-game-floating-panel]")].map((element) => ({
        element,
        rect: element.getBoundingClientRect(),
      }));
      const overlaps = [];
      for (let i = 0; i < panels.length; i += 1) {
        for (let j = i + 1; j < panels.length; j += 1) {
          const a = panels[i].rect;
          const b = panels[j].rect;
          if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top)
            overlaps.push([panels[i].element.getAttribute("data-game-floating-panel"), panels[j].element.getAttribute("data-game-floating-panel")]);
        }
      }
      return {
        isDesktop: matchMedia("(min-width: 1024px)").matches,
        hasNarration: Boolean(narration),
        sideBottom: side?.getBoundingClientRect().bottom ?? null,
        bodyTop: body?.getBoundingClientRect().top ?? null,
        sameAncestor: side ? side.closest('[data-game-floating-panel="narration"]') === narration : true,
        overlaps,
      };
    });
    assert.notEqual(result.sideBottom, null, `scene side dialogue exists at ${viewport.width}x${viewport.height}`);
    assert.notEqual(result.bodyTop, null, `narration body exists at ${viewport.width}x${viewport.height}`);
    assert.ok(result.sideBottom <= result.bodyTop + 1, `side dialogue stays above narration at ${viewport.width}x${viewport.height}`);
    if (result.isDesktop) {
      assert.equal(result.hasNarration, true, "desktop narration floating block exists");
      assert.equal(result.sameAncestor, true, "desktop side dialogue shares the narration floating block");
    }
    assert.deepEqual(result.overlaps, [], `floating panels do not overlap at ${viewport.width}x${viewport.height}`);
  }
  console.info("Narration companion layout regression passed across desktop and mobile viewports.");
} finally {
  await context.close();
  await browser.close();
}
