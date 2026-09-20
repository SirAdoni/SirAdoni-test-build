import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const [url, storageState, chatId] = process.argv.slice(2);
if (!url || !storageState || !chatId)
  throw new Error("Usage: node game-special-widgets.browser.mjs URL STORAGE_STATE CHAT_ID");
const campaignKey = `special-widgets-regression:${chatId}`;
const contacts = {
  contacts: [
    {
      id: "dorian",
      characterId: "char-dorian",
      name: "Dorian",
      opinion: 72,
      relationshipStatus: "trusted ally",
      automaticCategories: ["trusted"],
      evidenceMessageIds: ["m1"],
    },
    {
      id: "mara",
      characterId: "char-mara",
      name: "Mara",
      opinion: -35,
      automaticCategories: ["hostile"],
      evidenceMessageIds: ["m2"],
    },
    { id: "unknown", name: "Unknown Witness", automaticCategories: [], evidenceMessageIds: ["m3"] },
  ],
  coverage: { complete: true, pendingSessions: 0 },
};

const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext({ storageState, serviceWorkers: "block" });
  await context.addInitScript(
    ({ chat, groups }) => {
      localStorage.setItem("marinara-active-chat-id", chat);
      if (!sessionStorage.getItem("special-widgets-fixture")) {
        localStorage.removeItem(`marinara-game-contact-groups:${groups}`);
        localStorage.removeItem(`marinara-game-status:${chat}:visible`);
        localStorage.removeItem(`marinara-game-contact-book:${chat}:visible`);
        sessionStorage.setItem("special-widgets-fixture", "true");
      }
    },
    { chat: chatId, groups: campaignKey },
  );
  const page = await context.newPage();
  let contactMode = "ready";
  let gameStateMode = "initial";
  let openedCharacter = false;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const requestUrl = request.url();
    if (request.method() === "GET" && requestUrl.includes(`/game/${chatId}/contacts`)) {
      if (contactMode === "loading") {
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
      if (contactMode === "error") return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      if (contactMode === "empty")
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ contacts: [], coverage: { complete: true, pendingSessions: 0 } }),
        });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(contacts) });
    }
    if (request.method() === "GET" && requestUrl.includes("/characters/char-dorian")) {
      openedCharacter = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "char-dorian", name: "Dorian", data: { name: "Dorian" } }) });
    }
    if (request.method() === "GET" && requestUrl.includes(`/chats/${chatId}/game-state`)) {
      const playerStats = {
        stats: [],
        attributes: { str: 26, dex: 24, con: 24, int: 28, wis: 22, cha: 22 },
        skills: {},
        inventory: [],
        activeQuests: [],
        status: "",
      };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          chatId,
          playerStats,
          personaStats: [{ name: "Satiety", value: 70, max: 100, color: "#f59e0b" }],
        }),
      });
    }
    if (request.method() === "GET" && requestUrl.includes("/characters/personas/")) {
      const personaStats =
        gameStateMode === "initial"
          ? {
              enabled: true,
              bars: [{ name: "Satiety", value: 100, max: 100, color: "#f59e0b" }],
              rpgStats: {
                enabled: true,
                attributes: [{ name: "STR", value: 26 }],
                pools: [
                  { name: "HP", value: 84, max: 100 },
                  { name: "MP", value: 40, max: 100 },
                ],
              },
            }
          : {
              enabled: true,
              bars: [],
              rpgStats: {
                enabled: true,
                attributes: [],
                pools: [
                  { name: "HP", value: 84, max: 100 },
                  { name: "MP", value: 40, max: 100 },
                ],
              },
            };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "lucan", name: "Lucan", personaStats }),
      });
    }
    if (request.method() !== "GET") return route.abort();
    return route.continue();
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  const status = page.getByRole("region", { name: /game status/i });
  await status.waitFor();
  const contactToggle = page.getByRole("button", { name: /show contact book/i });
  await contactToggle.waitFor();
  await contactToggle.click();
  const contactsPanel = page.getByRole("dialog").last();
  await contactsPanel.waitFor();
  const contactDialog = contactsPanel;
  const dialogBox = await contactDialog.boundingBox();
  assert.ok(dialogBox && dialogBox.x <= 2 && dialogBox.y <= 2 && dialogBox.width >= 1916 && dialogBox.height >= 1076, "contact book opens as a fullscreen dialog");
  await page.keyboard.press("Escape");
  await contactDialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: /show contact book/i }).click();
  await contactsPanel.waitFor();
  for (const label of ["HP", "MP", "Satiety", "STR"])
    assert.ok(await status.getByText(label, { exact: true }).count(), `status renders ${label}`);
  assert.ok(await contactsPanel.getByText("Dorian", { exact: true }).count(), "contact renders named character");
  assert.ok(
    await contactsPanel.getByText(/trusted ally/).count(),
    "contact renders explicit relationship",
  );
  assert.ok(await contactsPanel.getByText(/72/).count(), "contact renders opinion value");
  assert.ok(
    await contactsPanel.getByText("Unknown Witness", { exact: true }).count(),
    "contact renders unknown met character",
  );

  const search = contactsPanel.getByRole("textbox", { name: /search contacts/i });
  await search.fill("Mara");
  assert.equal(await contactsPanel.getByText("Dorian", { exact: true }).count(), 0, "contact search filters results");
  assert.equal(
    await contactsPanel.getByText("Mara", { exact: true }).count(),
    1,
    "contact search keeps matching result",
  );
  await search.fill("");
  for (const category of ["Staff", "Friends", "Enemies"]) assert.ok(await contactsPanel.getByRole("button", { name: category, exact: true }).count(), `${category} category is visible`);
  const newCategory = contactsPanel.locator("aside input").first();
  await newCategory.fill("Subcrew");
  await contactsPanel.getByRole("combobox", { name: /parent category/i }).selectOption({ label: "Staff" });
  await contactsPanel.getByRole("button", { name: /add category/i }).click();
  await contactsPanel.getByRole("button", { name: "Subcrew", exact: true }).waitFor();
  const dorianArticle = contactsPanel.locator("article").filter({ hasText: "Dorian" });
  await dorianArticle.locator("select").first().selectOption({ label: "Subcrew" });
  await contactsPanel.getByRole("button", { name: "Subcrew", exact: true }).click();
  assert.equal(await dorianArticle.count(), 1, "category selection filters to assigned contact");
  await contactsPanel.getByRole("button", { name: "All contacts", exact: true }).click();
  await search.fill("Mara");
  assert.equal(await contactsPanel.getByText("Dorian", { exact: true }).count(), 0, "contact search filters results");
  await search.fill("");
  const subcrewRow = contactsPanel.getByRole("button", { name: "Subcrew", exact: true }).locator("..");
  await subcrewRow.hover();
  page.once("dialog", (dialog) => dialog.accept("Crew"));
  await subcrewRow.getByRole("button", { name: /rename category/i }).click();
  await contactsPanel.getByRole("button", { name: "Crew", exact: true }).waitFor();
  const crewRow = contactsPanel.getByRole("button", { name: "Crew", exact: true }).locator("..");
  await crewRow.hover();
  page.once("dialog", (dialog) => dialog.accept());
  await crewRow.getByRole("button", { name: /delete category/i }).click();
  assert.equal(await contactsPanel.getByRole("button", { name: "Crew", exact: true }).count(), 0, "category deletion removes the category");
  await contactsPanel.getByRole("button", { name: "All contacts", exact: true }).click();
  await newCategory.fill("Crew");
  await contactsPanel.getByRole("button", { name: /add category/i }).click();
  await contactsPanel.getByRole("button", { name: "Crew", exact: true }).waitFor();
  await dorianArticle.locator("select").first().selectOption({ label: "Crew" });
  const profileButton = contactsPanel.getByRole("button", { name: "Dorian", exact: true });
  assert.equal(await profileButton.isDisabled(), false, "known contact exposes an enabled profile callback");
  await profileButton.click();
  await page.getByRole("dialog").filter({ hasText: /contact book/i }).waitFor({ state: "hidden" });
  await page.getByRole("button", { name: /show contact book/i }).click();
  await contactsPanel.waitFor();
  const boxes = await page.evaluate(() =>
    [...document.querySelectorAll("[data-game-floating-panel]")].map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        id: node.getAttribute("data-game-floating-panel"),
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      };
    }),
  );
  for (let i = 0; i < boxes.length; i += 1)
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i],
        b = boxes[j];
      assert.ok(
        !(a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1),
        `${a.id} and ${b.id} do not overlap`,
      );
    }

  gameStateMode = "stale-without-custom-attribute";
  await page.reload({ waitUntil: "domcontentloaded" });
  await status.waitFor();
  assert.equal(
    await status.getByText("STR", { exact: true }).count(),
    0,
    "removed custom attribute disappears from stale snapshot",
  );
  assert.ok(await status.getByText("HP", { exact: true }).count(), "legacy HP remains after custom field removal");

  contactMode = "loading";
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /show contact book/i }).click();
  await page.getByText(/loading contacts/i).waitFor({ state: "visible", timeout: 5000 });
  contactMode = "error";
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /show contact book/i }).click();
  const contactError = page.getByText(/contact book unavailable/i);
  await contactError.waitFor();
  const retry = contactError.locator("..").getByRole("button", { name: /^retry$/i });
  await retry.waitFor();
  assert.ok(await page.getByText(/unable|error|unavailable/i).count(), "contact error state is visible");
  contactMode = "ready";
  await retry.click();
  await page.getByRole("dialog").last().waitFor();

  contactMode = "empty";
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /show contact book/i }).click();
  await page.getByText(/no contacts recorded yet|no contacts match this view|contact book is empty/i).waitFor({ state: "visible", timeout: 5000 });
  contactMode = "ready";
  await page.reload({ waitUntil: "domcontentloaded" });
  const reopenContact = page.getByRole("button", { name: /show contact book|hide contact book/i });
  await reopenContact.waitFor();
  if ((await reopenContact.getAttribute("aria-pressed")) !== "true") await reopenContact.click();
  await page.getByRole("dialog").last().waitFor();
  assert.ok(await page.getByRole("dialog").last().getByRole("button", { name: "Crew", exact: true }).count(), "custom category persists across reload");
  assert.ok(await page.getByRole("dialog").last().locator("article").filter({ hasText: /Dorian.*Crew/s }).count(), "category assignment persists across reload");
  console.info(
    "Special widget status, contact, filtering, stale-field, empty-state, persistence, and overlap regression passed",
  );
} finally {
  await browser.close();
}
