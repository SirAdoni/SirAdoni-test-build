import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
mkdirSync(".tmp/storyboard-viewer-repair", { recursive: true });
const narrationSource = readFileSync("packages/client/src/components/game/GameNarration.tsx", "utf8");
assert.ok(narrationSource.indexOf('<FloatingGamePanel id="narration"') < narrationSource.indexOf("{/* Side remarks"));
assert.ok(narrationSource.indexOf("{/* Side remarks") < narrationSource.indexOf("GameNarration.ActivePanel"));
const source = resolve("packages/client/src/components/game/GameStoryboardViewer.tsx").replaceAll("\\", "/");
const bundle = await build({
  stdin: {
    contents: `import React from 'react';import{createRoot}from'react-dom/client';import{GameStoryboardInlineViewer}from'${source}';const noop=()=>{};const root=createRoot(document.getElementById('root'));const frame=(image)=>({id:'frame',index:0,title:'Bread Within Reach',status:image?'image_complete':'failed',error:image?null:'No request was sent to the provider. Another background batch is using the connection.',image:image?{id:'image',url:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="purple"/></svg>'),prompt:'fixture',provider:'fixture',model:'fixture',createdAt:'2026-01-01T00:00:00.000Z'}:null});const props={onOpenImage:f=>window.openedFrame=f.id,onSelectFrame:id=>window.selectedFrame=id,generating:false,position:{x:0,y:0},width:300,size:'small',playing:false,muted:true,videoRef:{current:null},dragHandlers:{},resizeHandlers:{},onClose:noop,onReplay:noop,onTogglePlayback:noop,onToggleMute:noop,onChangeSize:noop,onResizeByKeyboard:noop,onVideoPlayingChange:noop};window.renderViewer=(image)=>root.render(<GameStoryboardInlineViewer {...props} storyboard={{id:'story',status:'complete',error:null,keyframes:[{id:'before'},{...frame(image)},{id:'after'}]}} frame={frame(image)} frameSectionLabel={null}/>);window.renderPreparationFailure=()=>root.render(<GameStoryboardInlineViewer {...props} storyboard={{id:'failed-story',status:'failed',error:'No images were requested.',keyframes:[]}} frame={null} frameSectionLabel={null}/>);window.renderViewer(false);`,
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
        b.onResolve({ filter: /game-storyboard-ui$/ }, () => ({ path: "bounds", namespace: "bounds" }));
        b.onLoad({ filter: /.*/, namespace: "bounds" }, () => ({
          contents: "export const getStoryboardViewerWidthBounds=()=>({minWidth:240,maxWidth:1200});",
        }));
        b.onResolve({ filter: /ChatToolbarControls$/ }, () => ({ path: "toolbar", namespace: "toolbar" }));
        b.onLoad({ filter: /.*/, namespace: "toolbar" }, () => ({
          contents: "export const getChatToolbarButtonClass=()=>'';",
        }));
        b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: "translation", namespace: "fixture" }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents:
            "export const initReactI18next={type:'3rdParty',init(){}}; export const useTranslation=()=>({t:key=>key});",
        }));
      },
    },
  ],
});
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const detail = page.locator('details[role="status"]');
  await detail.waitFor();
  await detail.locator("summary").click();
  assert.match(await detail.innerText(), /No request was sent to the provider/);
  assert.match(await detail.innerText(), /game.storyboard.errorRetryHint/);
  await page.getByRole("button", { name: "game.storyboard.previousPage" }).click();
  assert.equal(await page.evaluate(() => window.selectedFrame), "before");
  await page.getByRole("button", { name: "game.storyboard.nextPage" }).click();
  assert.equal(await page.evaluate(() => window.selectedFrame), "after");
  await page.evaluate(() => window.renderPreparationFailure());
  await page.getByText("game.storyboard.status.unavailable", { exact: true }).first().waitFor();
  assert.equal(await page.getByText("ui.game.gamesurfacecomponent.rendering", { exact: true }).count(), 0);
  await page.evaluate(() => window.renderViewer(true));
  await page.getByRole("img", { name: "Bread Within Reach", exact: true }).waitFor();
  await page.getByRole("button", { name: "game.storyboard.openFullscreen" }).press("Enter");
  assert.equal(await page.evaluate(() => window.openedFrame), "frame");
  console.info(
    "Storyboard error details, retry guidance, and the finished-image fullscreen trigger are visible in the actual viewer component.",
  );
} finally {
  await browser.close();
}
