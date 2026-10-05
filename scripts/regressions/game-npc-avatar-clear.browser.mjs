// Synthetic CharacterEditor remove flow with the production mutation hook and game-mode store.
// This proves client UI/cache behavior only; requests never reach the Engine or an image provider.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import { resolve } from "node:path";

const path = (file) => resolve("packages/client/src", file).replaceAll("\\", "/");
const oldAvatar = "/api/avatars/file/old-fixture.png";
const newAvatar = "/api/avatars/file/new-fixture.png";
const controlAvatar = "/api/avatars/file/control-fixture.png";
const npcs = [
  { id: "npc-main", characterId: "char-main", name: "Alex", avatarUrl: oldAvatar },
  { id: "npc-control", characterId: "char-control", name: "Alex", avatarUrl: controlAvatar },
];
const english = JSON.parse(await fs.readFile(resolve("packages/client/src/localization/locales/en.json"), "utf8"));
let browser;
try {
  const assetsDir = resolve("packages/client/dist/assets");
  const stylesheets = (await fs.readdir(assetsDir)).filter((file) => /^index-.*\.css$/.test(file));
  assert.equal(stylesheets.length, 1, "Build the isolated client before running this browser proof.");
  const css = await fs.readFile(resolve(assetsDir, stylesheets[0]), "utf8");
  const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider,useQuery} from '@tanstack/react-query';
