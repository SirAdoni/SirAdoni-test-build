import { expect, request as playwrightRequest, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const requireServerDependency = createRequire(new URL("../packages/server/package.json", import.meta.url));

test("Contact Book removes and regenerates an NPC portrait through the real app", async ({ page, baseURL }) => {
  const mobile = test.info().project.name.includes("mobile");
  expect(baseURL).toBe(`http://127.0.0.1:${mobile ? 5179 : 5178}`);
  let originalFeatures: Record<string, boolean> | undefined;
  let otherFeatures: Record<string, boolean> = {};
  const setFeatures = async (gameContactBook: boolean, campaignPortraits: boolean) => {
    expect(
      (
        await request.put("/api/app-settings/features", {
          data: { ...otherFeatures, gameContactBook, campaignPortraits },
        })
      ).ok(),
    ).toBeTruthy();
  };
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin !== baseURL) return route.abort();
    return route.continue();
  });
  const sharp = requireServerDependency("sharp");
  const originalPortrait: Buffer = await sharp({
    create: { width: 48, height: 48, channels: 4, background: { r: 230, g: 30, b: 70, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const generatedPortrait: Buffer = await sharp({
    create: { width: 48, height: 48, channels: 4, background: { r: 20, g: 90, b: 220, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const providerCalls: string[] = [];
  const provider = createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/images/generations")) {
      req.resume();
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    providerCalls.push(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ b64_json: generatedPortrait.toString("base64") }] }));
  });

  let ownedChatId: string | undefined;
  let characterId: string | undefined;
  let connectionId: string | undefined;
  const request = await playwrightRequest.newContext({ baseURL });
  try {
    const features = await request.get("/api/app-settings/features");
    expect(features.ok()).toBeTruthy();
    originalFeatures = (await features.json()).settings ?? {};
    otherFeatures = { ...originalFeatures };
    delete otherFeatures.gameContactBook;
    delete otherFeatures.campaignPortraits;
    expect((await request.put("/api/app-settings/features", { data: otherFeatures })).ok()).toBeTruthy();
    await new Promise<void>((resolve, reject) => {
      const onListening = () => {
        provider.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        provider.off("listening", onListening);
        reject(error);
      };
      provider.once("error", onError);
      provider.once("listening", onListening);
      provider.listen(0, "127.0.0.1");
    });
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Fake image provider did not bind");

    const characterResponse = await request.post("/api/characters", { data: { data: { name: "Fixture Guide" } } });
    expect(characterResponse.ok(), await characterResponse.text()).toBeTruthy();
    const fixtureCharacterId: string = (await characterResponse.json()).id;
    characterId = fixtureCharacterId;
    const uploaded = await request.post("/api/characters/" + fixtureCharacterId + "/avatar", {
      data: { avatar: originalPortrait.toString("base64"), filename: "fixture-original.png" },
    });
    expect(uploaded.ok(), await uploaded.text()).toBeTruthy();

    const created = await request.post("/api/chats", {
      data: { name: "Offline NPC portrait fixture", mode: "game", characterIds: [fixtureCharacterId] },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const chat: { id: string } = await created.json();
    ownedChatId = chat.id;

    const connectionResponse = await request.post("/api/connections", {
      data: {
        name: "Loopback portrait fixture",
        provider: "image_generation",
        imageGenerationSource: "openai",
        imageService: "openai",
        baseUrl: "http://127.0.0.1:" + address.port + "/v1",
        model: "fixture-image-model",
        apiKey: "fixture-only",
        treatAsLocalEndpoint: true,
      },
    });
    expect(connectionResponse.ok(), await connectionResponse.text()).toBeTruthy();
    connectionId = (await connectionResponse.json()).id;

    const npcAvatar = "/api/avatars/npc/" + chat.id + "/fixture-guide.png";
    const metadataResponse = await request.patch("/api/chats/" + chat.id + "/metadata", {
      data: {
        gameId: chat.id,
        gameSessionStatus: "active",
        gameIntroPresented: true,
        enableSpriteGeneration: true,
        gameImageConnectionId: connectionId,
        gameImageAutoGenerationEnabled: false,
        gameNpcs: [
          {
            id: "fixture-guide",
            characterId,
            name: "Fixture Guide",
            description: "A guide used only by this isolated browser fixture.",
            appearance: "A calm guide in a dark blue coat.",
            location: "Bridge",
            reputation: 0,
            notes: [],
            avatarUrl: "http://127.0.0.1:7800" + npcAvatar,
          },
        ],
      },
    });
    expect(metadataResponse.ok(), await metadataResponse.text()).toBeTruthy();
    const messageResponse = await request.post("/api/chats/" + chat.id + "/messages", {
      data: { role: "assistant", content: "[Fixture Guide]: The bridge is safe." },
    });
    expect(messageResponse.ok(), await messageResponse.text()).toBeTruthy();

    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await page.route("**" + npcAvatar + "*", (route) =>
      route.fulfill({ contentType: "image/png", body: originalPortrait }),
    );
    await page.addInitScript(
      ({ id, appVersion }) => {
        localStorage.setItem("marinara-active-chat-id", id);
        localStorage.setItem("marinara:whats-new:seen-version", appVersion);
      },
      { id: chat.id, appVersion: version },
    );
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      chatHelpSeenModes: ["conversation", "roleplay", "game"],
      gameInstantTextReveal: true,
    });
    await page.goto("/");
    const panel = page.locator('[data-component="GameNarration.ActivePanel"]');
    await expect(panel).toContainText("The bridge is safe.", { timeout: 30_000 });
    const initialPortrait = panel.getByRole("img", { name: "Fixture Guide", exact: true }).filter({ visible: true });
    await expect(initialPortrait).toBeVisible();
    await expect
      .poll(() =>
        initialPortrait.evaluate(
          (image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0,
        ),
      )
      .toBe(true);
    const originalPixel = await initialPortrait.evaluate((image) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas is unavailable");
      context.drawImage(image as HTMLImageElement, 0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    });
    expect(originalPixel).toEqual([230, 30, 70, 255]);

    const contactBookButton = page.getByRole("button", { name: "Contact book", exact: true }).filter({ visible: true });
    if (mobile) await page.getByRole("button", { name: "Game actions", exact: true }).click();
    await expect(contactBookButton).toHaveCount(0);
    if (mobile) await page.getByRole("button", { name: "Game actions", exact: true }).click();
    expect((await request.get(`/api/game/${chat.id}/contacts`)).status()).toBe(403);
    await setFeatures(true, false);
    await page.reload();
    if (mobile) await page.getByRole("button", { name: "Game actions", exact: true }).click();
    await expect(contactBookButton).toHaveCount(1);
    await contactBookButton.click();
    const book = page.getByRole("dialog");
    await expect(book.getByRole("button", { name: /Generate missing portraits/ })).toHaveCount(0);
    const contact = book.getByRole("button", { name: "Fixture Guide", exact: true });
    await expect(contact).toBeVisible();
    await contact.click();
    await page.getByTitle("Remove avatar").click();
    const avatarConfirmation = page.getByRole("dialog", { name: "Remove Avatar" });
    await expect(avatarConfirmation).toContainText(/Remove the avatar from Fixture Guide\?/);
    await avatarConfirmation.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page.getByTitle("Remove avatar")).toHaveCount(0);
    await page.getByTitle("Back").click();
    await expect(panel).toBeVisible();
    await setFeatures(true, true);
    await page.reload();
    await expect(page.locator('[data-component="GameNarration.ActivePanel"]')).toContainText("The bridge is safe.");

    const missingBookButton = page.getByRole("button", { name: "Contact book", exact: true }).filter({ visible: true });
    if (mobile) await page.getByRole("button", { name: "Game actions", exact: true }).click();
    await missingBookButton.click();
    const missingBook = page.getByRole("dialog");
    await expect(missingBook.getByRole("button", { name: "Generate missing portraits (1)" })).toBeVisible();
    await page.keyboard.press("Escape");

    // Restore the library portrait only to exercise the server's stale-client guard.
    const restored = await request.post("/api/characters/" + characterId + "/avatar", {
      data: { avatar: originalPortrait.toString("base64"), filename: "fixture-stale-guard.png" },
    });
    expect(restored.ok(), await restored.text()).toBeTruthy();

    // Force a stale missing-contact response independent of query refetch timing.
    let staleContactsServed = false;
    await page.route("**/api/game/" + chat.id + "/contacts", async (route) => {
      staleContactsServed = true;
      await route.fulfill({
        json: {
          contacts: [
            {
              id: "fixture-guide",
              sourceChatId: chat.id,
              characterId,
              name: "Fixture Guide",
              portraitDescription: "A calm guide in a dark blue coat.",
              automaticCategories: [],
              evidenceMessageIds: [],
            },
          ],
          coverage: { complete: true, pendingSessions: 0 },
        },
      });
    });
    expect((await (await request.get("/api/characters/" + characterId)).json()).avatarPath).toBeTruthy();
    await page.reload();
    await expect(page.locator('[data-component="GameNarration.ActivePanel"]')).toContainText("The bridge is safe.");
    if (mobile) await page.getByRole("button", { name: "Game actions", exact: true }).click();
    await contactBookButton.click();
    const staleGenerate = page.getByRole("dialog").getByRole("button", { name: "Generate missing portraits (1)" });
    await expect(staleGenerate).toBeEnabled();
    expect(staleContactsServed).toBe(true);
    expect((await (await request.get("/api/characters/" + characterId)).json()).avatarPath).toBeTruthy();
    await staleGenerate.click();
    await expect(
      page.getByText(/Portrait generation failed: Portrait identity changed; refresh the campaign roster/),
    ).toBeVisible();
    expect(providerCalls).toHaveLength(0);
    await page.unroute("**/api/game/" + chat.id + "/contacts");

    const clearedAgain = await request.delete("/api/characters/" + characterId + "/avatar");
    expect(clearedAgain.ok(), await clearedAgain.text()).toBeTruthy();
    await page.reload();
    const activePanel = page.locator('[data-component="GameNarration.ActivePanel"]');
    await expect(activePanel).toContainText("The bridge is safe.", { timeout: 30_000 });
    if (mobile) await page.getByRole("button", { name: "Game actions", exact: true }).click();
    await page.getByRole("button", { name: "Contact book", exact: true }).filter({ visible: true }).click();
    const freshBook = page.getByRole("dialog");
    const generate = freshBook.getByRole("button", { name: "Generate missing portraits (1)" });
    await expect(generate).toBeEnabled();
    await generate.click();
    await expect.poll(() => providerCalls.length, { timeout: 10_000 }).toBe(1);
    expect(providerCalls[0]).toContain(
      "Required canonical NPC visual profile: A guide used only by this isolated browser fixture.",
    );
    await expect(freshBook.getByText("Generated 1 portrait(s); 0 failed.")).toBeVisible({ timeout: 30_000 });

    const contactsResponse = await request.get("/api/game/" + chat.id + "/contacts");
    expect(contactsResponse.ok()).toBeTruthy();
    const contacts = await contactsResponse.json();
    const generated = contacts.contacts.find((item: { characterId?: string }) => item.characterId === characterId);
    expect(generated?.avatar).toBeTruthy();
    await page.keyboard.press("Escape");
    const generatedImages = activePanel.locator("img").filter({ visible: true });
    const sampleGeneratedPixel = () =>
      generatedImages.evaluateAll((images, avatar) => {
        const image = images.find((item) => (item as HTMLImageElement).src.includes(avatar)) as
          HTMLImageElement | undefined;
        if (!image || !image.complete || image.naturalWidth === 0) return null;
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext("2d");
        if (!context) return null;
        context.drawImage(image, 0, 0, 1, 1);
        return Array.from(context.getImageData(0, 0, 1, 1).data);
      }, generated.avatar);
    await expect.poll(sampleGeneratedPixel).not.toBeNull();
    const generatedPixel = await sampleGeneratedPixel();
    expect(generatedPixel).toBeTruthy();
    expect(generatedPixel).toEqual([20, 90, 220, 255]);

    await setFeatures(false, false);
    await page.reload();
    if (mobile) await page.getByRole("button", { name: "Game actions", exact: true }).click();
    await expect(contactBookButton).toHaveCount(0);
    if (mobile) await page.getByRole("button", { name: "Game actions", exact: true }).click();
    expect((await request.get(`/api/game/${chat.id}/contacts`)).status()).toBe(403);
    expect((await (await request.get(`/api/characters/${characterId}`)).json()).avatarPath).toBeTruthy();
    await setFeatures(true, true);
    await page.reload();
    if (mobile) await page.getByRole("button", { name: "Game actions", exact: true }).click();
    await expect(contactBookButton).toHaveCount(1);

    const duplicates = await request.patch("/api/chats/" + chat.id + "/metadata", {
      data: {
        gameNpcs: [
          { id: "duplicate", name: "First Duplicate", description: "one", location: "Bridge", notes: [] },
          { id: "duplicate", name: "Second Duplicate", description: "two", location: "Bridge", notes: [] },
        ],
      },
    });
    expect(duplicates.ok(), await duplicates.text()).toBeTruthy();
    const duplicateContacts = await (await request.get("/api/game/" + chat.id + "/contacts")).json();
    expect(duplicateContacts.contacts.some((item: { name: string }) => item.name.includes("Duplicate"))).toBe(false);
  } finally {
    try {
      if (ownedChatId) {
        let removed = await request.delete("/api/chats/" + ownedChatId);
        if (removed.status() === 409) removed = await request.delete("/api/chats/" + ownedChatId + "?force=true");
        expect(removed.ok(), "Fixture chat cleanup failed: " + (await removed.text())).toBeTruthy();
        expect((await request.get("/api/chats/" + ownedChatId)).status()).toBe(404);
      }
    } finally {
      try {
        if (characterId) {
          const removed = await request.delete("/api/characters/" + characterId);
          expect(removed.ok(), "Fixture character cleanup failed: " + (await removed.text())).toBeTruthy();
          expect((await request.get("/api/characters/" + characterId)).status()).toBe(404);
        }
      } finally {
        try {
          if (connectionId) {
            const removed = await request.delete("/api/connections/" + connectionId);
            expect(removed.ok(), "Fixture connection cleanup failed: " + (await removed.text())).toBeTruthy();
            expect((await request.get("/api/connections/" + connectionId)).status()).toBe(404);
          }
        } finally {
          try {
            if (provider.listening) {
              await new Promise<void>((resolve, reject) =>
                provider.close((error) => (error ? reject(error) : resolve())),
              );
            }
          } finally {
            try {
              if (originalFeatures)
                expect((await request.put("/api/app-settings/features", { data: originalFeatures })).ok()).toBeTruthy();
            } finally {
              await request.dispose();
            }
          }
        }
      }
    }
  }
});
