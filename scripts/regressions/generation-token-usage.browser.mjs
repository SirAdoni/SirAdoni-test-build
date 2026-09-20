import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const bundle = await build({
  stdin: {
    contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import i18n from "i18next";
      import { initReactI18next, I18nextProvider } from "react-i18next";
      import { GenerationTokenUsage } from "./src/components/chat/GenerationTokenUsage";
      import en from "./src/localization/locales/en.json";

      async function mount() {
        await i18n.use(initReactI18next).init({
        lng: "en",
        fallbackLng: "en",
        interpolation: { escapeValue: false },
        resources: { en: { translation: en } }
        });

      const cases = {
        claude: { provider: "claude_subscription", tokensPrompt: 100, tokensCompletion: 50, tokensCachedPrompt: 300, tokensCacheWritePrompt: 100 },
        openai: { provider: "openai", tokensPrompt: 100, tokensCompletion: 50, tokensCachedPrompt: 0, tokensCacheWritePrompt: 0 },
        zero: { provider: "openai", tokensPrompt: 0, tokensCompletion: 0, tokensCachedPrompt: 0, tokensCacheWritePrompt: 0 },
        large: { provider: "openai_chatgpt", tokensPrompt: 300001, tokensCompletion: 6415, tokensCachedPrompt: 300000, tokensCacheWritePrompt: 0 },
        missing: { provider: "claude_subscription", tokensPrompt: 100, tokensCompletion: null, tokensCachedPrompt: null, tokensCacheWritePrompt: null }
      };

      function App() {
        return <main style={{ width: "320px", maxWidth: "100%" }}>
          {Object.entries(cases).map(([name, value]) => <section key={name} data-testid={name} style={{ maxWidth: "240px" }}>
            <h2>{name}</h2><GenerationTokenUsage generationInfo={value} />
          </section>)}
        </main>;
      }

        createRoot(document.getElementById("root")).render(<I18nextProvider i18n={i18n}><App /></I18nextProvider>);
      }
      mount();
    `,
    loader: "tsx",
    resolveDir: resolve("packages/client"),
  },
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
});

const assets = resolve("packages/client/dist/assets");
const cssFile = existsSync(assets) ? readdirSync(assets).find((file) => /^index-.*\.css$/.test(file)) : undefined;
assert.ok(cssFile, "Build the client first: browser layout verification requires its stylesheet");
const css = readFileSync(resolve(assets, cssFile), "utf8");
const browser = await chromium.launch({ headless: true });

function textWithin(locator) {
  return locator.innerText();
}

async function assertCase(page, name, expected) {
  const scope = page.getByTestId(name);
  const details = scope.locator("details");
  await details.locator("summary").click();
  const text = await textWithin(details);
  for (const value of expected) assert.match(text, new RegExp(value), `${name}: missing ${value}`);
  assert.equal(
    await details.locator("summary").getAttribute("role"),
    null,
    `${name}: native summary should remain semantic`,
  );
  assert.equal(
    await scope.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    true,
    `${name}: expanded details fit their narrow container`,
  );
}

try {
  for (const viewport of [
    { name: "desktop", width: 1280, height: 850 },
    { name: "mobile", width: 412, height: 850 },
  ]) {
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    const requests = [];
    await page.on("request", (request) => requests.push({ method: request.method(), url: request.url() }));
    await page.route("http://token-usage.test/", (route) => {
      assert.equal(route.request().method(), "GET");
      return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
    });
    await page.goto("http://token-usage.test/");
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByTestId("claude").waitFor();

    await assertCase(page, "claude", [
      "Input total\\s*500",
      "Output\\s*50",
      "Cache read\\s*300",
      "Cache write\\s*100",
      "Cache hit ratio\\s*60%",
    ]);
    await assertCase(page, "openai", [
      "Input total\\s*100",
      "Output\\s*50",
      "Cache read\\s*0",
      "Cache write\\s*0",
      "Cache hit ratio\\s*0%",
    ]);
    await assertCase(page, "zero", [
      "Input total\\s*0",
      "Output\\s*0",
      "Cache read\\s*0",
      "Cache write\\s*0",
      "Cache hit ratio\\s*Not reported",
    ]);
    await assertCase(page, "large", [
      "Input total\\s*300,001",
      "Output\\s*6,415",
      "Cache read\\s*300,000",
      "Cache hit ratio\\s*99.99%",
    ]);
    await assertCase(page, "missing", [
      "Input total\\s*Not reported\\s*\\(fresh 100\\)",
      "Output\\s*Not reported",
      "Cache read\\s*Not reported",
      "Cache write\\s*Not reported",
      "Cache hit ratio\\s*Not reported",
    ]);

    const focused = page.getByTestId("claude").locator("summary");
    await focused.focus();
    assert.equal(
      await focused.evaluate((element) => element.tagName),
      "SUMMARY",
      `${viewport.name}: token disclosure is keyboard focusable`,
    );
    await focused.locator("xpath=.. ").evaluate((element) => {
      element.open = false;
    });
    await page.keyboard.press("Enter");
    assert.equal(
      await focused.locator("xpath=.. ").getAttribute("open"),
      "",
      `${viewport.name}: disclosure opens with keyboard`,
    );

    const overflow = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    assert.ok(
      overflow.width <= overflow.client + 1,
      `${viewport.name}: horizontal overflow ${overflow.width} > ${overflow.client}`,
    );
    assert.deepEqual(
      requests.map(({ method, url }) => ({ method, url: new URL(url).pathname })),
      [{ method: "GET", url: "/" }],
      `${viewport.name}: harness must not call a server/API`,
    );
    if (viewport.name === "mobile" && process.env.TOKEN_USAGE_SCREENSHOT) {
      await page.screenshot({ path: process.env.TOKEN_USAGE_SCREENSHOT, fullPage: true });
    }
    await page.close();
  }
  console.info(
    "Generation token usage browser proof passed: exact totals, cache read/write, Claude/OpenAI ratios, zero vs missing values, keyboard disclosure, and constrained desktop/mobile overflow.",
  );
} finally {
  await browser.close();
}
