import { test as base, expect } from "@playwright/test";

export const wikiFeatureDefaults = {
  campaignMemory: true,
  campaignWiki: true,
  familyTree: true,
  factionWeb: true,
  gameCalendar: true,
  worldHistory: true,
};

export const test = base.extend<{ wikiFeatures: Record<string, boolean>; wikiFeatureScope: void }>({
  wikiFeatures: [wikiFeatureDefaults, { option: true }],
  wikiFeatureScope: [
    async ({ request, context, baseURL, wikiFeatures }, use) => {
      const origin = new URL(baseURL!).origin;
      expect(["127.0.0.1", "localhost"]).toContain(new URL(origin).hostname);
      const blocked: string[] = [];
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin && ["http:", "https:"].includes(url.protocol)) {
          blocked.push(url.origin);
          await route.abort();
        } else if (url.pathname === "/api/connections/refresh-local-context") {
          await route.fulfill({ json: { updated: [] } });
        } else await route.continue();
      });
      const before = await request.get("/api/app-settings/features");
      expect(before.ok()).toBeTruthy();
      const previous = (await before.json()).settings ?? {};
      try {
        const enabled = await request.put("/api/app-settings/features", { data: { ...previous, ...wikiFeatures } });
        expect(enabled.ok()).toBeTruthy();
        await use();
      } finally {
        const restored = await request.put("/api/app-settings/features", { data: previous });
        expect(restored.ok()).toBeTruthy();
        expect(blocked).toEqual([]);
      }
    },
    { auto: true },
  ],
});
export { expect };
