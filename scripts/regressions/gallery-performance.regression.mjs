// Run: node scripts/regressions/gallery-performance.regression.mjs
// Renders the actual gallery against 3,547 synthetic records; no campaign data is read.
import { build } from "esbuild";
import { writeFile, mkdir, readFile } from "node:fs/promises";
await mkdir(".tmp/gallery-proof", { recursive: true });
await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {ChatGallery} from './packages/client/src/components/chat/ChatGallery';const start=performance.now();createRoot(document.getElementById('root')).render(<ChatGallery chatId="proof" mode="game"/>);window.galleryStart=start;`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  nodePaths: [process.cwd() + "/packages/client/node_modules"],
  bundle: true,
  format: "iife",
  outfile: ".tmp/gallery-proof/" + "after" + ".js",
  define: { "process.env.NODE_ENV": '"production"' },
  jsx: "automatic",
  plugins: [
    {
      name: "fixture",
      setup(b) {
        b.onResolve({ filter: /^react-i18next$/ }, () => ({
          path: "react-i18next-fixture",
          namespace: "fixture",
        }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          loader: "js",
          contents: `export const useTranslation=()=>({t:(key)=>key});export const initReactI18next={type:'3rdParty',init(){}};`,
        }));
        b.onLoad({ filter: /hooks[\\/]use-gallery\.ts$/ }, () => ({
          loader: "js",
          contents: `const images=Array.from({length:3547},(_,i)=>({id:String(i),chatId:'proof',filePath:i+'.png',url:'/api/gallery/file/proof/'+i+'.png',prompt:'Synthetic image '+i+' '+('Description. '.repeat(200)),model:'proof',provider:'proof',width:1280,height:720,createdAt:''}));const empty=[];export const useGalleryImages=()=>({data:images,isLoading:false});export const useSceneVideos=()=>({data:empty,isLoading:false});export const useChatAssetBrowser=()=>({data:empty,isLoading:false});const mutation=()=>({mutateAsync:async()=>{},isPending:false});export const useDeleteSceneVideo=mutation,useUploadGalleryImage=mutation,useDeleteGalleryImage=mutation;`,
        }));
      },
    },
  ],
});

import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
const name = "after";
const bundle = await readFile(".tmp/gallery-proof/" + name + ".js");
const server = createServer((req, res) => {
  if (req.url === "/app.js") {
    res.setHeader("content-type", "text/javascript");
    res.end(bundle);
  } else if (req.url.startsWith("/api/")) {
    res.setHeader("content-type", "image/svg+xml");
    res.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="purple"/></svg>',
    );
  } else res.end('<div id="root" style="width:420px;height:800px;overflow:auto"></div><script src="/app.js"></script>');
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => process.stdout.write("PAGE ERROR " + e.message + "\n"));
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page.locator(".mari-gallery-card").first().waitFor();
  const result = await page.evaluate(() => ({
    cards: document.querySelectorAll(".mari-gallery-card").length,
    nodes: document.querySelectorAll("*").length,
    elapsed: performance.now() - window.galleryStart,
  }));
  process.stdout.write(JSON.stringify(result) + "\n");
  await writeFile(".tmp/gallery-proof/" + name + "-result.json", JSON.stringify(result));
  if (name === "after") {
    assert.equal(result.cards, 48);
    await page.locator(".mari-gallery-card button").first().click();
    const preview = page.getByRole("dialog").locator("img");
    await preview.waitFor();
    assert.match(await preview.getAttribute("src"), /\/0\.png$/);
    await page.keyboard.press("ArrowLeft");
    assert.match(await preview.getAttribute("src"), /\/0\.png$/);
    await page.keyboard.press("ArrowRight");
    assert.match(await preview.getAttribute("src"), /\/1\.png$/);
    await page.keyboard.press("ArrowLeft");
    assert.match(await preview.getAttribute("src"), /\/0\.png$/);
    for (let i = 0; i < 49; i++) await page.keyboard.press("ArrowRight");
    assert.match(await preview.getAttribute("src"), /\/49\.png$/, "Navigate beyond loaded grid cards");
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("dialog").count(), 0);
    await page.getByRole("button", { name: "ui.chat.chatgallery.showMoreImages" }).click();
    assert.equal(await page.locator(".mari-gallery-card").count(), 96);
    assert.match(
      await page.locator(".mari-gallery-card picture source").first().getAttribute("srcset"),
      /w=320$/,
    );
    process.stdout.write(
      "Arrow navigation, first-image boundary, Escape, load-more and thumbnail URL checks passed.\n",
    );
  }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
