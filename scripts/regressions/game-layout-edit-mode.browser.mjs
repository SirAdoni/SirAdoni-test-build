import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { resolve } from "node:path";
const source = resolve("packages/client/src/components/game/FloatingGamePanel.tsx").replaceAll("\\", "/");
const bundle = await build({
  stdin: {
    contents: `import React,{useRef,useState}from'react';import{createRoot}from'react-dom/client';import{FloatingGamePanel,GamePanelContext}from'${source}';function App(){const surface=useRef(null);const[layoutEditing,setEditing]=useState(false);return <><button id="edit" onClick={()=>setEditing(v=>!v)}>Toggle editing</button><div ref={surface} style={{position:'relative',height:600,width:900}}><GamePanelContext.Provider value={{chatId:'fixture',surface,layoutEditing}}><FloatingGamePanel id="map" width={260}><button>Map content</button></FloatingGamePanel></GamePanelContext.Provider></div></>};createRoot(document.getElementById('root')).render(<App/>);`,
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
      setup(b) {
        b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: "translation", namespace: "fixture" }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: "export const useTranslation=()=>({t:key=>key});",
        }));
      },
    },
  ],
});
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.on("pageerror", (error) => console.error(error));
  await page.route("http://layout.fixture/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("http://layout.fixture/");
  await page.setContent(
    '<style>[data-game-floating-panel]{position:absolute;top:0;left:0}[data-panel-layout-controls]{position:absolute}</style><div id="root"></div>',
  );
  await page.evaluate(() => localStorage.clear()).catch(() => {});
  await page.evaluate(() =>
    localStorage.setItem("marinara-game-panel:fixture:floating:map", JSON.stringify({ locked: true, x: 320, y: 280 })),
  );
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const panel = page.locator("[data-game-floating-panel=map]");
  await panel.waitFor();
  assert.equal(await panel.locator("[data-panel-layout-controls]").count(), 0);
  assert.equal(await panel.getByRole("button", { name: "ui.game.floatingPanel.resize" }).count(), 0);
  await page.locator("#edit").click();
  await panel.locator("[data-panel-layout-controls]").waitFor();
  const move = panel.getByRole("button", { name: "ui.game.floatingPanel.move" });
  // Existing per-panel locks remain respected inside edit mode.
  assert.equal(await move.count(), 1);
  await page.locator("#edit").click();
  assert.equal(await panel.locator("[data-panel-layout-controls]").count(), 0);
  await panel.getByRole("button", { name: "Map content" }).click();
  const original = await panel.boundingBox();
  await panel.evaluate((el) => {
    el.parentElement.style.width = "580px";
    el.parentElement.style.height = "400px";
  });
  await page.waitForFunction(() => {
    const panel = document.querySelector("[data-game-floating-panel=map]");
    return Math.abs(panel.getBoundingClientRect().left - panel.parentElement.getBoundingClientRect().left - 160) < 2;
  });
  const smaller = await panel.boundingBox();
  assert.ok(smaller.y < original.y, "Vertical position follows the smaller surface while locked");
  await panel.evaluate((el) => {
    el.parentElement.style.width = "900px";
    el.parentElement.style.height = "600px";
  });
  await page.waitForFunction(() => {
    const panel = document.querySelector("[data-game-floating-panel=map]");
    return Math.abs(panel.getBoundingClientRect().left - panel.parentElement.getBoundingClientRect().left - 320) < 2;
  });
  const restored = await panel.boundingBox();
  assert.ok(Math.abs(restored.y - original.y) < 2, "Growing restores relative vertical placement");
  await panel.evaluate((el) => {
    el.parentElement.style.width = "200px";
  });
  await page.waitForFunction(
    () => document.querySelector("[data-game-floating-panel=map]").getBoundingClientRect().width <= 200,
  );
  await panel.evaluate((el) => {
    el.parentElement.style.width = "900px";
  });
  await page.waitForFunction(() => {
    const panel = document.querySelector("[data-game-floating-panel=map]");
    return Math.abs(panel.getBoundingClientRect().left - panel.parentElement.getBoundingClientRect().left - 320) < 2;
  });
  assert.equal(await panel.locator("[data-panel-layout-controls]").count(), 0);
  console.info(
    "Floating UI edit gate: default locked layout, explicit editing, controls removed on Done, content still interactive.",
  );
} finally {
  await browser.close();
}
