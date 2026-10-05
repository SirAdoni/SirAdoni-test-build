import { type Page, type APIRequestContext, type TestInfo } from "@playwright/test";
import { expect, test } from "./wiki-feature-fixture";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
test.use({
  wikiFeatures: {
    campaignMemory: false,
    campaignWiki: false,
    familyTree: false,
    factionWeb: false,
    gameCalendar: true,
    worldHistory: false,
  },
});

type Calendar = {
  enabled: boolean;
  config: {
    months: Array<{ name: string; days: number }>;
    weekdays: string[];
    startDate: { year: number; month: number; day: number };
    weekdayOffset: number;
    era: string;
    leap: null;
    moons: [];
  };
  events: Array<Record<string, unknown>>;
};

const makeCalendar = (enabled: boolean): Calendar => ({
  enabled,
  config: {
    months: [
      { name: "First", days: 30 },
      { name: "Second", days: 30 },
    ],
    weekdays: ["Dawn", "Dusk"],
    startDate: { year: 2026, month: 0, day: 1 },
    weekdayOffset: 0,
    era: "AR",
    leap: null,
    moons: [],
  },
  events: [],
});

async function openCalendar(
  page: Page,
  request: APIRequestContext,
  testInfo: TestInfo,
  options: { calendar: Calendar; failLoad?: boolean },
) {
  const created = await request.post("/api/chats", {
    data: { name: "Calendar UI fixture", mode: "game", characterIds: [] },
  });
  expect(created.ok()).toBeTruthy();
  const chat = await created.json();
  let calendar = options.calendar;
  let clock = { day: 1, hour: 8, minute: 0 };
  let savedCalendar: Calendar | undefined;

  try {
    const metadata = await request.patch(`/api/chats/${chat.id}/metadata`, {
      data: {
        enableAgents: false,
        gameId: chat.id,
        gameSessionStatus: "active",
        gameIntroPresented: true,
      },
    });
    expect(metadata.ok()).toBeTruthy();
    const message = await request.post(`/api/chats/${chat.id}/messages`, {
      data: { role: "assistant", content: "The first morning begins." },
    });
    expect(message.ok()).toBeTruthy();

    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await page.route(`**/api/game-calendar/${chat.id}**`, async (route) => {
      const incoming = route.request();
      const respond = () => ({
        calendar,
        clock,
        formattedTime: `Day ${clock.day}, ${String(clock.hour).padStart(2, "0")}:00 (morning)`,
      });
      if (incoming.method() === "GET") {
        if (options.failLoad) return route.fulfill({ status: 500, json: { error: "Fixture load failure" } });
        return route.fulfill({ json: respond() });
      }
      if (incoming.method() === "POST" && incoming.url().endsWith("/advance")) {
        const body = incoming.postDataJSON() as { days: number };
        clock = { ...clock, day: clock.day + body.days };
        return route.fulfill({ json: respond() });
      }
      if (incoming.method() === "PUT") {
        const body = incoming.postDataJSON() as { calendar: Calendar };
        savedCalendar = body.calendar;
        calendar = body.calendar;
        return route.fulfill({ json: respond() });
      }
      return route.fulfill({ status: 405, json: { error: "Unsupported fixture request" } });
    });

    const theme = testInfo.project.name.includes("mobile") ? "light" : "dark";
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      chatHelpSeenModes: ["game"],
      gameInstantTextReveal: true,
      theme,
    });
    await page.addInitScript(
      ({ id, version }) => {
        localStorage.setItem("marinara-active-chat-id", id);
        localStorage.setItem("marinara:whats-new:seen-version", version);
      },
      { id: chat.id, version },
    );
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.getByRole("button", { name: "Open calendar in a window", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Calendar" });
    await expect(dialog).toBeVisible();
    return { chat, dialog, savedCalendar: () => savedCalendar, cleanup: () => request.delete(`/api/chats/${chat.id}`) };
  } catch (error) {
    await request.delete(`/api/chats/${chat.id}`).catch(() => undefined);
    throw error;
  }
}

test("Game calendar opens from the Game Mode surface and advances through its API", async ({
  page,
  request,
}, testInfo) => {
  const fixture = await openCalendar(page, request, testInfo, { calendar: makeCalendar(true) });
  try {
    await expect(fixture.dialog).toContainText("1 First 2026 AR");
    await fixture.dialog.screenshot({ path: testInfo.outputPath("game-calendar.png") });
    await fixture.dialog.getByRole("button", { name: "Move the date by 1 day", exact: true }).click();
    await expect(fixture.dialog).toContainText("2 First 2026 AR");
  } finally {
    await fixture.cleanup().catch(() => undefined);
  }
});

test("Game calendar reports a failed load without opening a broken editor", async ({ page, request }, testInfo) => {
  const fixture = await openCalendar(page, request, testInfo, { calendar: makeCalendar(false), failLoad: true });
  try {
    await expect(fixture.dialog.getByText("Could not load the calendar.", { exact: true })).toBeVisible();
    await fixture.dialog.screenshot({ path: testInfo.outputPath("game-calendar-load-error.png") });
  } finally {
    await fixture.cleanup().catch(() => undefined);
  }
});

test("An empty calendar can be configured and saved", async ({ page, request }, testInfo) => {
  const fixture = await openCalendar(page, request, testInfo, { calendar: makeCalendar(false) });
  try {
    await fixture.dialog.getByRole("button", { name: "Set up calendar", exact: true }).click();
    await expect(
      fixture.dialog.getByRole("textbox", { name: "Months, one per line: name | days", exact: true }),
    ).toBeVisible();
    const enabled = fixture.dialog.getByRole("checkbox", { name: "Use this calendar in this game", exact: true });
    await expect(enabled).not.toBeChecked();
    await fixture.dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => fixture.savedCalendar()?.enabled).toBe(false);
    await fixture.dialog.getByRole("button", { name: "Set up calendar", exact: true }).click();
    await expect(enabled).not.toBeChecked();
    await enabled.check();
    await fixture.dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => fixture.savedCalendar()?.enabled).toBe(true);
    expect(fixture.savedCalendar()?.config.months).toEqual([
      { name: "First", days: 30 },
      { name: "Second", days: 30 },
    ]);
    expect(fixture.savedCalendar()?.events).toEqual([]);
    await expect(fixture.dialog).toContainText("1 First 2026 AR");
    await expect(
      fixture.dialog.getByText("Nothing coming up. Pick a day above and add an event.", { exact: true }),
    ).toBeVisible();
    await fixture.dialog.screenshot({ path: testInfo.outputPath("game-calendar-empty.png") });
  } finally {
    await fixture.cleanup().catch(() => undefined);
  }
});
