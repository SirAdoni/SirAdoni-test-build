// Live check of the full-names rule against a running client (dev server or build) and real chats:
// no visible text in the app is cut by an ellipsis, a line clamp or a clipped single line, including
// what the World Maps (hierarchical-maps) package draws inside its mount, the chat list title and
// the storyboard status. Chat names are lengthened in the GET responses (never written back), so the
// chrome is also checked with a long title: on phones the TopBar stays one 51px row and the 36px
// touch toolbar buttons keep their size and do not overlap.
// Only GET requests reach the server; everything else is aborted.
// Usage: node scripts/regressions/game-hud-full-names.live.mjs URL GAME_CHAT_ID [GAME_CHAT_ID...] [--conversation=CHAT_ID]
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const url = args[0];
const conversationArg = args.find((arg) => arg.startsWith("--conversation="));
const conversationId = conversationArg?.split("=")[1] ?? null;
const chatIds = args.slice(1).filter((arg) => !arg.startsWith("--"));
if (!url || chatIds.length === 0)
  throw new Error("Usage: node game-hud-full-names.live.mjs URL GAME_CHAT_ID [...] [--conversation=CHAT_ID]");
const shots = process.env.GAME_NAMES_SHOTS;
const SUFFIX = " and the Longwinding Chronicle of the Evergreen Lanternkeepers";
const english = JSON.parse(fs.readFileSync("packages/client/src/localization/locales/en.json", "utf8"));
const health = await fetch(`${url}/api/health`)
  .then((response) => response.json())
  .catch(() => ({}));

const SIZES = [
  { width: 390, height: 844 },
  { width: 820, height: 1180 },
  { width: 1024, height: 768 },
  { width: 1023, height: 461, screen: { width: 1024, height: 768 } },
  { width: 1440, height: 900 },
];
const CHROME_SIZES = [
  { width: 360, height: 740 },
  { width: 390, height: 844 },
];

function lengthenChatNames(value) {
  if (Array.isArray(value)) return value.map(lengthenChatNames);
  if (value && typeof value === "object") {
    const next = { ...value };
    if (typeof next.name === "string" && typeof next.mode === "string" && !next.name.endsWith(SUFFIX))
      next.name += SUFFIX;
    for (const key of ["chat", "chats"]) if (next[key]) next[key] = lengthenChatNames(next[key]);
    return next;
  }
  return value;
}

async function openChat(browser, chatId, size) {
  const phone = size.width < 1024;
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    screen: size.screen,
    isMobile: phone && size.width < 768,
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
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") return route.abort();
    if (!/\/api\/chats(\/[^/?]+)?(\?|$)/.test(request.url())) return route.continue();
    const response = await route.fetch();
    const type = response.headers()["content-type"] ?? "";
    if (!type.includes("json")) return route.fulfill({ response });
    return route.fulfill({ response, json: lengthenChatNames(await response.json()) });
  });
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(url, { waitUntil: "commit", timeout: 240_000 });
      await page.locator('[data-component="TopBar"]').first().waitFor({ timeout: 180_000 });
      break;
    } catch (error) {
      if (attempt > 0) throw error;
    }
  }
  await page.waitForTimeout(5000);
  for (const name of ["Got it", "Not now", "Skip Tutorial"]) {
    const button = page.getByRole("button", { name });
    if (await button.count())
      await button
        .first()
        .click({ timeout: 3000 })
        .catch(() => {});
  }
  await page.addStyleTag({ content: "[data-sonner-toaster]{display:none!important}" });
  return { context, page };
}

// Every visible element whose text is cut: ellipsis, line clamp, or a clipped single line.
function cutText(scope = "body") {
  const cut = [];
  const hiddenOnPurpose = (el) => {
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (
        style.position === "absolute" &&
        node.clientWidth <= 1 &&
        /rect\(0px|inset\(50%/.test(style.clip + style.clipPath)
      )
        return true;
    }
    return false;
  };
  for (const el of [...document.querySelectorAll(scope)].flatMap((root) => [...root.querySelectorAll("*")])) {
    if (!el.textContent?.trim() || el.closest("select, script, style")) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const style = getComputedStyle(el);
    const wide = el.scrollWidth > el.clientWidth + 1;
    const clamp = style.webkitLineClamp && style.webkitLineClamp !== "none" && el.scrollHeight > el.clientHeight + 1;
    const ellipsis = style.textOverflow === "ellipsis" && wide;
    const clipped = /hidden|clip/.test(style.overflowX) && style.whiteSpace === "nowrap" && wide;
    if ((clamp || ellipsis || clipped) && !hiddenOnPurpose(el)) {
      let owner = "host";
      for (let node = el; node; node = node.parentElement)
        if (node.tagName.toLowerCase().startsWith("marinara-capability")) owner = node.tagName.toLowerCase();
      cut.push(
        `${owner}: "${el.textContent.trim().replace(/\s+/g, " ").slice(0, 60)}" <${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 70)}">`,
      );
    }
  }
  return cut;
}

function chromeState() {
  const bar = document.querySelector('[data-component="TopBar"]');
  const barBox = bar?.getBoundingClientRect();
  const barButtons = bar
    ? [...bar.querySelectorAll("button, a")].filter((b) => b.getBoundingClientRect().width > 0)
    : [];
  const tops = new Set(barButtons.map((b) => Math.round(b.getBoundingClientRect().top / 4)));
  // The chat header's toolbar buttons (the touch "More options" menu and 36px touch buttons), in the band
  // right below the TopBar.
  const barBottom = barBox ? barBox.bottom : 0;
  const touch = [...document.querySelectorAll('[data-component^="ChatArea"] button.marinara-chat-toolbar-button')]
    .filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.top >= barBottom - 1 && r.top < barBottom + 70;
    })
    .map((b) => {
      const r = b.getBoundingClientRect();
      return {
        label: b.getAttribute("aria-label") ?? "",
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
    });
  const overlaps = [];
  for (let i = 0; i < touch.length; i++)
    for (let j = i + 1; j < touch.length; j++) {
      const a = touch[i];
      const b = touch[j];
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1)
        overlaps.push(`${a.label} / ${b.label}`);
    }
  return {
    barHeight: barBox ? Math.round(barBox.height) : null,
    barRows: tops.size,
    touch: touch.map((b) => ({
      label: b.label,
      width: Math.round(b.width),
      height: Math.round(b.height),
      right: Math.round(b.right),
    })),
    overlaps,
    vw: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  };
}

