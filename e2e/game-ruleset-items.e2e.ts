import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/**
 * A ruleset's own items in the inventory (#6795): picked from its catalog, found by a typed name,
 * shown with what they are, and stacked no higher than the ruleset allows. A ruleset that takes only
 * its own items offers only the picker. Each run imports Ember Roads under its own id, so no other
 * spec's copy is touched, and removes it afterwards.
 */
function emberRoads(id: string, edit: (doc: Record<string, any>) => void = () => {}): string {
  const doc = JSON.parse(readFileSync(new URL("../docs/examples/rulesets/ember-roads.json", import.meta.url), "utf8"));
  doc.id = id;
  edit(doc);
  return JSON.stringify(doc);
}

async function seedGame(request: APIRequestContext, rulesetId: string) {
  const created = await request.post("/api/chats", {
    data: { name: "Ruleset items", mode: "game", characterIds: [] },
  });
  expect(created.ok()).toBeTruthy();
  const chat = (await created.json()) as { id: string };
  const meta = await request.patch(`/api/chats/${chat.id}/metadata`, {
    data: {
      gameId: `ruleset-items-${rulesetId}`,
      gameSessionStatus: "active",
      gameIntroPresented: true,
      gameRuleset: { id: rulesetId, version: 1, packageId: null, options: {} },
      gameInventory: [{ id: "st-rope", name: "Rope", quantity: 1 }],
    },
  });
  expect(meta.ok(), await meta.text()).toBeTruthy();
  const saved = await request.post(`/api/chats/${chat.id}/messages`, {
    data: { role: "assistant", content: "The outfitter's stall smells of oil and leather." },
  });
  expect(saved.ok()).toBeTruthy();
  return chat.id;
}

async function openInventory(page: Page, chatId: string) {
  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    rightPanelOpen: false,
    sidebarOpen: false,
    chatHelpSeenModes: ["conversation", "roleplay", "game"],
    gameInstantTextReveal: true,
  });
  await page.addInitScript(
    ({ id, appVersion }) => {
      localStorage.setItem("marinara-active-chat-id", id);
      localStorage.setItem("marinara:whats-new:seen-version", appVersion);
    },
    { id: chatId, appVersion: version },
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: /Inventory/ })
    .filter({ visible: true })
    .first()
    .click({ timeout: 30000 });
}

test("a ruleset's items are picked, found by name, shown with what they are and stacked by its size", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120000);
  const policyBefore = await request.get("/api/agents/import-policy");
  expect(policyBefore.ok(), await policyBefore.text()).toBeTruthy();
  const importsWereEnabled = (await policyBefore.json()).enabled === true;
  const chats: string[] = [];
  const rulesets: string[] = [];
  const importRuleset = async (definition: string) => {
    const imported = await request.post("/api/game-rulesets/import", { data: { definition } });
    expect(imported.ok(), await imported.text()).toBeTruthy();
    const rulesetId = (await imported.json()).rulesetId as string;
    rulesets.push(rulesetId);
    return rulesetId;
  };
  try {
    const policy = await request.patch("/api/agents/import-policy", { data: { enabled: true } });
    expect(policy.ok(), await policy.text()).toBeTruthy();
    const chatId = await seedGame(request, await importRuleset(emberRoads("ember-inventory-e2e")));
    chats.push(chatId);
    const savedInventory = async () => {
      const row = await (await request.get(`/api/chats/${chatId}`)).json();
      const metadata = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
      return (metadata.gameInventory as Array<{ name: string; item?: string; quantity: number }>).map(
        (stack) => `${stack.name}${stack.item ? ` <${stack.item}>` : ""} ${stack.quantity}`,
      );
    };
    await openInventory(page, chatId);
    const slot = (label: string) => page.getByRole("button", { name: label, exact: true });

    // The picker offers the ruleset's items with what each one is.
    await page.getByRole("button", { name: "From the ruleset", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Add items from the ruleset" });
    await expect(picker).toBeVisible();
    await picker.getByRole("searchbox").fill("hand axe");
    await expect(picker.getByRole("checkbox")).toHaveCount(1);
    await expect(
      picker.getByText("Bulk 1 · Damage 1d6 · Rolls with brawn · Reach close", { exact: true }),
    ).toBeVisible();
    await expect(picker.getByText("Price in marks: 4", { exact: true })).toBeVisible();
    await picker.getByRole("checkbox", { name: "Hand axe", exact: true }).check();
    await picker.getByRole("searchbox").fill("");
    await picker.getByRole("checkbox", { name: "Arrows", exact: true }).check();
    await page.screenshot({ path: testInfo.outputPath("ruleset-item-picker.png") });
    await picker.getByRole("button", { name: "Add 2 items", exact: true }).click();
    await expect(picker).toBeHidden();
    await expect(slot("Hand axe")).toBeVisible();
    await expect(slot("Arrows")).toBeVisible();
    // Persisted plain items keep their semantic IDs just like catalog items.
    await expect
      .poll(savedInventory)
      .toEqual(["Rope <plain:rope> 1", "Hand axe <outfitter/hand-axe> 1", "Arrows <outfitter/arrows> 1"]);

    // The last one picked is selected and says what it is, and how many one stack holds.
    await expect(page.getByText("Ammunition", { exact: true })).toBeVisible();
    await expect(page.getByText("Bulk 1", { exact: true })).toBeVisible();
    await expect(page.getByText("One stack holds up to 20.", { exact: true })).toBeVisible();
    // Twenty-five arrows are a stack of twenty and a new one of five.
    const amount = page.getByLabel("Arrows amount", { exact: true });
    await amount.fill("25");
    await amount.press("Enter");
    await expect(slot("Arrows x20")).toBeVisible();
    await expect(slot("Arrows x5")).toBeVisible();
    await expect(page.getByText("Added 24 Arrows.", { exact: true })).toBeVisible();

    // A typed name that is one of the ruleset's items is that item.
    await page.getByLabel("Name of the item to add", { exact: true }).fill("HAND AXE");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(slot("Hand axe x2")).toBeVisible();
    await expect
      .poll(savedInventory)
      .toEqual([
        "Rope <plain:rope> 1",
        "Hand axe <outfitter/hand-axe> 2",
        "Arrows <outfitter/arrows> 20",
        "Arrows <outfitter/arrows> 5",
      ]);
    await page.screenshot({ path: testInfo.outputPath("ruleset-items.png") });

    // A ruleset that takes only its own items has no name to type, only the picker.
    const strictId = await seedGame(
      request,
      await importRuleset(
        emberRoads("ember-strict-e2e", (doc) => {
          doc.items.freeform = "refuse";
        }),
      ),
    );
    chats.push(strictId);
    // On a page of its own: the first page's start-up script still names the first chat, and the order
    // two such scripts run in is not defined.
    const strictPage = await page.context().newPage();
    await openInventory(strictPage, strictId);
    await expect(strictPage.getByRole("button", { name: "From the ruleset", exact: true })).toBeVisible();
    await expect(strictPage.getByLabel("Name of the item to add", { exact: true })).toHaveCount(0);
    await strictPage.close();
  } finally {
    for (const id of chats) await request.delete(`/api/chats/${id}`);
    for (const id of rulesets) {
      await request.delete(`/api/game-rulesets?rulesetId=${encodeURIComponent(id)}&force=true`);
    }
    const restored = await request.patch("/api/agents/import-policy", { data: { enabled: importsWereEnabled } });
    expect(restored.ok(), await restored.text()).toBeTruthy();
  }
});
