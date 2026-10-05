import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

for (const theme of ["light", "dark"] as const) {
  for (const sample of [
    { source: "openai", idle: "OpenAI-compatible TTS", fraction: 0.2, speed: 1, label: "Speed: 1.00×" },
    {
      source: "elevenlabs",
      idle: "ElevenLabs TTS",
      fraction: 0.6,
      speed: 2,
      label: "Speed: 1.20× (clamped from 2.00×)",
    },
    { source: "xai", idle: "xAI Voice", fraction: 0.375, speed: 2, label: "Speed: 1.50× (clamped from 2.00×)" },
  ]) {
    test(`TTS labels and normal-speed marker: ${sample.source} (${theme})`, async ({ page, request }) => {
      const original = await request.get("/api/tts/config");
      expect(original.ok()).toBeTruthy();
      const config = {
        ...(await original.json()),
        source: sample.source,
        enabled: false,
        speed: sample.speed,
        voice: "",
        apiKey: "",
      };
      let speakRequests = 0;
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return route.abort();
        if (url.pathname === "/api/tts/config") {
          expect(route.request().method()).toBe("GET");
          return route.fulfill({ json: config });
        }
        if (url.pathname === "/api/tts/voices") return route.fulfill({ json: { voices: [] } });
        if (url.pathname === "/api/tts/models") return route.fulfill({ json: { models: [] } });
        if (url.pathname === "/api/tts/speak") {
          speakRequests++;
          return route.abort();
        }
        return route.continue();
      });
      await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
      await seedUIState(page, { hasCompletedOnboarding: true, sidebarOpen: false, rightPanelOpen: false, theme });
      await page.addInitScript((value) => localStorage.setItem("marinara:whats-new:seen-version", value), version);
      await page.goto("/");
      await page.evaluate(async () => {
        const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
        useUIStore.getState().openRightPanel("connections");
      });
      const card = page
        .locator('[data-component="RightPanel"]')
        .getByText("Text to Speech", { exact: true })
        .locator("xpath=../../..");
      await expect(card.getByText(sample.idle, { exact: true })).toBeVisible();
      await card.getByTitle("Expand").click();
      await expect(card.getByText(sample.label, { exact: true })).toBeVisible();
      const preview = card.getByTitle(
        sample.source === "elevenlabs" ? "Select an ElevenLabs voice first" : "Enable TTS first",
        { exact: true },
      );
      await expect(preview).toBeDisabled();
      const marker = card.getByText("1.0×", { exact: true });
      await marker.scrollIntoViewIfNeeded();
      const fraction = await marker.evaluate((node) => {
        const markerBox = node.getBoundingClientRect();
        const trackBox = node.parentElement!.getBoundingClientRect();
        return (markerBox.left + markerBox.width / 2 - trackBox.left) / trackBox.width;
      });
      expect(fraction).toBeCloseTo(sample.fraction, 2);
      expect(speakRequests).toBe(0);
      expect(await card.innerText()).not.toContain("ui.panels.ttsconfigcard.");
    });
  }
}
