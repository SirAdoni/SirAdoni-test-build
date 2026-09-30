import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
const engine = resolve(process.env.MARINARA_ENGINE_ROOT || "../Marinara-Engine");
const { build } = createRequire(resolve(engine, "package.json"))("esbuild");
const source = resolve(
  "packages/hierarchical-maps/src/engine/packages/client/src/features/spatial-context/components/MapToolsPopover.tsx",
).replaceAll("\\", "/");
const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {MapToolsPopover} from '${source}';createRoot(document.getElementById('root')).render(<><header><span>World / Local · Williams Estate</span><MapToolsPopover label="Map tools"><button onClick={()=>window.edited=true}>Edit connections</button><p>${"LongLocationName".repeat(40)}</p></MapToolsPopover></header><div id="canvas">Map canvas</div></>);`,
    loader: "tsx",
    resolveDir: engine,
  },
  nodePaths: [resolve(engine, "packages/client/node_modules"), resolve(engine, "node_modules")],
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
});
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [320, 640]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.setContent(
      '<style>body{margin:8px}header{display:flex;align-items:center;justify-content:space-between;height:36px}#root{overflow:hidden}#canvas{height:300px}[popover]{position:fixed;margin:0;box-sizing:border-box;overflow:auto;overflow-wrap:anywhere}</style><div id="root"></div>',
    );
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const trigger = page.getByRole("button", { name: "Map tools", exact: true });
    await trigger.waitFor();
    const before = await page.locator("#canvas").boundingBox();
    await trigger.click();
    const menu = page.getByRole("dialog", { name: "Map tools" });
    await menu.waitFor();
    assert.deepEqual(await page.locator("#canvas").boundingBox(), before);
    const bounds = await menu.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await menu.getByRole("button", { name: "Edit connections" }).click();
    assert.equal(await page.evaluate(() => window.edited), true);
    await trigger.click();
    await menu.waitFor({ state: "hidden" });
    await trigger.click();
    await menu.waitFor();
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    await trigger.click();
    await page.mouse.click(width - 4, 790);
    await menu.waitFor({ state: "hidden" });
    await page.close();
  }
  console.info("Map tools: narrow/wide geometry, overflow, actions, Escape and outside dismissal passed.");
} finally {
  await browser.close();
}
