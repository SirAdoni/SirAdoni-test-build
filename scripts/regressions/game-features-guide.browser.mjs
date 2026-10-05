import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium, webkit } from "@playwright/test";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import { relative, resolve } from "node:path";

const overlay = resolve("packages/client/src/components/chat/ChatHelpOverlay.tsx").replaceAll("\\", "/");
const events = resolve("packages/client/src/lib/chat-help-events.ts").replaceAll("\\", "/");
const english = JSON.parse(await fs.readFile(resolve("packages/client/src/localization/locales/en.json"), "utf8"));
const tempDirectory = await fs.mkdtemp(resolve(os.tmpdir(), "marinara-game-guide-"));
const evidenceDirectory = process.env.GAME_GUIDE_EVIDENCE_DIR;
if (evidenceDirectory) await fs.mkdir(evidenceDirectory, { recursive: true });
const clientAssets = await fs.readdir(resolve("packages/client/dist/assets"));
const clientCss = clientAssets.find((name) => /^index-.*\.css$/.test(name));
assert.ok(clientCss, "expected the existing client build to provide its CSS");
const css = await fs.readFile(resolve("packages/client/dist/assets", clientCss), "utf8");
const entryPath = resolve(tempDirectory, "entry.tsx");
const bundleDirectory = resolve(tempDirectory, "bundle");
await fs.writeFile(
  entryPath,
  `import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import{ChatHelpOverlay}from'${overlay}';import{requestChatHelp}from'${events}';const client=new QueryClient({defaultOptions:{queries:{retry:false}}});window.guideSettings=location.pathname.includes('optin')?{}:{gameGuide:true};window.setGuideFeatures=settings=>{window.guideSettings=settings;client.setQueryData(['features'],{settings});};window.failGuideFeatures=()=>client.getQueryCache().find({queryKey:['features']}).setState({status:'error',error:new Error('fixture offline')});function App(){return <><main id="game-root" data-chat-mode="game" style={{position:'fixed',inset:0,width:'100vw',height:'100vh'}}><button id="help-trigger" onClick={()=>requestChatHelp('game')}>Game help</button><button data-chat-help="help" style={{position:'absolute',left:24,top:160}}>Help control</button></main><ChatHelpOverlay mode="game" activeChatId="guide-fixture" isFirstChat={false} autoOpenBlocked={true}/></>};createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><App/></QueryClientProvider>);`,
);
const bundle = await build({
  entryPoints: [entryPath],
  outdir: bundleDirectory,
  entryNames: "entry",
  chunkNames: "chunks/[name]-[hash]",
  nodePaths: [resolve("packages/client/node_modules")],
  bundle: true,
  splitting: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  metafile: true,
  plugins: [
    {
      name: "production-overlay-fixture",
      setup(plugin) {
        plugin.onResolve({ filter: /\/api-client$/ }, () => ({ path: "api", namespace: "fixture" }));
        plugin.onResolve({ filter: /^react-i18next$/ }, () => ({ path: "translation", namespace: "fixture" }));
        plugin.onResolve({ filter: /\/stores\/ui\.store$/ }, () => ({ path: "ui-store", namespace: "fixture" }));
        plugin.onResolve({ filter: /localization\/use-localized-ui-text$/ }, () => ({
          path: "localized-ui-text",
          namespace: "fixture",
        }));
        plugin.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => {
          if (args.path === "api")
            return { contents: `export const api={get:async()=>({settings:window.guideSettings})};` };
          if (args.path === "translation") {
            return {
              contents: `const MAP=${JSON.stringify(english)};export const useTranslation=()=>({t:(key,values)=>{let value=MAP[key]??key;for(const[name,replacement]of Object.entries(values??{}))value=value.split('{{'+name+'}}').join(String(replacement));return value;}});`,
            };
          }
          if (args.path === "ui-store") {
            return {
              contents: `const state={chatHelpSeenModes:[],chatHelpButtonHidden:false,markChatHelpSeen(){},setChatHelpButtonHidden(){}};export const useUIStore=(selector)=>selector(state);`,
            };
          }
          if (args.path === "localized-ui-text") {
            return { contents: `export const useLocalizedUiText=()=>value=>value;` };
          }
          return null;
        });
      },
    },
  ],
});

const assets = new Map(
  bundle.outputFiles.map((file) => [relative(bundleDirectory, file.path).replaceAll("\\", "/"), file]),
);
const gameGuideChunk = Object.values(bundle.metafile.outputs)
  .flatMap((output) => output.imports)
  .find((item) => item.kind === "dynamic-import" && item.path.includes("GameFeaturesGuide"))?.path;
