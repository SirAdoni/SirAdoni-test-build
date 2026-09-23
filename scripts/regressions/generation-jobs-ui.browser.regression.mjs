import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { resolve } from "node:path";

const source = resolve("packages/client/src/components/modals/GenerationJobsModal.tsx").replaceAll("\\", "/");
const bundle = await build({
  stdin: {
    contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{GenerationJobsModal}from'${source}';function App(){const[open,setOpen]=useState(true);return <><button onClick={()=>setOpen(true)}>Reopen</button><GenerationJobsModal open={open} onClose={()=>setOpen(false)}/></>}createRoot(document.getElementById('root')).render(<App/>);`,
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
      name: "generation-jobs-fixtures",
      setup(buildApi) {
        buildApi.onResolve({ filter: /use-generation-jobs$/ }, () => ({ path: "jobs", namespace: "fixture" }));
        buildApi.onLoad({ filter: /^jobs$/, namespace: "fixture" }, () => ({
          contents: `import{useState}from'react';export function useGenerationJobs(open){const[,refresh]=useState(0);return{isLoading:false,isError:false,data:open?(window.__generationJobs||[]):[]};}export function useGenerationJobResult(id,enabled){return{isLoading:false,isError:false,data:enabled&&id==='done'?{avatar:'data:image/png;base64,fixture'}:undefined};}export function useCancelGenerationJob(){return{isPending:false,mutate(id){window.__cancelled=id;window.__generationJobs=(window.__generationJobs||[]).map(job=>job.id===id?{...job,status:'cancelled'}:job);}}}`,
          resolveDir: process.cwd(),
        }));
        // Opt-in job tracking stays off here: the modal must look exactly as it did without it.
        buildApi.onResolve({ filter: /use-generation-job-tracking$/ }, () => ({
          path: "tracking",
          namespace: "fixture",
        }));
        buildApi.onLoad({ filter: /^tracking$/, namespace: "fixture" }, () => ({
          contents: `export function useGenerationJobTrackingEnabled(){return false}export function useTrackedGenerationJobs(){return{data:undefined}}`,
          resolveDir: process.cwd(),
        }));
        buildApi.onResolve({ filter: /TrackedJobDetails$/ }, () => ({ path: "tracked-details", namespace: "fixture" }));
        buildApi.onLoad({ filter: /^tracked-details$/, namespace: "fixture" }, () => ({
          contents: "export function TrackedJobDetails(){throw new Error('tracking is off')}",
          resolveDir: process.cwd(),
        }));
        buildApi.onResolve({ filter: /\.\.\/ui\/Modal$/ }, () => ({ path: "modal", namespace: "fixture" }));
        buildApi.onLoad({ filter: /^modal$/, namespace: "fixture" }, () => ({
          contents:
            "export function Modal({open,children,title}){return open?<section role='dialog' aria-label={title}>{children}</section>:null}",
          resolveDir: process.cwd(),
          loader: "jsx",
        }));
        buildApi.onResolve({ filter: /^react-i18next$/ }, () => ({ path: "translation", namespace: "fixture" }));
        buildApi.onLoad({ filter: /^translation$/, namespace: "fixture" }, () => ({
          contents: "export const useTranslation=()=>({t:key=>key})",
          resolveDir: process.cwd(),
        }));
        buildApi.onResolve({ filter: /\.\.\/\.\.\/lib\/utils$/ }, () => ({ path: "utils", namespace: "fixture" }));
        buildApi.onLoad({ filter: /^utils$/, namespace: "fixture" }, () => ({
          contents: "export const cn=(...v)=>v.filter(Boolean).join(' ')",
          resolveDir: process.cwd(),
        }));
      },
    },
  ],
});

const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport });
    await page.setContent('<div id="root"></div>');
    await page.evaluate(() => {
      window.__generationJobs = [
        {
          id: "running",
          kind: "image",
          label: "Portrait",
          chatId: null,
          status: "running",
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
          error: null,
          resultAvailable: false,
        },
        {
          id: "done",
          kind: "avatar",
          label: "Completed avatar",
          chatId: null,
          status: "completed",
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
          error: null,
          resultAvailable: true,
        },
      ];
    });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByText("Completed avatar").click();
    await page.locator("img").waitFor();
    await page.getByLabel("generationJobs.stopGeneration").click();
    assert.equal(await page.evaluate(() => window.__cancelled), "running");
    await page.getByText("Reopen").click();
    await page.getByText("Completed avatar").waitFor();
    await page.close();
  }
  console.info(
    "Generation jobs modal supports completed previews, cancellation, and reopening on desktop and mobile fixtures.",
  );
} finally {
  await browser.close();
}
