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
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
      import {PeekPromptModal} from '${client}/src/components/chat/PeekPromptModal.tsx';
      import {useFeatureEnabled,useSaveFeatureSettings} from '${client}/src/hooks/use-feature-settings.ts';
      const qc=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
      window.__featureError=()=>qc.getQueryCache().find({queryKey:['features']}).setState({status:'error',error:new Error('fixture')});
      function App(){
        const enabled=useFeatureEnabled('promptInspector');
        const save=useSaveFeatureSettings();
        return <><button id="toggle" onClick={()=>save.mutate({promptInspector:!enabled})}>Toggle feature</button>
          <PeekPromptModal data={{source:'cached',exact:true,parameters:{},messages:[
            {role:'system',content:'<system_prompt>\\nSystem content\\n</system_prompt>'},
            {role:'system',content:'<character_info>\\nCharacter content\\n</character_info>'}
          ]}} onClose={()=>{}}/></>;
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
      name: "isolated-inspector-settings",
      setup(api) {
        api.onResolve({ filter: /lib\/api-client$/ }, () => ({ path: "api", namespace: "fixture" }));
        api.onLoad({ filter: /^api$/, namespace: "fixture" }, () => ({
          contents: `
      export class ApiError extends Error {}
      export const api={
        get:async(path)=>{if(path!=='/app-settings/features')throw new Error(path);return {settings:window.__settings,envOverrides:{}};},
        put:async(path,settings)=>{if(path!=='/app-settings/features')throw new Error(path);window.__settings=settings;return {settings,envOverrides:{}};}
      };`,
        }));
        api.onResolve({ filter: /^react-i18next$|(?:^|\/)i18n(?:\.ts)?$/ }, () => ({
          path: "i18n",
          namespace: "fixture",
        }));
        api.onLoad({ filter: /^i18n$/, namespace: "fixture" }, () => ({
          contents: `const labels=${JSON.stringify(labels)};export const findEnglishMessageKey=(text)=>Object.keys(labels).find(key=>labels[key]===text);export const translate=(key)=>labels[key]??key;export const i18n={language:'en',t:translate};export const useTranslation=()=>({t:translate,i18n});`,
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
  await page.route("**/*", (route) => route.abort());
  await page.setContent('<div id="root"></div>');
  await page.evaluate(() => {
    window.__settings = {};
    window.__copies = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.__copies.push(text);
        },
      },
    });
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const search = page.getByRole("searchbox", { name: "Search prompt text" });
  const system = page.getByRole("button", { name: /^System Prompt/ });
  const copy = page.getByRole("button", { name: "Copy text messages", exact: true });
  await system.waitFor().catch(async (error) => {
    console.error(await page.locator("body").innerText(), errors);
    throw error;
  });
  assert.equal(await search.count(), 0, "missing setting keeps advanced controls OFF");
  await page.locator("#toggle").click();
  await search.waitFor();
  await search.fill("Character content");
  await system.waitFor({ state: "detached" });
  await copy.click();
  assert.equal(await page.evaluate(() => window.__copies.length), 1, "ON copy dispatches");
  await copy.evaluate((button) => {
    const props = Object.keys(button).find((key) => key.startsWith("__reactProps$"));
    window.__queuedCopy = button[props].onClick;
  });
  await page.locator("#toggle").click();
  await search.waitFor({ state: "detached" });
  await system.waitFor();
  await page.evaluate(() => window.__queuedCopy());
  assert.equal(await page.evaluate(() => window.__copies.length), 1, "queued earlier ON handler cannot copy after OFF");
  await page.locator("#toggle").click();
  await search.waitFor();
  await page.evaluate(() => window.__featureError());
  await search.waitFor({ state: "detached" });
  await page.evaluate(() => window.__queuedCopy());
  assert.equal(
    await page.evaluate(() => window.__copies.length),
    1,
    "cached ON data cannot authorize copy after query failure",
  );
  assert.deepEqual(errors, []);
  console.info("Actual Prompt Modal OFF/ON/OFF, baseline preview, stale copy and query-error regression passed.");
} finally {
  await browser.close();
}