assert.ok(gameGuideChunk, "expected GameFeaturesGuide to remain an actual lazy browser chunk");
const guideAssetKeys = [...assets.keys()].filter(
  (key) => gameGuideChunk.replaceAll("\\", "/").endsWith(`/${key}`) || gameGuideChunk.replaceAll("\\", "/") === key,
);
assert.equal(guideAssetKeys.length, 1, "lazy guide chunk must resolve to exactly one served asset");
const normalizedGuideChunk = guideAssetKeys[0];
const guideChunkRequests = { delay: 0, failure: 0 };

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    const [, scenario, ...assetSegments] = url.pathname.split("/");
    const assetPath = assetSegments.join("/");
    if (!assetPath) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<html data-theme="light"><head><style>${css}</style></head><body><div id="root"></div><script type="module" src="/${scenario}/entry.js"></script></body></html>`,
      );
      return;
    }
    if (assetPath === normalizedGuideChunk && scenario === "delay") {
      guideChunkRequests.delay += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 700));
    }
    if (assetPath === normalizedGuideChunk && scenario === "failure") {
      guideChunkRequests.failure += 1;
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      response.end("Guide chunk unavailable for the isolated failure proof");
      return;
    }
    const asset = assets.get(assetPath);
    if (!asset) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    response.end(asset.contents);
  } catch (error) {
    response.writeHead(500);
    response.end(String(error));
  }
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const serverAddress = server.address();
assert.ok(serverAddress && typeof serverAddress === "object");
const serverUrl = `http://127.0.0.1:${serverAddress.port}`;

