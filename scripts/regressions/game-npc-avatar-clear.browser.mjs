// Production mutation hook, local store, and rendered Contact Book; no live service.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { buildClientCss } from "../ui-fixtures/lib/build-client-css.mjs";

const temp = await fs.mkdtemp(resolve(os.tmpdir(), "me-avatar-clear-ui-"));
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
  const cssPath = resolve(temp, "client.css");
  await buildClientCss(cssPath);
  const fixture = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {useRemoveAvatar, useUploadAvatar} from '${path("hooks/use-characters.ts")}';
import {useGameModeStore} from '${path("stores/game-mode.store.ts")}';
import {GameContactBookWidget} from '${path("components/game/GameContactBookWidget.tsx")}';
import {CharacterEditor} from '${path("components/characters/CharacterEditor.tsx")}';
import {AppDialogRenderer} from '${path("components/ui/AppDialogRenderer.tsx")}';
import {useUIStore} from '${path("stores/ui.store.ts")}';
import {buildCampaignPortraitRosterCandidates,buildCampaignPortraitBatches} from '${path("components/game/game-asset-generation-payload.ts")}';
const seed=${JSON.stringify(npcs)};
useGameModeStore.setState({activeSessionChatId:'chat-main',npcs:seed});
useUIStore.setState({characterDetailId:'char-main',characterDetailInitialTab:'metadata'});
const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
window.fixture={stale:()=>useGameModeStore.getState().setNpcs(seed)};
function App(){
  const remove=useRemoveAvatar(), upload=useUploadAvatar();
  const roster=useGameModeStore(s=>s.npcs);
  const editor=new URLSearchParams(location.search).has('editor');
  const [showContacts,setShowContacts]=useState(!editor);
  const candidates=buildCampaignPortraitRosterCandidates(roster.map(n=>({...n,description:''})),seed.map(n=>({...n,description:''})),[],new Set());
  const missing=buildCampaignPortraitBatches(candidates,new Map(),'fixture').flatMap(b=>b.candidates.map(n=>n.npcId));
  return <>
    <div style={{position:'fixed',top:0,left:0,zIndex:99999,background:'white',color:'black'}}>
      {!editor&&<button onClick={()=>remove.mutate('char-main')}>Remove fixture portrait</button>}
      <button onClick={()=>upload.mutate({id:'char-main',avatar:'data:image/png;base64,fixture'})}>Assign fixture portrait</button>
      <button onClick={()=>setShowContacts(true)}>Show fixture contacts</button>
      <output data-testid="missing-state">{JSON.stringify(missing)}</output>
      <output data-testid="main-state">{JSON.stringify(roster.find(n=>n.id==='npc-main'))}</output>
      <output data-testid="control-state">{JSON.stringify(roster.find(n=>n.id==='npc-control'))}</output>
    </div>
    {editor&&<div style={{height:'800px',paddingTop:'100px'}}><CharacterEditor/><AppDialogRenderer/></div>}
    <GameContactBookWidget chatId="chat-main" campaignKey="fixture" open={showContacts} onClose={()=>setShowContacts(false)} />
  </>;
}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><App/></QueryClientProvider>);
`;
  const bundle = await build({
    stdin: { contents: fixture, loader: "tsx", resolveDir: process.cwd() },
    nodePaths: [resolve("packages/client/node_modules")],
    bundle: true, write: false, format: "iife", jsx: "automatic", logLevel: "error",
    loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".jpg": "dataurl" },
    define: { "import.meta.env": "{}", "import.meta.env.DEV": "false", "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "fixture-locales", setup(plugin) {
      plugin.onLoad({ filter: /locale-loader\.ts$/ }, async (args) => ({
        contents: (await fs.readFile(args.path, "utf8")).replace("import.meta.glob<string>", "((..._args: unknown[]) => ({ './locales/en.json': async () => '' }))"), loader: "ts",
      }));
      plugin.onResolve({ filter: /^react-i18next$/ }, () => ({ path: "translation", namespace: "fixture" }));
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: `const MAP=${JSON.stringify(english)};const t=(k)=>MAP[k]??k;const i18n={language:'en',resolvedLanguage:'en',dir:()=>'ltr',t};export const initReactI18next={type:'3rdParty',init(){}};export const useTranslation=()=>({i18n,t});export const Trans=({children})=>children;`, loader: "js",
      }));
    }}],
  });
  const css = await fs.readFile(cssPath, "utf8");
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`;
  browser = await chromium.launch({ headless: true });
  for (const width of [390, 1280]) for (const editor of [false, true]) {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    let revision = 0, avatar = oldAvatar, contactReads = 0;
    const errors = [];
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: html });
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0].text });
      if (url.pathname === "/api/character-usage/char-main") return route.fulfill({ json: { characterId: "char-main", chats: [], games: [], lastActivityAt: null, messageCounts: null, messageCountsTruncated: false } });
      if (url.pathname === "/api/characters/char-main") return route.fulfill({json:{id:'char-main',avatarPath:avatar,data:JSON.stringify({name:'Alex',description:'Fixture NPC',personality:'',scenario:'',first_mes:'',mes_example:'',creator_notes:'',system_prompt:'',post_history_instructions:'',tags:[],creator:'',character_version:'1',alternate_greetings:[],extensions:{},character_book:null})}});
      if (url.pathname === "/api/characters/char-main/avatar") {
        revision += 1;
        avatar = route.request().method() === "DELETE" ? null : newAvatar;
        return route.fulfill({ json: { id: "char-main", avatarPath: avatar, avatarState: { revision, removed: !avatar }, affectedChatIds: ["chat-main"] } });
      }
      if (url.pathname.endsWith("/contacts")) {
        contactReads += 1;
        return route.fulfill({ json: { contacts: [
          { id: "char-main", characterId: "char-main", name: "Alex", ...(avatar ? {avatar} : {}), automaticCategories: ["known"], evidenceMessageIds: [] },
          { id: "char-control", characterId: "char-control", name: "Control", avatar: controlAvatar, automaticCategories: ["known"], evidenceMessageIds: [] },
        ], coverage: { complete: true, pendingSessions: 0 } } });
      }
      if (url.pathname.includes("/avatars/")) return route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5d8AAAAASUVORK5CYII=", "base64") });
      return route.fulfill({ json: [] });
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
    await page.goto(`http://fixture.test/${editor ? '?editor' : ''}`);
    await page.locator(`img[src*="old-fixture.png"]`).first().waitFor();
    const before = contactReads;
    if (editor) {
      await page.getByTitle(english['ui.ui.avatarcropwidget.removeAvatar'],{exact:true}).click({timeout:10000}).catch(async(error)=>{
        throw new Error(`${error.message}; pageErrors=${JSON.stringify(errors)}; rendered=${(await page.locator('body').innerText()).slice(0,5000)}; buttons=${JSON.stringify(await page.getByRole('button').evaluateAll(buttons=>buttons.map(button=>({text:button.textContent,title:button.title,aria:button.getAttribute('aria-label')}))))}`);
      });
      await page.getByRole('dialog').getByRole('button',{name:english['settings.notifications.customSound.actions.remove'],exact:true}).click();
    } else await page.getByRole("button", { name: "Remove fixture portrait", exact: true }).click();
    await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="main-state"]').textContent).avatarState?.removed === true);
    await page.waitForFunction(() => !document.querySelector('img[src*="old-fixture.png"]'));
    if (editor) await page.getByRole('button',{name:'Show fixture contacts',exact:true}).click();
    await page.getByText('Control',{exact:true}).waitFor();
    assert.ok(contactReads > before, `${width}: deletion invalidates or opens fresh rendered Contact Book`);
    await page.evaluate(() => window.fixture.stale());
    const cleared = JSON.parse(await page.getByTestId("main-state").textContent());
    assert.equal(cleared.avatarState.removed, true);
    assert.ok(!cleared.avatarUrl, `${width}: stale local roster cannot resurrect removed portrait`);
    assert.deepEqual(JSON.parse(await page.getByTestId('missing-state').textContent()),['npc-main'],`${width}: actual missing-portrait selector includes cleared NPC only`);
    assert.equal(JSON.parse(await page.getByTestId("control-state").textContent()).avatarUrl, controlAvatar, `${width}: same-name control unchanged`);
    await page.getByRole("button", { name: "Assign fixture portrait", exact: true }).click();
    await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="main-state"]').textContent).avatarState?.revision === 2);
    await page.locator(`img[src*="new-fixture.png"]`).first().waitFor();
    await page.evaluate(() => window.fixture.stale());
    assert.ok(JSON.parse(await page.getByTestId("main-state").textContent()).avatarUrl.includes("new-fixture.png"), `${width}: later assignment survives stale refresh`);
    assert.deepEqual(JSON.parse(await page.getByTestId('missing-state').textContent()),[],`${width}: explicit assignment removes NPC from missing selector`);
    assert.deepEqual(errors, [], `${width}: no rendered runtime errors`);
    await context.close();
  }
  console.log("game NPC avatar clear browser: ok (390, 1280; hook and actual CharacterEditor Remove/confirmation)");
} finally {
  await browser?.close();
  await fs.rm(temp, { recursive: true, force: true });
}
