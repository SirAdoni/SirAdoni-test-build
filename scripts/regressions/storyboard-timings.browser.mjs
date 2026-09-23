import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { resolve } from "node:path";

const source = resolve("packages/client/src/components/game/GameStoryboardTimings.tsx").replaceAll("\\", "/");
const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {GameStoryboardTimings} from '${source}'; const root=createRoot(document.getElementById('root')); window.draw=()=>root.render(<GameStoryboardTimings chatId='fixture' generating={window.progress.active}/>); window.draw();`,
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
      name: "fixture",
      setup(b) {
        b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: "translation", namespace: "fixture" }));
        b.onResolve({ filter: /use-game-storyboards$/ }, () => ({ path: "progress", namespace: "fixture" }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
          contents:
            path === "progress"
              ? "export const useStoryboardProgress=()=>({data:window.progress});"
              : "export const useTranslation=()=>({t:(key,vars)=>key+(vars?.seconds?' '+vars.seconds:'')});",
        }));
      },
    },
  ],
});
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.setContent('<div id="root"></div>');
    await page.evaluate(() => {
      window.progress = {
        active: true,
        startedAt: 1000,
        elapsedMs: 12345,
        steps: [{ stage: "Media frame 2 / Image request", offsetMs: 2345, elapsedMs: 10000 }],
      };
    });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.locator("summary").click();
    assert.match(await page.locator("details").innerText(), /12\.345 s/);
    assert.match(await page.locator("details").innerText(), /2\.345 s/);
    assert.match(await page.locator("details").innerText(), /10\.000 s/);
    await page.evaluate(() => {
      window.progress = {
        ...window.progress,
        active: false,
        elapsedMs: 14000,
        steps: [{ ...window.progress.steps[0], elapsedMs: 11655, durationMs: 11655 }],
      };
      window.draw();
    });
    await page.getByText("14.000 s", { exact: true }).waitFor();
    assert.match(await page.locator("details").innerText(), /11\.655 s/);
    assert.equal(await page.locator("a").first().getAttribute("href"), "/api/game/storyboard/progress/fixture");
    assert.equal(await page.locator("a").last().getAttribute("href"), "/api/game/storyboard/progress/fixture/history");
    await page.close();
  }
  console.info("Timing panel displays precise start offsets, running and completed durations on desktop and mobile.");
} finally {
  await browser.close();
}