const browser = await chromium.launch({ headless: true });
try {
  // 1. Game chats: no cut text on the HUD, in the map card or popover and in the package views.
  // GAME_NAMES_PARTS=chrome runs only the phone chrome checks.
  const onlyChrome = process.env.GAME_NAMES_PARTS === "chrome";
  for (const chatId of onlyChrome ? [] : chatIds) {
    for (const size of SIZES) {
      const tag = `${chatId} ${size.width}x${size.height}`;
      const { context, page } = await openChat(browser, chatId, size);
      await page.locator('[data-component="GameNarration.ActivePanel"]').first().waitFor({ timeout: 180_000 });
      await page.waitForTimeout(1500);
      const found = await page.evaluate(cutText);
      if (shots) await page.screenshot({ path: `${shots}/names-live-${chatId}-${size.width}x${size.height}.png` });
      assert.deepEqual(found, [], `${tag}: no cut text\n${found.join("\n")}`);
      if (size.width < 1024) {
        const open = page.getByRole("button", { name: english["ui.game.mobilemapbutton.openMap"] });
        if (await open.count()) {
          await open.first().click({ timeout: 10_000 });
          await page.waitForTimeout(2500);
          const inMap = await page.evaluate(cutText);
          if (shots)
            await page.screenshot({ path: `${shots}/names-live-${chatId}-${size.width}x${size.height}-map.png` });
          assert.deepEqual(inMap, [], `${tag}: no cut text with the map open\n${inMap.join("\n")}`);
        }
      }
      console.log(`ok ${tag}`);
      await context.close();
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  // 2. Phones with a long chat title: TopBar one 51px row, touch toolbar buttons 36px and apart,
  //    and the chat list shows the whole title.
  for (const chatId of [chatIds[0], conversationId].filter(Boolean)) {
    for (const size of CHROME_SIZES) {
      const tag = `${chatId} chrome ${size.width}x${size.height}`;
      const { context, page } = await openChat(browser, chatId, size);
      // App notices (agent updates, reload prompts) are not part of the chrome under test.
      for (const name of ["Not now", "Close toast"]) {
        const notice = page.getByRole("button", { name });
        if (await notice.count())
          await notice
            .first()
            .click({ timeout: 3000 })
            .catch(() => {});
      }
      const state = await page.evaluate(chromeState);
      if (chatId === conversationId) assert.ok(state.touch.length > 0, `${tag}: the chat header toolbar is measured`);
      assert.equal(state.barHeight, 51, `${tag}: TopBar stays 51px (${state.barHeight})`);
      assert.equal(state.barRows, 1, `${tag}: TopBar stays one row`);
      assert.ok(state.scrollWidth <= state.vw, `${tag}: no sideways page scroll`);
      for (const button of state.touch) {
        assert.ok(
          button.width >= 35 && button.height >= 35,
          `${tag}: touch button ${button.label} keeps 36px (${button.width}x${button.height})`,
        );
        assert.ok(button.right <= state.vw + 1, `${tag}: touch button ${button.label} stays on screen`);
      }
      assert.deepEqual(state.overlaps, [], `${tag}: touch toolbar buttons do not overlap`);
      const toggle = page.locator('[data-component="TopBar"] [data-tour="sidebar-toggle"]').first();
      if (await toggle.count()) {
        await toggle.click({ timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(1500);
        const listed = await page.evaluate(
          (suffix) =>
            [...document.querySelectorAll('[data-component="ChatSidebar"] span')].some(
              (span) =>
                span.children.length === 0 &&
                span.textContent.endsWith(suffix) &&
                span.scrollWidth <= span.clientWidth + 1,
            ),
          SUFFIX,
        );
        // Scoped to the chrome this check owns; the conversation header is covered by its own tests.
        const cut = await page.evaluate(cutText, '[data-component="TopBar"], [data-component="ChatSidebar"]');
        if (shots)
          await page.screenshot({ path: `${shots}/names-live-${chatId}-chrome-${size.width}x${size.height}.png` });
        assert.ok(listed, `${tag}: the chat list shows a long title in full`);
        assert.deepEqual(cut, [], `${tag}: no cut text with the chat list open\n${cut.join("\n")}`);
        const after = await page.evaluate(chromeState);
        assert.equal(after.barHeight, 51, `${tag}: TopBar stays 51px with the chat list open`);
      }
      console.log(`ok ${tag} ${JSON.stringify({ bar: state.barHeight, touch: state.touch.length })}`);
      await context.close();
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  console.log("game hud full names live: ok");
} finally {
  await browser.close();
}