const browserType = process.env.GAME_GUIDE_BROWSER === "webkit" ? webkit : chromium;
const browser = await browserType.launch({ headless: true });
try {
  for (const width of [1100, 390]) {
    const optin = await browser.newPage({ viewport: { width, height: 844 } });
    const chunks = [];
    optin.on("request", (request) => {
      if (request.url().includes("GameFeaturesGuide")) chunks.push(request.url());
    });
    await optin.goto(`${serverUrl}/optin/`);
    await optin.locator("#help-trigger").click();
    if (width < 600) await optin.locator('[data-chat-help-highlight="help"]').click();
    await optin.locator(width < 600 ? '[data-chat-help-mobile-detail="help"]' : "[data-chat-help-legend]").waitFor();
    assert.equal(await optin.getByRole("button", { name: "Open guide" }).count(), 0);
    assert.equal(chunks.length, 0, "missing switch does not fetch the guide chunk");
    await optin.evaluate(() => window.setGuideFeatures({ gameGuide: true }));
    await optin.getByRole("button", { name: "Open guide" }).click();
    await optin.getByRole("heading", { name: "Read the map" }).waitFor();
    await optin.evaluate(() => window.setGuideFeatures({ gameGuide: false }));
    await optin.getByRole("heading", { name: "Read the map" }).waitFor({ state: "detached" });
    assert.equal(await optin.getByRole("button", { name: "Open guide" }).count(), 0);
    await optin.waitForFunction(() => {
      const help = document.querySelector('[data-chat-help-overlay="game"]');
      return document.activeElement?.isConnected && help?.contains(document.activeElement);
    });
    await optin.keyboard.press("Escape");
    await optin
      .locator(width < 600 ? '[data-chat-help-mobile-detail="help"]' : "[data-chat-help-legend]")
      .waitFor({ state: "detached" });
    await optin.locator("#help-trigger").click();
    if (width < 600) await optin.locator('[data-chat-help-highlight="help"]').click();
    await optin.evaluate(() => window.setGuideFeatures({ gameGuide: true }));
    await optin.getByRole("button", { name: "Open guide" }).waitFor();
    await optin.evaluate(() => {
      const element = [...document.querySelectorAll("button")].find(
        (button) => button.textContent.trim() === "Open guide",
      );
      const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
      const retainedClick = element[propsKey].onClick;
      window.setGuideFeatures({ gameGuide: false });
      retainedClick();
    });
    await optin.getByRole("button", { name: "Open guide" }).waitFor({ state: "detached" });
    assert.equal(await optin.getByRole("heading", { name: "Read the map" }).count(), 0);
    await optin.evaluate(() => window.setGuideFeatures({ gameGuide: true }));
    await optin.getByRole("button", { name: "Open guide" }).waitFor();
    await optin.evaluate(() => window.failGuideFeatures());
    await optin.getByRole("button", { name: "Open guide" }).waitFor({ state: "detached" });
    assert.equal(await optin.getByRole("button", { name: "Open guide" }).count(), 0);
    await optin.close();
  }
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.setDefaultTimeout(10000);
  await page.goto(`${serverUrl}/delay/`);
  await page.locator("#help-trigger").click();
  await page.locator("[data-chat-help-legend]").waitFor();
  await page.getByRole("button", { name: "Open guide" }).click();
  const loadingDialog = page.getByRole("dialog", { name: "Game mode guide" });
  await page.getByRole("status").getByText(english["gameGuide.loading"]).waitFor();
  assert.equal(await loadingDialog.isVisible(), true);
  await page.keyboard.press("Escape");
  await page.getByRole("status").waitFor({ state: "detached" });
  assert.equal(await page.locator("[data-chat-help-legend]").isVisible(), true);
  assert.equal(
    await page.getByRole("button", { name: "Open guide" }).evaluate((element) => document.activeElement === element),
    true,
  );
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Open guide" }).click();

  const guideDialog = page.locator('[role="dialog"][aria-labelledby]');
  await guideDialog.filter({ has: page.getByRole("heading", { name: "Read the map" }) }).waitFor();
  assert.equal(
    await guideDialog.evaluate((element) => element.contains(document.activeElement)),
    true,
    "cached guide opening must move focus into its dialog",
  );
  assert.equal(guideChunkRequests.delay, 1);
  assert.equal(await page.getByRole("button", { name: "Previous" }).isDisabled(), true);
  assert.equal(await page.getByRole("combobox", { name: "Guide chapters" }).isVisible(), false);
  assert.equal(await page.getByRole("navigation", { name: "Guide chapters" }).isVisible(), true);
  assert.equal(await guideDialog.getByRole("heading", { name: "Read the map" }).count(), 1);
  assert.match(await guideDialog.locator("article").innerText(), /empty map means no map data is currently available/i);
  if (evidenceDirectory) await page.screenshot({ path: resolve(evidenceDirectory, "game-guide-desktop-light.png") });

  await page.getByRole("button", { name: /Status and widgets/ }).click();
  assert.equal(await guideDialog.getByRole("heading", { name: "Status and widgets" }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "Previous" }).isDisabled(), false);
  assert.equal(await page.getByRole("button", { name: "Next" }).isDisabled(), true);
  await page.keyboard.press("Escape");
  await guideDialog.waitFor({ state: "detached" });
  assert.equal(await page.locator("[data-chat-help-legend]").isVisible(), true);
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Open guide");
  assert.equal(
    await page.getByRole("button", { name: "Open guide" }).evaluate((element) => document.activeElement === element),
    true,
  );
  await page.keyboard.press("Escape");
  await page.locator("[data-chat-help-legend]").waitFor({ state: "detached" });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.locator("#help-trigger").click();
  await page.locator('[data-chat-help-highlight="help"]').click();
  await page.locator('[data-chat-help-mobile-detail="help"]').waitFor();
  await page.getByRole("button", { name: "Open guide" }).click();
  await guideDialog.waitFor();
  const darkBackground = await guideDialog.evaluate(
    (element) => getComputedStyle(element.firstElementChild).backgroundColor,
  );
  const chapterSelect = page.getByRole("combobox", { name: "Guide chapters" });
  assert.equal(await chapterSelect.isVisible(), true);
  assert.equal(await page.getByRole("navigation", { name: "Guide chapters" }).isVisible(), false);
  if (evidenceDirectory) await page.screenshot({ path: resolve(evidenceDirectory, "game-guide-mobile-dark.png") });
  await chapterSelect.selectOption("1");
  assert.equal(await guideDialog.getByRole("heading", { name: "Status and widgets" }).count(), 1);
  const lightBackground = await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "light");
    return getComputedStyle(document.querySelector('[role="dialog"][aria-labelledby]').firstElementChild)
      .backgroundColor;
  });
  assert.notEqual(darkBackground, lightBackground);
  await page.getByRole("button", { name: "Close game mode guide" }).click();
  await guideDialog.waitFor({ state: "detached" });
  assert.equal(await page.locator('[data-chat-help-mobile-detail="help"]').isVisible(), true);
  await page.keyboard.press("Escape");
  await page.locator('[data-chat-help-mobile-detail="help"]').waitFor({ state: "detached" });

  const failurePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  failurePage.setDefaultTimeout(10000);
  await failurePage.goto(`${serverUrl}/failure/`);
  await failurePage.locator("#help-trigger").click();
  await failurePage.locator('[data-chat-help-highlight="help"]').click();
  await failurePage.locator('[data-chat-help-mobile-detail="help"]').waitFor();
  await failurePage.getByRole("button", { name: "Open guide" }).click();
  const errorDialog = failurePage.getByRole("dialog", { name: "Game mode guide" });
  await failurePage.getByRole("alert").getByText(english["gameGuide.loadError"]).waitFor();
  assert.equal(guideChunkRequests.failure, 1);
  assert.equal(await errorDialog.isVisible(), true);
  await failurePage.keyboard.press("Escape");
  await failurePage.getByRole("alert").waitFor({ state: "detached" });
  assert.equal(await failurePage.locator('[data-chat-help-mobile-detail="help"]').isVisible(), true);
  await failurePage.keyboard.press("Escape");
  await failurePage.locator('[data-chat-help-mobile-detail="help"]').waitFor({ state: "detached" });
  await failurePage.locator("#help-trigger").click();
  await failurePage.locator('[data-chat-help-highlight="help"]').click();
  await failurePage.locator('[data-chat-help-mobile-detail="help"]').waitFor();
  assert.equal(await failurePage.getByRole("button", { name: "Open guide" }).isVisible(), true);
  console.info(
    "Game guide integration check: delayed and rejected lazy chunks, closable localized states, Help recovery, desktop/mobile navigation, themes, and keyboard behavior passed.",
  );
} finally {
  await browser.close();
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  await fs.rm(tempDirectory, { recursive: true, force: true });
}
