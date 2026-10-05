import { expect, test } from "@playwright/test";

test("app update toast stays available while refresh runs, then falls back to a local reload", async ({
  page,
}, testInfo) => {
  const appOrigin = new URL(testInfo.project.use.baseURL as string).origin;
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin === appOrigin) {
      await route.continue();
    } else {
      await route.abort();
    }
  });

  await page.goto("/");
  await page.evaluate(async () => {
    type UpdateFixtureWindow = Window & { completeAppUpdateRefresh?: () => void };
    const fixtureWindow = window as UpdateFixtureWindow;
    const { showAppUpdatePrompt } = await import("/src/lib/app-update-prompt.ts" as string);
    showAppUpdatePrompt(
      () =>
        new Promise<void>((resolve) => {
          fixtureWindow.completeAppUpdateRefresh = resolve;
        }),
    );
  });

  const toast = page.locator("[data-sonner-toast]").filter({ hasText: "A Marinara update is ready." });
  await expect(toast).toBeVisible();
  const refresh = toast.getByRole("button", { name: "Refresh", exact: true });
  const reloaded = page.waitForEvent("framenavigated", { predicate: (frame) => frame === page.mainFrame() });
  await refresh.click();
  await expect(toast).toBeVisible();
  await expect(toast).toHaveAttribute("data-removed", "false");
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean((window as Window & { completeAppUpdateRefresh?: () => void }).completeAppUpdateRefresh),
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    const fixtureWindow = window as Window & { completeAppUpdateRefresh?: () => void };
    fixtureWindow.completeAppUpdateRefresh?.();
    delete fixtureWindow.completeAppUpdateRefresh;
  });
  await reloaded;
  await expect(page).toHaveURL(new URL("/", appOrigin).toString());
});
