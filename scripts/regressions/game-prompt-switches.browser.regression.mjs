import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const client = resolve("packages/client").replaceAll("\\", "/");
const labels = JSON.parse(readFileSync(`${client}/src/localization/locales/en.json`, "utf8"));
const bundle = await build({
  stdin: {
    contents: `
      import React,{useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
      import {GamePromptRequestEditor} from '${client}/src/features/chat-settings/sections/GamePromptRequestEditor.tsx';
      import {GmReasoningEffortSection} from '${client}/src/features/chat-settings/sections/GmReasoningEffortSection.tsx';
      import {useUIStore} from '${client}/src/stores/ui.store.ts';
      const qc=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
      window.__setFeatures=(settings)=>{window.__settings=settings;qc.setQueryData(['features'],{settings,envOverrides:{}});};
      window.__featureError=()=>qc.getQueryCache().find({queryKey:['features']}).setState({status:'error',error:new Error('fixture')});
      useUIStore.setState({chatSettingsExpandedSections:{'game-gm-reasoning-effort':true}});
      function App(){
        const [effort,setEffort]=useState('high');
        return <>
          <GamePromptRequestEditor chatId="fixture" existingEdits={[]} onClose={()=>{}}
            onSave={async(edits)=>{window.__saves.push(edits);}} onReset={async()=>{window.__resets++;}}/>
          <GmReasoningEffortSection value={effort} connection={{provider:'openai',model:'gpt-5'}}
            onChange={(value)=>{window.__efforts.push(value);setEffort(value);}}/>
        </>;
      }
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={qc}><App/></QueryClientProvider>);
    `,
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
      name: "isolated-game-prompt-settings",
      setup(api) {
        api.onResolve({ filter: /lib\/api-client$/ }, () => ({ path: "api", namespace: "fixture" }));
        api.onLoad({ filter: /^api$/, namespace: "fixture" }, () => ({
          resolveDir: process.cwd(),
          contents: `
        export { ApiError, isRequestTimeoutError, requestTimeoutSignal } from '${client}/src/lib/api-client.ts';
        export const api={
          get:async(path)=>{if(path!=='/app-settings/features')throw new Error(path);return {settings:window.__settings,envOverrides:{}};},
          post:async(path)=>{if(path!=='/chats/fixture/peek-prompt')throw new Error(path);window.__peeks++;return {source:'fresh',exact:false,messages:[{role:'system',content:'Original system prompt'}],parameters:{}};}
        };`,
        }));
        api.onResolve({ filter: /^react-i18next$|(?:^|\/)i18n(?:\.ts)?$/ }, () => ({
          path: "i18n",
          namespace: "fixture",
        }));
        api.onLoad({ filter: /^i18n$/, namespace: "fixture" }, () => ({
          contents: `
        const labels=${JSON.stringify(labels)};
        export const findEnglishMessageKey=(text)=>Object.keys(labels).find(key=>labels[key]===text);
        export const translate=(key)=>labels[key]??key;
        export const i18n={language:'en',t:translate};
        export const useTranslation=()=>({t:translate,i18n});`,
        }));
      },
    },
  ],
});
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixtureUrl = "http://127.0.0.1:5178/component-fixture";
  await page.route("**/*", (route) =>
    route.request().url() === fixtureUrl
      ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
      : route.abort(),
  );
  await page.goto(fixtureUrl);
  await page.evaluate(() => {
    window.__settings = {};
    window.__saves = [];
    window.__efforts = [];
    window.__resets = 0;
    window.__peeks = 0;
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.waitForFunction(() => typeof window.__setFeatures === "function");
  const editor = page.getByRole("dialog", { name: "Full Game prompt editor" });
  const effort = page.locator('[data-gm-reasoning-effort-select="true"]');
  assert.equal(await editor.count(), 0, "missing editor flag hides the editor");
  assert.equal(await effort.count(), 0, "missing GM flag hides the control");
  assert.equal(await page.evaluate(() => window.__peeks), 0, "OFF does not query prompt data");
  await page.evaluate(() => window.__setFeatures({ gamePromptEditing: true }));
  const draft = editor.locator("textarea").first();
  await draft.waitFor().catch(async (error) => {
    console.error(
      await page.locator("body").innerText(),
      errors,
      await page.evaluate(() => ({ settings: window.__settings, peeks: window.__peeks })),
    );
    throw error;
  });
  await draft.fill("Unsaved prompt draft");
  assert.equal(await effort.count(), 0, "editor enable does not enable GM override");
  const save = editor.getByRole("button", { name: "Save prompt edits", exact: true });
  await save.evaluate((element) => {
    const key = Object.keys(element).find((name) => name.startsWith("__reactProps$"));
    window.__queuedSave = element[key].onClick;
  });
  await page.evaluate(() => window.__setFeatures({ gamePromptEditing: false }));
  await editor.waitFor({ state: "detached" });
  await page.evaluate(() => window.__queuedSave());
  assert.equal(await page.evaluate(() => window.__saves.length), 0, "stale ON save cannot dispatch while OFF");
  await page.evaluate(() => window.__setFeatures({ gamePromptEditing: true }));
  await draft.waitFor();
  assert.equal(await draft.inputValue(), "Unsaved prompt draft", "disable/re-enable retains the unsaved draft");
  assert.equal(await page.evaluate(() => window.__peeks), 1, "re-enable does not overwrite draft with a new query");
  await save.click();
  await page.waitForFunction(() => window.__saves.length === 1);
  assert.equal(
    await page.evaluate(() =>
      window.__saves[0].reduce((text, edit) => text.replace(edit.find, edit.replace), "Original system prompt"),
    ),
    "Unsaved prompt draft",
    "saved minimal edits reconstruct the exact authored draft",
  );
  await page.evaluate(() => window.__setFeatures({ gmNarrationReasoning: true }));
  await editor.waitFor({ state: "detached" });
  await effort.waitFor();
  assert.equal(await effort.inputValue(), "high");
  await effort.selectOption("low");
  await effort.evaluate((element) => {
    const key = Object.keys(element).find((name) => name.startsWith("__reactProps$"));
    window.__queuedEffort = element[key].onChange;
  });
  await page.evaluate(() => window.__setFeatures({ gmNarrationReasoning: false }));
  await effort.waitFor({ state: "detached" });
  await page.evaluate(() => window.__queuedEffort({ target: { value: "high" } }));
  assert.deepEqual(await page.evaluate(() => window.__efforts), ["low"], "stale selection cannot write while OFF");
  await page.evaluate(() => window.__setFeatures({ gamePromptEditing: true, gmNarrationReasoning: true }));
  await effort.waitFor();
  assert.equal(await effort.inputValue(), "low", "GM choice survives disable/re-enable");
  await draft.waitFor();
  await page.evaluate(() => window.__featureError());
  await editor.waitFor({ state: "detached" });
  await effort.waitFor({ state: "detached" });
  await page.evaluate(() => {
    window.__queuedSave();
    window.__queuedEffort({ target: { value: "high" } });
  });
  assert.equal(
    await page.evaluate(() => window.__saves.length),
    1,
    "cached ON cannot authorize writes after query failure",
  );
  assert.deepEqual(await page.evaluate(() => window.__efforts), ["low"]);
  assert.deepEqual(errors, []);
  console.info(
    "Actual Game prompt/GM components: independent OFF/ON/OFF gates, retained draft/choice, stale actions and query-error fail-closed passed.",
  );
} finally {
  await browser.close();
}