import {api} from '${path("lib/api-client.ts")}';
import {useUploadAvatar} from '${path("hooks/use-characters.ts")}';
import {chatKeys} from '${path("hooks/use-chats.ts")}';
import {useGameModeStore} from '${path("stores/game-mode.store.ts")}';
import {CharacterEditor} from '${path("components/characters/CharacterEditor.tsx")}';
import {AppDialogRenderer} from '${path("components/ui/AppDialogRenderer.tsx")}';
import {useUIStore} from '${path("stores/ui.store.ts")}';
const seed=${JSON.stringify(npcs)};
useGameModeStore.setState({activeSessionChatId:'chat-main',npcs:seed});
useUIStore.setState({characterDetailId:'char-main',characterDetailInitialTab:'metadata'});
const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
window.fixture={stale:()=>useGameModeStore.getState().setNpcs(seed)};
function ChatReadout(){const q=useQuery({queryKey:chatKeys.detail('chat-main'),queryFn:()=>api.get('/chats/chat-main'),staleTime:Infinity});return <output data-testid="chat-read">{q.data?.fixtureRead ?? 0}</output>}
function App(){
 const upload=useUploadAvatar();
 const roster=useGameModeStore(s=>s.npcs);
 return <>
  <div style={{position:'fixed',top:0,left:0,zIndex:99999,background:'white',color:'black'}}>
   <button onClick={()=>upload.mutate({id:'char-main',avatar:'data:image/png;base64,fixture'})}>Assign fixture portrait</button>
   <output data-testid="main-state">{JSON.stringify(roster.find(n=>n.id==='npc-main'))}</output>
   <output data-testid="control-state">{JSON.stringify(roster.find(n=>n.id==='npc-control'))}</output>
  </div>
  <div style={{height:'800px',paddingTop:'100px'}}><CharacterEditor/><AppDialogRenderer/></div>
  <ChatReadout/>
 </>;
}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><App/></QueryClientProvider>);
`;
  const bundle = await build({
    stdin: { contents: fixture, loader: "tsx", resolveDir: process.cwd() },
    nodePaths: [resolve("packages/client/node_modules")],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    logLevel: "error",
    loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".jpg": "dataurl" },
    define: { "import.meta.env": "{}", "import.meta.env.DEV": "false", "process.env.NODE_ENV": '"production"' },
    plugins: [{
      name: "fixture-locales",
      setup(plugin) {
        plugin.onLoad({ filter: /locale-loader\.ts$/ }, async (args) => ({
          contents: (await fs.readFile(args.path, "utf8")).replace("import.meta.glob<string>", "((..._args: unknown[]) => ({ './locales/en.json': async () => '' }))"),
          loader: "ts",
        }));
        plugin.onResolve({ filter: /^react-i18next$/ }, () => ({ path: "translation", namespace: "fixture" }));
        plugin.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: `const MAP=${JSON.stringify(english)};const t=(k)=>MAP[k]??k;const i18n={language:'en',resolvedLanguage:'en',dir:()=>'ltr',t};export const initReactI18next={type:'3rdParty',init(){}};export const useTranslation=()=>({i18n,t});export const Trans=({children})=>children;`,
          loader: "js",
        }));
      },
    }],
  });
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`;
  browser = await chromium.launch({ headless: true });
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    let revision = 0;
    let avatar = oldAvatar;
    let chatReads = 0;
    const errors = [];
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: html });
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0].text });
      if (url.pathname === "/api/character-usage/char-main") return route.fulfill({ json: { characterId: "char-main", chats: [], games: [], lastActivityAt: null, messageCounts: null, messageCountsTruncated: false } });
      if (url.pathname === "/api/characters/char-main") return route.fulfill({ json: { id: "char-main", avatarPath: avatar, data: JSON.stringify({ name: "Alex", description: "Fixture NPC", personality: "", scenario: "", first_mes: "", mes_example: "", creator_notes: "", system_prompt: "", post_history_instructions: "", tags: [], creator: "", character_version: "1", alternate_greetings: [], extensions: {}, character_book: null }) } });
      if (url.pathname === "/api/characters/char-main/avatar") {
        revision += 1;
        avatar = route.request().method() === "DELETE" ? null : newAvatar;
        return route.fulfill({ json: { id: "char-main", avatarPath: avatar, avatarState: { revision, removed: !avatar }, affectedChatIds: ["chat-main"] } });
      }
      if (url.pathname === "/api/chats/chat-main") {
        chatReads += 1;
        return route.fulfill({ json: { fixtureRead: chatReads } });
      }
      if (url.pathname.includes("/avatars/")) return route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5d8AAAAASUVORK5CYII=", "base64") });
      return route.fulfill({ json: [] });
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
    await page.goto("http://fixture.test/");
    await page.locator(`img[src*="old-fixture.png"]`).first().waitFor();
    const before = chatReads;
    await page.getByTitle(english["ui.ui.avatarcropwidget.removeAvatar"], { exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: english["settings.notifications.customSound.actions.remove"], exact: true }).click();
    await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="main-state"]').textContent).avatarState?.removed === true);
    await page.waitForFunction(() => !document.querySelector('img[src*="old-fixture.png"]'));
    await page.waitForFunction((previous) => Number(document.querySelector('[data-testid="chat-read"]').textContent) > previous, before);
    await page.evaluate(() => window.fixture.stale());
    const cleared = JSON.parse(await page.getByTestId("main-state").textContent());
    assert.equal(cleared.avatarState.removed, true, `${width}: stale local roster cannot resurrect a removed portrait`);
    assert.ok(!cleared.avatarUrl, `${width}: removal clears the active local URL`);
    assert.equal(JSON.parse(await page.getByTestId("control-state").textContent()).avatarUrl, controlAvatar, `${width}: same-name control remains unchanged`);
    await page.getByRole("button", { name: "Assign fixture portrait", exact: true }).click();
    await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="main-state"]').textContent).avatarState?.revision === 2);
    await page.locator(`img[src*="new-fixture.png"]`).first().waitFor();
    await page.evaluate(() => window.fixture.stale());
    assert.ok(JSON.parse(await page.getByTestId("main-state").textContent()).avatarUrl.includes("new-fixture.png"), `${width}: later assignment survives stale metadata`);
    assert.deepEqual(errors, [], `${width}: no rendered runtime errors`);
    await context.close();
  }
  console.log("game NPC avatar CharacterEditor clear browser: ok (390, 1280; synthetic API, no live/provider requests)");
} finally {
  await browser?.close();
}
