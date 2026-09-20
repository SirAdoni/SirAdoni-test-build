import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { buildClientCss } from "../ui-fixtures/lib/build-client-css.mjs";

const source = resolve("packages/client/src/components/game/GameFeaturesGuide.tsx").replaceAll("\\", "/");
const english = JSON.parse(
  await fs.readFile(resolve("packages/client/src/localization/locales/en.json"), "utf8"),
);
const tempDirectory = await fs.mkdtemp(resolve(os.tmpdir(), "marinara-game-guide-"));
const cssPath = resolve(tempDirectory, "client.css");
await buildClientCss(cssPath);
const css = await fs.readFile(cssPath, "utf8");
const bundle = await build({
  stdin: {
    contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{GameFeaturesGuide}from'${source}';function App(){const[open,setOpen]=useState(false);return <><button id="open" onClick={()=>setOpen(true)}>Open guide</button>{open&&<GameFeaturesGuide onClose={()=>setOpen(false)}/>}</>};createRoot(document.getElementById('root')).render(<App/>);`,
    loader: "tsx",
    resolveDir: process.cwd(),
  },
  nodePaths: [resolve("packages/client/node_modules")],
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  plugins: [
    {
      name: "translation",
      setup(plugin) {
        plugin.onResolve({ filter: /^react-i18next$/ }, () => ({ path: "translation", namespace: "fixture" }));
        plugin.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: `const MAP=${JSON.stringify(english)};export const useTranslation=()=>({t:(key,values)=>{let value=MAP[key]??key;for(const[name,replacement]of Object.entries(values??{}))value=value.replaceAll(\`{{\${name}}}\`,String(replacement));return value;}});`,
        }));
      },
    },
  ],
});

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await page.setContent(`<style>${css}</style><div id="root"></div>`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.locator("#open").click();
  await page.getByRole("dialog").waitFor();
  assert.equal(await page.getByRole("combobox", { name: "Guide chapters" }).isVisible(), false);
  assert.equal(await page.getByRole("navigation", { name: "Guide chapters" }).isVisible(), true);
  assert.equal(await page.getByRole("heading", { name: "Make the HUD yours" }).count(), 1);
  await page.getByRole("button", { name: /Contact Book/ }).click();
  assert.equal(await page.getByRole("heading", { name: "Contact Book" }).count(), 1);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal(await page.locator("#open").evaluate((element) => document.activeElement === element), true);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#open").click();
  await page.getByRole("dialog").waitFor();
  const chapterSelect = page.getByRole("combobox", { name: "Guide chapters" });
  assert.equal(await chapterSelect.isVisible(), true);
  assert.equal(await page.getByRole("navigation", { name: "Guide chapters" }).isVisible(), false);
  await chapterSelect.selectOption("2");
  assert.equal(await page.getByRole("heading", { name: "Campaign memory and the wiki" }).count(), 1);
  const article = page.locator("article");
  assert.ok(await article.evaluate((element) => element.scrollWidth <= element.clientWidth));
  assert.ok((await article.boundingBox())?.height > 0);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal(await page.locator("#open").evaluate((element) => document.activeElement === element), true);
  console.info(
    "Game features guide browser check: desktop chapter selection, Escape focus restore, and 390x844 mobile navigation passed.",
  );
} finally {
  await browser.close();
  await fs.rm(tempDirectory, { recursive: true, force: true });
}
