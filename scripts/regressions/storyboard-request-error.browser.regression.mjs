import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { resolve } from "node:path";
const source = resolve("packages/client/src/components/game/GameStoryboardViewer.tsx").replaceAll("\\", "/");
const bundle = await build({
  stdin: {
    contents: `import React from 'react';import{createRoot}from'react-dom/client';import{GameStoryboardInlineViewer}from'${source}';const root=createRoot(document.getElementById('root'));const noop=()=>{};window.draw=()=>root.render(<GameStoryboardInlineViewer storyboard={null} frame={null} generationError={window.failure} generating={!window.failure} onRetry={()=>window.retried=true} width={300} videoRef={{current:null}} onClose={noop} onReplay={noop} onTogglePlayback={noop} onToggleMute={noop} onVideoPlayingChange={noop}/>);window.draw();`,
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
      name: "fixtures",
      setup(b) {
        b.onResolve(
          { filter: /FloatingGamePanel$|GameStoryboardTimings$|ChatToolbarControls$|^react-i18next$/ },
          ({ path }) => ({ path, namespace: "fixture" }),
        );
        b.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
          loader: "tsx",
          resolveDir: resolve("packages/client"),
          contents: path.endsWith("FloatingGamePanel")
            ? "export const FloatingGamePanel=({children})=><section>{children}</section>;"
            : path.endsWith("GameStoryboardTimings")
              ? "export const GameStoryboardTimings=()=>null;"
              : path.endsWith("ChatToolbarControls")
                ? "export const getChatToolbarButtonClass=()=>'';"
                : "export const initReactI18next={type:'3rdParty',init(){}}; export const useTranslation=()=>({t:key=>key});",
        }));
      },
    },
  ],
});
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.setContent('<div id="root"></div>');
    await page.evaluate(
      () => (window.failure = "Validation Error: sections: Array must contain at most 200 element(s)"),
    );
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByRole("alert").waitFor();
    assert.match(await page.getByRole("alert").innerText(), /sections: Array must contain at most 200/);
    assert.equal(await page.getByText("ui.game.gamesurfacecomponent.creatingStoryboard", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "game.storyboard.retryGeneration" }).click();
    assert.equal(await page.evaluate(() => window.retried), true);
    await page.evaluate(() => {
      window.failure = null;
      window.draw();
    });
    await page.getByText("ui.game.gamesurfacecomponent.creatingStoryboard", { exact: true }).waitFor();
    assert.equal(await page.getByRole("alert").count(), 0);
    await page.close();
  }
  console.info(
    "Pre-render failures remain visible without a saved storyboard; retry and generating states work on mobile and desktop.",
  );
} finally {
  await browser.close();
}
