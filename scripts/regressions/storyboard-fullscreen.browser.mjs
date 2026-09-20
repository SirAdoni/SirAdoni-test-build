import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";

const viewerSource = resolve("packages/client/src/components/game/GameStoryboardViewer.tsx").replaceAll("\\", "/");
const lightboxSource = resolve("packages/client/src/components/chat/ChatImageLightbox.tsx").replaceAll("\\", "/");
const cssDir = resolve("packages/client/dist/assets");
const cssFiles = readdirSync(cssDir).filter((name) => name.endsWith(".css"));
assert.ok(cssFiles.length > 0, "production CSS assets are required for the styled fixture");
const englishMessages = JSON.parse(readFileSync("packages/client/src/localization/locales/en.json", "utf8"));
mkdirSync(".tmp/storyboard-viewer-repair", { recursive: true });
const bundle = await build({
  stdin: {
    contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{GameStoryboardInlineViewer}from'${viewerSource}';import{ChatImageLightbox}from'${lightboxSource}';const noop=()=>{};const image={id:'image',url:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450" fill="purple"/></svg>'),prompt:'fixture',provider:'fixture',model:'fixture',createdAt:'2026-01-01T00:00:00.000Z'};const frame={id:'frame',index:0,title:'Bread Within Reach',status:'image_complete',error:null,image};function App(){const[open,setOpen]=useState(false);return <><GameStoryboardInlineViewer storyboard={{id:'story',keyframes:[frame]}} frame={frame} onOpenImage={()=>setOpen(true)} generating={false} position={{x:0,y:0}} width={544} size="large" playing={false} muted={true} videoRef={{current:null}} dragHandlers={{}} resizeHandlers={{}} onClose={noop} onReplay={noop} onTogglePlayback={noop} onToggleMute={noop} onChangeSize={noop} onResizeByKeyboard={noop} onVideoPlayingChange={noop}/>{open?<ChatImageLightbox image={{...image,chatId:'chat',filePath:'',width:null,height:null}} alt="Bread Within Reach" fullViewport onClose={()=>setOpen(false)}/>:null}</>}createRoot(document.getElementById('root')).render(<App/>);`,
    loader: "tsx",
    resolveDir: process.cwd(),
  },
  nodePaths: [resolve("packages/client/node_modules")],
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  plugins: [{
    name: "fixture",
    setup(b) {
      b.onResolve({ filter: /game-storyboard-ui$/ }, () => ({ path: "bounds", namespace: "fixture" }));
      b.onResolve({ filter: /ChatToolbarControls$/ }, () => ({ path: "toolbar", namespace: "fixture" }));
      b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: "translation", namespace: "fixture" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
        contents:
          path === "bounds"
            ? "export const getStoryboardViewerWidthBounds=()=>({minWidth:240,maxWidth:1200});"
            : path === "toolbar"
              ? "export const getChatToolbarButtonClass=()=>'';"
              : `export const initReactI18next={type:'3rdParty',init(){}};const messages=${JSON.stringify(englishMessages)};export const useTranslation=()=>({t:(key,vars)=>Object.entries(vars||{}).reduce((value,[name,replacement])=>value.split('{{'+name+'}}').join(String(replacement)),messages[key]??key)});`,
      }));
    },
  }],
});
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.setContent('<div id="root"></div>');
    for (const cssFile of cssFiles) await page.addStyleTag({ content: readFileSync(join(cssDir, cssFile), "utf8") });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByRole("button", { name: "Open storyboard image fullscreen" }).press("Enter");
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    const geometry = await dialog.evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return { position: style.position, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    assert.equal(geometry.position, "fixed");
    assert.equal(geometry.x, 0);
    assert.equal(geometry.y, 0);
    assert.equal(geometry.width, width);
    assert.equal(geometry.height, 800);
    await page.screenshot({ path: `.tmp/storyboard-viewer-repair/game-fullscreen-styled-${width}.png`, fullPage: true });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await page.close();
  }
  console.info("Styled Game storyboard image opens in the fullscreen lightbox with keyboard Enter and closes with Escape on desktop and mobile.");
} finally {
  await browser.close();
}
