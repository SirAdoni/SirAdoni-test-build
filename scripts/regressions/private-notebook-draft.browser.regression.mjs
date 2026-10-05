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
      import {PrivateNotebookPanel} from '${client}/src/components/chat/PrivateNotebookPanel.tsx';
      import {useFeatureEnabled,useSaveFeatureSettings} from '${client}/src/hooks/use-feature-settings.ts';
      const qc=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
      function App(){
        const enabled=useFeatureEnabled('privateNotebook');
        const save=useSaveFeatureSettings();
        const [open,setOpen]=React.useState(true);
        const panel=React.useRef(null);
        return <><button id="toggle" onClick={()=>save.mutate({privateNotebook:!enabled})}>Toggle feature</button>
          <button id="reopen" onClick={()=>setOpen(true)}>Reopen</button>
          <button id="request-close" onClick={async()=>{window.__closeResult=await panel.current.requestClose();}}>Request close</button>
          {enabled&&open&&<PrivateNotebookPanel ref={panel} open chatId="chat-one" mode="game" anchor={null} opener={null} characterNames={{}} onClose={()=>setOpen(false)}/>}</>;
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
      name: "notebook-draft-backend",
      setup(api) {
        api.onResolve({ filter: /lib\/api-client$/ }, () => ({ path: "api", namespace: "fixture" }));
        api.onLoad({ filter: /^api$/, namespace: "fixture" }, () => ({
          contents: `
        export class ApiError extends Error {}
        export const api={
          get:async(path)=>{
            if(path==='/app-settings/features')return {settings:{privateNotebook:window.__enabled},envOverrides:{}};
            if(path==='/private-notebook/chats/chat-one')return {chatId:'chat-one',mode:'game',groupId:null,characterIds:[],documents:[{...window.__document}]};
            throw new Error('Unexpected read '+path);
          },
          put:async(path,input)=>{
            if(path==='/app-settings/features'){window.__enabled=input.privateNotebook;return {settings:input,envOverrides:{}};}
            if(path==='/private-notebook/chats/chat-one'){
              window.__writes.push(input);
              if(window.__failSave)throw new Error('Synthetic save failure');
              if(!window.__enabled)throw new Error('OFF write');
              if(input.expectedRevision!==window.__document.revision)throw new Error('Stale write');
              window.__document={...window.__document,content:input.content,revision:input.expectedRevision+1};
              return {...window.__document};
            }
            throw new Error('Unexpected write '+path);
          }
        };`,
          resolveDir: process.cwd(),
        }));
        api.onResolve({ filter: /^react-i18next$/ }, () => ({ path: "i18n", namespace: "fixture" }));
        api.onResolve({ filter: /(?:^|\/)i18n(?:\.ts)?$/ }, () => ({ path: "i18n", namespace: "fixture" }));
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
    window.__enabled = true;
    window.__writes = [];
    window.__document = { target: { scope: "chat" }, content: "Saved note", revision: 1, updatedAt: null };
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const notes = page.getByRole("textbox", { name: "Notes", exact: true });
  await notes.waitFor();
  assert.equal(await notes.inputValue(), "Saved note");
  await notes.fill("Unsaved survives OFF");
  // Invoke the actual feature mutation while the actual Panel has a pending debounce.
  await page.locator("#toggle").dispatchEvent("click");
  await notes.waitFor({ state: "detached" });
  await page.waitForTimeout(950);
  assert.deepEqual(await page.evaluate(() => window.__writes), [], "OFF must cancel queued autosave");
  await page.locator("#toggle").click();
  await notes.waitFor();
  assert.equal(await notes.inputValue(), "Unsaved survives OFF");
  await page.waitForFunction(() => window.__document.content === "Unsaved survives OFF");
  assert.equal(await page.evaluate(() => window.__writes.length), 1);

  await notes.fill("Conflicting draft survives OFF");
  await page.locator("#toggle").dispatchEvent("click");
  await notes.waitFor({ state: "detached" });
  await page.evaluate(() => {
    window.__document = { ...window.__document, content: "Changed elsewhere", revision: 3 };
  });
  await page.locator("#toggle").click();
  await notes.waitFor();
  await page.getByText("Saved notes changed elsewhere", { exact: true }).waitFor();
  assert.equal(await notes.inputValue(), "Conflicting draft survives OFF");
  await page.locator("#toggle").dispatchEvent("click");
  await notes.waitFor({ state: "detached" });
  await page.locator("#toggle").click();
  await notes.waitFor();
  await page.getByText("Saved notes changed elsewhere", { exact: true }).waitFor();
  await page.waitForTimeout(950);
  assert.equal(
    await page.evaluate(() => window.__writes.length),
    1,
    "repeated reconciliation cannot autosave a conflict",
  );
  assert.equal(await notes.inputValue(), "Conflicting draft survives OFF");
  await page.locator("#request-close").dispatchEvent("click");
  await page.waitForFunction(() => window.__closeResult === false);
  assert.equal(await notes.inputValue(), "Conflicting draft survives OFF", "conflict blocks close");
  await page.getByRole("button", { name: "Reload saved", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("textarea")?.value === "Changed elsewhere");
  await page.evaluate(() => {
    window.__failSave = true;
    window.__closeResult = undefined;
  });
  await notes.fill("Draft retained after failed save and close");
  const scope = page.getByRole("combobox").first();
  const writesBeforeSwitch = await page.evaluate(() => window.__writes.length);
  await scope.selectOption("global");
  await page.waitForFunction((count) => window.__writes.length > count, writesBeforeSwitch);
  assert.equal(await scope.inputValue(), "chat", "scope switching stays strict on save failure");
  await page.locator("#request-close").dispatchEvent("click");
  await page.waitForFunction(() => window.__closeResult !== undefined);
  assert.equal(await page.evaluate(() => window.__closeResult), true, "ordinary save error must allow close");
  await notes.waitFor({ state: "detached" });
  await page.locator("#reopen").click();
  await notes.waitFor();
  assert.equal(await notes.inputValue(), "Draft retained after failed save and close");
  assert.equal(
    await page.evaluate(() => window.__document.content),
    "Changed elsewhere",
    "failed save did not persist",
  );
  assert.deepEqual(errors, []);
  console.info("Actual Notebook Panel OFF/remount draft and repeated-conflict regression passed.");
} finally {
  await browser.close();
}
