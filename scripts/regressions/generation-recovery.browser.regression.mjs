import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { resolve } from "node:path";

const hook = resolve("packages/client/src/hooks/use-generation-recovery.ts").replaceAll("\\", "/");
const bundle = await build({
  stdin: {
    contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{useGenerationRecovery}from'${hook}';function App(){const[id,setId]=useState('a');const[,render]=useState(0);window.__render=()=>render(v=>v+1);useGenerationRecovery(id);return <main><output data-testid='busy'>{window.__state.busy?'busy':'idle'}</output><output data-testid='phase'>{window.__state.phase||''}</output><output data-testid='calls'>{window.__calls}</output><output data-testid='invalidations'>{window.__invalidations}</output><button onClick={()=>window.dispatchEvent(new Event('focus'))}>Probe</button><button onClick={()=>setId('b')}>Switch</button><button onClick={()=>{window.__state.abortControllers.set('a',{});window.__state.busy=true;render(v=>v+1)}}>Foreground</button><button onClick={()=>setId(null)}>Unmount</button></main>}createRoot(document.getElementById('root')).render(<App/>);`,
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
      name: "generation-recovery-fixtures",
      setup(buildApi) {
        buildApi.onResolve({ filter: /@tanstack\/react-query$/ }, () => ({ path: "rq", namespace: "fixture" }));
        buildApi.onLoad({ filter: /^rq$/, namespace: "fixture" }, () => ({
          contents:
            "const client={invalidateQueries(){window.__invalidations++}};export const useQueryClient=()=>client",
          resolveDir: process.cwd(),
        }));
        buildApi.onResolve({ filter: /lib\/api-client$/ }, () => ({ path: "api", namespace: "fixture" }));
        buildApi.onLoad({ filter: /^api$/, namespace: "fixture" }, () => ({
          contents: `export const api={get:async()=>{window.__calls++;window.__inFlight++;window.__maxInFlight=Math.max(window.__maxInFlight,window.__inFlight);await new Promise(r=>setTimeout(r,25));const next=window.__responses.shift();window.__inFlight--;if(next==='error')throw new Error('offline');return {active:next==='active'};}}`,
          resolveDir: process.cwd(),
        }));
        buildApi.onResolve({ filter: /localization\/i18n$/ }, () => ({ path: "i18n", namespace: "fixture" }));
        buildApi.onLoad({ filter: /^i18n$/, namespace: "fixture" }, () => ({
          contents: 'export const translate=()=>"Generating..."',
          resolveDir: process.cwd(),
        }));
        buildApi.onResolve({ filter: /[\\/]use-chats(?:\.ts)?$/ }, () => ({ path: "chat-keys", namespace: "fixture" }));
        buildApi.onLoad({ filter: /^chat-keys$/, namespace: "fixture" }, () => ({
          contents:
            "export const chatKeys={messages:id=>['messages',id],messageCount:id=>['count',id],detail:id=>['detail',id],list:()=>['list'],};",
          resolveDir: process.cwd(),
        }));
        buildApi.onResolve({ filter: /[\\/]chat\.store(?:\.ts)?$/ }, () => ({
          path: "chat-store",
          namespace: "fixture",
        }));
        buildApi.onLoad({ filter: /^chat-store$/, namespace: "fixture" }, () => ({
          contents: `const state=window.__state;state.activeChatId='a';state.streamingChatId=null;state.phase=null;state.abortControllers=new Map();state.setStreaming=function(v,id){this.busy=v;this.streamingChatId=v?id:null;window.__render?.()};state.setGenerationPhase=function(v){this.phase=v;window.__render?.()};export const useChatStore=Object.assign((selector)=>selector?selector(state):state,{getState:()=>state});`,
          resolveDir: process.cwd(),
        }));
      },
    },
  ],
});

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<div id="root"></div>');
  await page.evaluate(() => {
    window.__responses = ["active", "error", "inactive"];
    window.__calls = 0;
    window.__inFlight = 0;
    window.__maxInFlight = 0;
    window.__invalidations = 0;
    window.__state = { busy: false, phase: null, abortControllers: new Map() };
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.waitForTimeout(100);
  await page.getByTestId("busy").filter({ hasText: "busy" }).waitFor({ timeout: 3_000 });
  const initialCalls = await page.evaluate(() => window.__calls);
  await page.evaluate(() => {
    for (let index = 0; index < 5; index += 1) window.dispatchEvent(new Event("focus"));
  });
  await page.waitForTimeout(75);
  assert.equal(await page.evaluate(() => window.__maxInFlight), 1, "focus probes must not overlap");
  assert.equal(await page.getByTestId("busy").textContent(), "busy", "network errors must preserve busy state");
  await page.getByText("Probe").click();
  await page.getByTestId("busy").filter({ hasText: "idle" }).waitFor();
  assert.ok((await page.evaluate(() => window.__invalidations)) > 0, "completion must invalidate durable results");
  assert.equal(await page.evaluate(() => window.__calls), initialCalls + 2, "active, error, inactive probes expected");
  await page.getByText("Foreground").click();
  await page.getByText("Probe").click();
  await page.waitForTimeout(75);
  assert.equal(
    await page.getByTestId("busy").textContent(),
    "busy",
    "foreground ownership must survive recovery cleanup",
  );
  assert.equal(await page.evaluate(() => window.__maxInFlight), 1);
  await page.getByText("Unmount").click();
  assert.equal(await page.evaluate(() => window.__aborts ?? 0), 0, "observer cleanup must not abort server work");
  console.info("Generation recovery browser regression passed.");
} finally {
  await browser.close();
}
