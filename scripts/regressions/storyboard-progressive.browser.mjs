import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";

const screenshotDir = resolve(".tmp/storyboard-viewer-repair");
mkdirSync(screenshotDir, { recursive: true });

const source = resolve("packages/client/src/components/chat/RoleplayStoryboardMessageMedia.tsx").replaceAll("\\", "/");
const bundle = await build({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import {RoleplayStoryboardMessageMedia} from '${source}';
      const root=createRoot(document.getElementById('root'));
      window.renderFrames=(ready)=>root.render(<RoleplayStoryboardMessageMedia
        storyboard={{id:'story',status:'rendering_images',keyframes:[0,1,2].map(index=>({id:String(index),index,title:'Frame '+index,status:ready.includes(index)?'image_complete':'rendering_image',image:ready.includes(index)?{id:'image'+index,url:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="purple"/></svg>')}:null}))}}
        onOpenImage={()=>{}}/>); window.renderFrames([]);`,
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
          contents: "export const initReactI18next={type:'3rdParty',init(){}}; export const useTranslation=()=>({t:key=>key});",
        }));
      },
    },
  ],
});
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByText("ui.game.gamesurfacecomponent.creatingStoryboard").waitFor();
    await page.evaluate(() => window.renderFrames([1]));
    await page.getByRole("img", { name: "Frame 1", exact: true }).waitFor();
    assert.equal(await page.getByRole("img").count(), 1);
    await page.evaluate(() => window.renderFrames([1, 2]));
    await page.getByRole("button", { name: "ui.agents.storyboard.nextFrame" }).click();
    await page.getByRole("img", { name: "Frame 2", exact: true }).waitFor();
    await page.getByRole("button", { name: "ui.agents.storyboard.nextFrame" }).click();
    await page.getByText("ui.game.gamesurfacecomponent.creatingStoryboard").waitFor();
    await page.screenshot({ path: resolve(screenshotDir, `pending-frame-${width}.png`), fullPage: true });
    await page.evaluate(() => window.renderFrames([0, 1, 2]));
    await page.getByRole("img", { name: "Frame 0", exact: true }).waitFor();
    await page.screenshot({ path: resolve(screenshotDir, `ready-frame-${width}.png`), fullPage: true });
    await page.close();
  }
  console.info(
    "Desktop and mobile viewers show the second frame before the first arrives and preserve navigation during generation.",
  );
} finally {
  await browser.close();
}
