import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { resolve } from "node:path";
const source = resolve("packages/client/src/components/agents/StoryboardAgentSettingsPanel.tsx").replaceAll("\\", "/");
const shared = resolve("packages/shared/src/features/agents/storyboard-agent-settings.ts").replaceAll("\\", "/");
const bundle = await build({
  stdin: {
    contents: `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{StoryboardAgentSettingsPanel}from'${source}';import{normalizeStoryboardAgentSettings}from'${shared}';const defaults=normalizeStoryboardAgentSettings({});const noop=()=>{};function App(){const[settings,setSettings]=useState(defaults);return <StoryboardAgentSettingsPanel settings={settings} defaults={defaults} plannerPrompt='' defaultPlannerPrompt='' plannerTemplates={[]} connections={[]} onChange={s=>{window.saved=s;setSettings(s)}} onPlannerPromptChange={noop} onPlannerTemplatesChange={noop} onDirty={()=>window.dirty=true}/>};createRoot(document.getElementById('root')).render(<App/>);`,
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
        b.onResolve({ filter: /StoryboardContinuitySettings$|MacroTextarea$|^react-i18next$/ }, ({ path }) => ({
          path,
          namespace: "fixture",
        }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
          loader: "tsx",
          resolveDir: resolve("packages/client"),
          contents: path.endsWith("StoryboardContinuitySettings")
            ? "export const StoryboardContinuitySettings=()=>null;"
            : path.endsWith("MacroTextarea")
              ? "export const MacroTextarea=()=>null;"
              : "export const useTranslation=()=>({t:key=>key});",
        }));
      },
    },
  ],
});
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const mode = page.getByRole("combobox", { name: /game.storyboard.frameCountMode/ });
    await mode.selectOption("adaptive");
    const maximum = page.getByRole("spinbutton", { name: "game.storyboard.maxAutomaticFrames" });
    assert.equal(await maximum.inputValue(), "10");
    await maximum.fill("8");
    assert.equal(await page.evaluate(() => window.saved.maxAutomaticKeyframes), 8);
    assert.equal(await page.getByRole("spinbutton", { name: "game.storyboard.baseFrameCount" }).inputValue(), "3");
    await mode.selectOption("fixed");
    assert.equal(await maximum.count(), 0);
    assert.equal(await page.evaluate(() => window.saved.adaptiveKeyframeCount), false);
    assert.equal(await page.evaluate(() => window.dirty), true);
    await page.close();
  }
  console.info("Adaptive storyboard controls toggle, retain the baseline and save the maximum on mobile and desktop.");
} finally {
  await browser.close();
}
