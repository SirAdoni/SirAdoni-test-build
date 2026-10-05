// Run after a client build: node scripts/regressions/gallery-performance.regression.mjs
// Renders the real gallery against synthetic records and the built client CSS; no campaign data is read.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const proofDir = ".tmp/gallery-proof";
const clientDist = "packages/client/dist";
await mkdir(proofDir, { recursive: true });
const builtHtml = await readFile(path.join(clientDist, "index.html"), "utf8");
const stylePaths = [...builtHtml.matchAll(/href=["']([^"']+\.css)["']/g)].map((match) =>
  path.join(clientDist, match[1].replace(/^\/+/, "")),
);
assert.ok(stylePaths.length > 0, "Build the client before running this regression so actual app CSS is available.");
const styles = (await Promise.all(stylePaths.map((stylePath) => readFile(stylePath, "utf8")))).join("\n");
const stylesSha256 = createHash("sha256").update(styles).digest("hex");

await build({
  stdin: {
    contents: [
      "import React from 'react';",
      "import {createRoot} from 'react-dom/client';",
      "import {QueryClient,QueryClientProvider} from '@tanstack/react-query';",
      "import {ChatGallery} from './packages/client/src/components/chat/ChatGallery';",
      "const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});",
      "const value=new URLSearchParams(location.search).has('off')?{}:{galleryBrowsing:true};",
      "client.setQueryData(['features'],{settings:value,envOverrides:{}});",
      "window.setFeature=(value)=>client.setQueryData(['features'],{settings:{galleryBrowsing:value},envOverrides:{}});",
      "window.failFeature=()=>client.getQueryCache().find({queryKey:['features']}).setState({status:'error',error:new Error('fixture')});",
      "const started=performance.now();",
      "createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><ChatGallery chatId='fixture-chat' mode='game'/></QueryClientProvider>);",
      "window.galleryStarted=started;",
    ].join(""),
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  nodePaths: [path.join(process.cwd(), "packages/client/node_modules")],
  bundle: true,
  format: "iife",
  outfile: path.join(proofDir, "gallery.js"),
  define: { "process.env.NODE_ENV": '"production"' },
  jsx: "automatic",
  plugins: [
    {
      name: "gallery-fixture",
      setup(builder) {
        builder.onResolve({ filter: /^react-i18next$/ }, () => ({
          path: "react-i18next-fixture",
          namespace: "fixture",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          loader: "js",
          contents:
            "export const useTranslation=()=>({t:(key)=>key});export const initReactI18next={type:'3rdParty',init(){}};",
        }));
        builder.onLoad({ filter: /hooks[\\/]use-gallery\.ts$/ }, () => ({
          loader: "js",
          contents: [
            "const params=new URLSearchParams(window.location.search);",
            "const count=Math.max(0,Math.min(4000,Number(params.get('count')||3547)));",
            "const images=Array.from({length:count},(_,i)=>({id:String(i),chatId:'fixture-chat',filePath:i+'.png',url:'/api/gallery/file/fixture-chat/'+i+'.png',prompt:'Synthetic image '+i,model:'fixture',provider:'fixture',width:1280,height:720,createdAt:''}));",
            "const assets=Array.from({length:120},(_,i)=>({id:'chat-gallery:'+i,kind:'chat-gallery',ownerId:'fixture-chat',ownerName:'Fixture chat',name:'Synthetic image '+i,prompt:'Synthetic image '+i,url:'/api/gallery/file/fixture-chat/'+i+'.png',width:1280,height:720}));",
            "const empty=[];",
            "export const useGalleryImages=()=>({data:images,isLoading:false});",
            "export const useSceneVideos=()=>({data:empty,isLoading:false});",
            "export const useChatAssetBrowser=()=>({data:assets,isLoading:false});",
            "const mutation=()=>({mutateAsync:async()=>{},isPending:false});",
            "export const useDeleteSceneVideo=mutation,useUploadGalleryImage=mutation,useDeleteGalleryImage=mutation;",
          ].join(""),
        }));
      },
    },
  ],
});

const bundle = await readFile(path.join(proofDir, "gallery.js"));
const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
  if (requestUrl.pathname === "/app.js") {
    response.setHeader("content-type", "text/javascript");
    response.end(bundle);
  } else if (requestUrl.pathname === "/app.css") {
    response.setHeader("content-type", "text/css");
    response.end(styles);
  } else if (requestUrl.pathname.startsWith("/api/gallery/file/")) {
    response.setHeader("content-type", "image/svg+xml");
    response.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="purple"/></svg>',
    );
  } else {
    response.setHeader("content-type", "text/html");
    response.end(
      '<!doctype html><html data-theme="dark"><head><link rel="stylesheet" href="/app.css"></head>' +
        '<body><div id="root" style="width:100%;height:100vh;overflow:auto"></div><script src="/app.js"></script></body></html>',
    );
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({ headless: true });
const newPage = async (options) => {
  const page = await browser.newPage(options);
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.origin === baseUrl || url.protocol === "data:" ? route.continue() : route.abort();
  });
  return page;
};
const pageErrors = [];
try {
  for (const width of [1440, 390]) {
    const page = await newPage({ viewport: { width, height: 900 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(baseUrl + "/?count=120&off");
    const cards = page.locator(".mari-gallery-card");
    await cards.nth(119).waitFor();
    assert.equal(await cards.count(), 120, "Missing switch preserves the complete baseline list.");
    assert.equal(await page.getByRole("button", { name: "ui.chat.chatgallery.showMoreImages" }).count(), 0);
    await page.evaluate(() => window.setFeature(true));
    const more = page.getByRole("button", { name: "ui.chat.chatgallery.showMoreImages" });
    await more.waitFor();
    assert.equal(await cards.count(), 48);
    await more.evaluate((button) => {
      const key = Object.keys(button).find((key) => key.startsWith("__reactProps"));
      window.retainedMore = button[key].onClick;
    });
    await cards.locator("button").first().click();
    const next = page.getByRole("button", { name: "ui.chat.chatimagelightbox.nextImage" });
    await next.waitFor();
    await next.evaluate((button) => {
      const key = Object.keys(button).find((key) => key.startsWith("__reactProps"));
      window.retainedNext = button[key].onClick;
    });
    await page.evaluate(() => {
      window.setFeature(false);
      window.retainedMore();
      window.retainedNext();
    });
    await next.waitFor({ state: "detached" });
    assert.match(await page.getByRole("dialog").locator("img").getAttribute("src"), /\/0\.png$/);
    await page.keyboard.press("ArrowRight");
    assert.match(await page.getByRole("dialog").locator("img").getAttribute("src"), /\/0\.png$/);
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await cards.count(), 120);
    await page.evaluate(() => window.setFeature(true));
    await more.waitFor();
    assert.equal(await cards.count(), 48, "Stale show-more callback must not change retained paging state.");
    await page.evaluate(() => window.failFeature());
    await more.waitFor({ state: "detached" });
    assert.equal(await cards.count(), 120, "Cached ON fails closed after query error.");
    await page.getByRole("searchbox", { name: "ui.chat.chatgallery.searchGalleryImages" }).fill("Synthetic image");
    const search = page.getByRole("region", { name: "ui.chat.chatgallery.galleryImageSearchResults" });
    await search.locator(".grid button").nth(119).waitFor();
    assert.equal(await search.locator(".grid button").count(), 120, "Baseline search remains available while OFF.");
    await page.close();
  }
  const mobile = await newPage({ viewport: { width: 390, height: 844 } });
  mobile.on("pageerror", (error) => pageErrors.push(error.message));
  await mobile.goto(baseUrl + "/?count=3547");
  await mobile.locator(".mari-gallery-card").first().waitFor();
  await mobile.locator(".mari-gallery-card picture source").first().waitFor({ state: "attached" });
  const initialRender = await mobile.evaluate(() => ({
    cards: document.querySelectorAll(".mari-gallery-card").length,
    nodes: document.querySelectorAll("*").length,
    elapsed: performance.now() - window.galleryStarted,
  }));
  assert.equal(initialRender.cards, 48);
  const mobilePreviewSourceSet = await mobile
    .locator(".mari-gallery-card picture source")
    .first()
    .getAttribute("srcset");
  assert.match(mobilePreviewSourceSet, /w=320$/);
  const darkColorScheme = await mobile.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  assert.equal(darkColorScheme, "dark");

  await mobile.locator(".mari-gallery-card button").first().click();
  const dialog = mobile.getByRole("dialog");
  const preview = dialog.locator("img");
  const closeButton = dialog.getByRole("button", { name: "ui.chat.chatimagelightbox.closeImage" });
  await closeButton.waitFor();
  const closeButtonFocused = await closeButton.evaluate((button) => button === document.activeElement);
  assert.equal(closeButtonFocused, true);
  assert.match(await preview.getAttribute("src"), /\/0\.png$/);
  await mobile.getByRole("button", { name: "ui.chat.chatimagelightbox.previousImage" }).waitFor();
  assert.equal(
    await mobile.getByRole("button", { name: "ui.chat.chatimagelightbox.previousImage" }).isDisabled(),
    true,
  );
  await mobile.keyboard.press("ArrowLeft");
  assert.match(await preview.getAttribute("src"), /\/0\.png$/, "The first-image boundary should stay in place.");
  await mobile.keyboard.press("ArrowRight");
  assert.match(await preview.getAttribute("src"), /\/1\.png$/);
  await mobile.keyboard.press("ArrowLeft");
  for (let index = 0; index < 49; index++) await mobile.keyboard.press("ArrowRight");
  assert.match(
    await preview.getAttribute("src"),
    /\/49\.png$/,
    "Arrow browsing must reach images beyond the first page.",
  );
  for (let index = 0; index < 47; index++) await mobile.keyboard.press("ArrowRight");
  assert.match(await preview.getAttribute("src"), /\/96\.png$/);
  assert.equal(
    await mobile.getByRole("button", { name: "ui.chat.chatimagelightbox.nextImage" }).isDisabled(),
    false,
    "Image 96 is not the end of the full gallery.",
  );
  await mobile.keyboard.press("ArrowRight");
  assert.match(await preview.getAttribute("src"), /\/97\.png$/, "Paging must not limit lightbox navigation.");
  const navigatedFromIndex96To97 = /\/97\.png$/.test(await preview.getAttribute("src"));
  await mobile.keyboard.press("Escape");
  assert.equal(await mobile.getByRole("dialog").count(), 0);

  await mobile.getByRole("button", { name: "ui.chat.chatgallery.showMoreImages" }).click();
  const galleryCardsAfterPaging = await mobile.locator(".mari-gallery-card").count();
  assert.equal(galleryCardsAfterPaging, 96);
  await mobile.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  const lightColorScheme = await mobile.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  assert.equal(lightColorScheme, "light");
  await mobile.setViewportSize({ width: 1440, height: 900 });
  const desktop = await mobile.evaluate(() => ({
    viewportWidth: window.innerWidth,
    previewSource: document.querySelector(".mari-gallery-card picture source").srcset,
    currentSource: document.querySelector(".mari-gallery-card img").currentSrc,
  }));
  assert.equal(desktop.viewportWidth, 1440);
  assert.match(desktop.previewSource, /w=320$/);
  assert.doesNotMatch(desktop.currentSource, /w=320$/, "Desktop should load the original image URL.");
  await mobile.getByRole("searchbox", { name: "ui.chat.chatgallery.searchGalleryImages" }).fill("Synthetic image");
  const searchResults = mobile.getByRole("region", { name: "ui.chat.chatgallery.galleryImageSearchResults" });
  await searchResults.locator(".grid button").first().waitFor();
  assert.equal(await searchResults.locator(".grid button").count(), 48);
  await searchResults.getByRole("button", { name: "ui.chat.chatgallery.showMoreImages" }).click();
  const searchCardsAfterPaging = await searchResults.locator(".grid button").count();
  assert.equal(searchCardsAfterPaging, 96);
  await mobile.getByRole("button", { name: "ui.chat.chatgallery.clearGallerySearch" }).click();

  const boundaryPage = await newPage({ viewport: { width: 390, height: 844 } });
  boundaryPage.on("pageerror", (error) => pageErrors.push(error.message));
  await boundaryPage.goto(baseUrl + "/?count=2");
  await boundaryPage.locator(".mari-gallery-card button").first().click();
  const boundaryDialog = boundaryPage.getByRole("dialog");
  const boundaryPreview = boundaryDialog.locator("img");
  const previousButton = boundaryPage.getByRole("button", {
    name: "ui.chat.chatimagelightbox.previousImage",
  });
  const nextButton = boundaryPage.getByRole("button", { name: "ui.chat.chatimagelightbox.nextImage" });
  const firstNavigationDisabled = await previousButton.isDisabled();
  assert.equal(firstNavigationDisabled, true);
  await boundaryPage.keyboard.press("ArrowLeft");
  const firstBoundarySrc = await boundaryPreview.getAttribute("src");
  assert.match(firstBoundarySrc, /\/0\.png$/, "The first-image boundary should hold.");
  await boundaryPage.keyboard.press("ArrowRight");
  assert.match(await boundaryPreview.getAttribute("src"), /\/1\.png$/);
  const lastNavigationDisabled = await nextButton.isDisabled();
  assert.equal(lastNavigationDisabled, true);
  await boundaryPage.keyboard.press("ArrowRight");
  const lastBoundarySrc = await boundaryPreview.getAttribute("src");
  assert.match(lastBoundarySrc, /\/1\.png$/, "The last-image boundary should hold.");
  await boundaryPage.keyboard.press("Escape");
  const boundaryDialogClosed = (await boundaryDialog.count()) === 0;
  assert.equal(boundaryDialogClosed, true);

  const emptyPage = await newPage({ viewport: { width: 1280, height: 800 } });
  emptyPage.on("pageerror", (error) => pageErrors.push(error.message));
  await emptyPage.goto(baseUrl + "/?count=0");
  const emptyState = emptyPage.getByText("ui.chat.chatgallery.noImagesYet");
  await emptyState.waitFor();
  const emptyStateVisible = await emptyState.isVisible();
  const emptyGalleryCardCount = await emptyPage.locator(".mari-gallery-card").count();
  assert.equal(emptyGalleryCardCount, 0);

  const errorPage = await newPage({ viewport: { width: 390, height: 844 } });
  errorPage.on("pageerror", (error) => pageErrors.push(error.message));
  await errorPage.route("**/api/gallery/file/**", (route) => route.fulfill({ status: 404, body: "Not found" }));
  await errorPage.goto(baseUrl + "/?count=1");
  const failedImage = errorPage.locator(".mari-gallery-card img").first();
  await failedImage.waitFor();
  await failedImage.evaluate(
    (image) =>
      new Promise((resolve) => {
        if (image.complete) resolve();
        else image.addEventListener("error", resolve, { once: true });
      }),
  );
  const errorGalleryCardCount = await errorPage.locator(".mari-gallery-card").count();
  const failedImageNaturalWidth = await failedImage.evaluate((image) => image.naturalWidth);
  assert.equal(errorGalleryCardCount, 1);
  assert.equal(failedImageNaturalWidth, 0);
  assert.deepEqual(pageErrors, []);

  await writeFile(
    path.join(proofDir, "gallery-result.json"),
    JSON.stringify({
      css: { source: "packages/client/dist/index.html", files: stylePaths, sha256: stylesSha256 },
      mobile: { viewportWidth: 390, previewSourceSet: mobilePreviewSourceSet, darkColorScheme, closeButtonFocused },
      desktop,
      lightColorScheme,
      paging: { initialCards: initialRender.cards, galleryCardsAfterPaging, searchCardsAfterPaging },
      lightbox: { navigatedFromIndex96To97 },
      boundaries: {
        firstNavigationDisabled,
        lastNavigationDisabled,
        firstBoundarySrc,
        lastBoundarySrc,
        dialogClosed: boundaryDialogClosed,
      },
      empty: { visible: emptyStateVisible, cards: emptyGalleryCardCount },
      error: { cards: errorGalleryCardCount, failedImageNaturalWidth, pageErrors: pageErrors.length },
    }),
  );

  process.stdout.write(
    "Gallery fixture passed: built CSS, mobile/desktop previews, light/dark theme, close focus, paging, first/last keyboard boundaries, empty state, and failed-image rendering.\n",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
