// Phone Game layout: the storyboard must never cover the composer, its debug output stays folded
// away by default, and the composer stays on top when the column shrinks (on-screen keyboard).
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { buildClientCss } from "../ui-fixtures/lib/build-client-css.mjs";

const narrationSource = await fs.readFile(resolve("packages/client/src/components/game/GameNarration.tsx"), "utf8");
const panelClass = narrationSource.match(/data-component="GameNarration\.ActivePanel"\s+className="([^"]+)"/)?.[1];
const dockClass = narrationSource.match(/data-game-composer-dock\s+className="([^"]+)"/)?.[1];
assert.ok(panelClass, "GameNarration active panel classes found");
assert.ok(dockClass?.includes("max-lg:sticky"), "the phone composer dock is pinned inside the narration panel");

// The Game-owned image retry banner: extract its wrapper and row classes so the fixture tracks the source.
const surfaceSource = await fs.readFile(resolve("packages/client/src/components/game/GameSurface.tsx"), "utf8");
const retrySource = surfaceSource.slice(surfaceSource.indexOf("data-game-asset-retry-line"));
const retryWrapClass = retrySource.match(/className="([^"]+)"/)?.[1];
const retryRowClass = retrySource.match(/className="([^"]+)"/g)?.[1]?.slice(11, -1);
assert.ok(retryWrapClass?.includes("max-lg:static"), "the image retry banner flows inline on phones");
assert.ok(retryRowClass, "image retry row classes found");

const english = JSON.parse(await fs.readFile(resolve("packages/client/src/localization/locales/en.json"), "utf8"));
const tempDirectory = await fs.mkdtemp(resolve(os.tmpdir(), "marinara-storyboard-phone-"));
const cssPath = resolve(tempDirectory, "client.css");
await buildClientCss(cssPath);
const css = await fs.readFile(cssPath, "utf8");
const source = resolve("packages/client/src/components/game/GameStoryboardViewer.tsx").replaceAll("\\", "/");

const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GameStoryboardInlineViewer } from '${source}';
const noop = () => {};
const PANEL = ${JSON.stringify(panelClass)};
const DOCK = ${JSON.stringify(dockClass)};
const RETRY_WRAP = ${JSON.stringify(retryWrapClass)};
const RETRY_ROW = ${JSON.stringify(retryRowClass)};
const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="teal"/></svg>');
const failedFrame = { id: 'frame-a', index: 0, title: 'Placeholder Scene', status: 'failed', error: 'Provider refused the request (fixture detail).', image: null, video: null };
const scenarios = {
  failed: {
    storyboard: { id: 'story-a', chatId: 'fixture-chat', status: 'complete', error: 'Planner fallback used (fixture detail).', keyframes: [failedFrame] },
    frame: failedFrame,
    generationError: 'Image generation failed (fixture detail).',
    generating: false,
  },
  image: {
    storyboard: { id: 'story-b', chatId: 'fixture-chat', status: 'rendering', error: null, keyframes: [
      { id: 'frame-b', index: 0, title: 'Placeholder Harbour', status: 'image_complete', error: null, anchorQuote: 'A neutral placeholder beat.', image: { id: 'img', url: image, prompt: 'fixture', provider: 'fixture', model: 'fixture', createdAt: '2026-01-01T00:00:00.000Z' }, video: null },
      { id: 'frame-c', index: 1, title: 'Placeholder Road', status: 'planned', error: null, image: null, video: null },
    ] },
    generationError: null,
    generating: true,
  },
};
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function App({ scenario }) {
  const data = scenarios[scenario];
  return (
    <QueryClientProvider client={client}>
      <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: '#123' }}>
        <div style={{ height: 51, flexShrink: 0 }} />
        {/* A HUD layer in its own stacking context above the column, like Currently Present. Landscape
            phones fold that strip into the Game top row, where the storyboard tab then sits as an icon. */}
        {window.matchMedia("(max-width: 1023px) and (max-height: 32rem)").matches ? null : (
          <div data-fixture-hud style={{ position: 'absolute', top: 51, left: 0, right: 0, height: 60, zIndex: 20, background: 'rgba(80,0,80,0.4)' }} />
        )}
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden" style={{ zIndex: 10 }} data-fixture-column>
          <div className="pointer-events-none relative flex min-h-0 flex-1 flex-col justify-end px-3 pb-3 pt-3">
            <div className="pointer-events-none relative z-10 mx-auto flex min-h-0 flex-1 w-full max-w-4xl flex-col justify-end max-lg:overflow-hidden">
              <div className={PANEL}>
                {Array.from({ length: 6 }, (_, index) => (
                  <p key={index} className="mb-2 text-base text-white">Placeholder narration paragraph {index + 1}. The traveller walks on and the road keeps going.</p>
                ))}
                <div className={DOCK}>
                  <div className="mari-chat-input-box relative flex items-center rounded-2xl border border-white/20 bg-black">
                    <textarea aria-label="Composer" rows={1} className="min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-white" />
                    <button type="button" aria-label="Send" className="h-9 w-9 text-white">&gt;</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <GameStoryboardInlineViewer
            chatId="fixture-chat"
            storyboard={data.storyboard}
            frame={data.frame ?? data.storyboard.keyframes[0]}
            frameSectionLabel="Section 1"
            generating={data.generating}
            generationError={data.generationError}
            onRetry={() => (window.retried = true)}
            position={{ x: 0, y: 0 }}
            width={320}
            size="small"
            playing={false}
            muted
            videoRef={{ current: null }}
            dragHandlers={{}}
            resizeHandlers={{}}
            onSelectFrame={noop}
            onOpenImage={noop}
            onClose={() => (window.dismissed = true)}
            onReplay={noop}
            onTogglePlayback={noop}
            onToggleMute={noop}
            onChangeSize={noop}
            onResizeByKeyboard={noop}
            onVideoPlayingChange={noop}
          />
          <div data-fixture-retry-line className={RETRY_WRAP}>
            <div className={RETRY_ROW}>
              <span className="text-xs text-white/70 max-lg:min-w-0 max-lg:flex-1 max-lg:truncate">Image generation failed</span>
              <button type="button" className="rounded-lg bg-white/10 px-3 py-1.5 text-xs text-white/80 max-lg:py-1">Retry</button>
            </div>
          </div>
        </div>
      </div>
    </QueryClientProvider>
  );
}
const root = createRoot(document.getElementById('root'));
window.renderScenario = (scenario) => root.render(<App key={scenario} scenario={scenario} />);
`;

const bundle = await build({
  stdin: { contents: fixture, loader: "tsx", resolveDir: process.cwd() },
  nodePaths: [resolve("packages/client/node_modules")],
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  define: { "import.meta.env": "{}" },
  plugins: [
    {
      name: "fixture-modules",
      setup(plugin) {
        plugin.onResolve({ filter: /ChatToolbarControls$/ }, () => ({ path: "toolbar", namespace: "fixture" }));
        plugin.onResolve({ filter: /^react-i18next$/ }, () => ({ path: "translation", namespace: "fixture" }));
        plugin.onResolve({ filter: /lib\/api-client$/ }, () => ({ path: "api", namespace: "fixture" }));
        plugin.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          contents:
            args.path === "toolbar"
              ? "export const getChatToolbarButtonClass=({sizeClassName,className})=>['flex items-center justify-center rounded-lg border border-white/20 bg-black/70 text-white',sizeClassName,className].join(' ');"
              : args.path === "api"
                ? "export class ApiError extends Error{};export const api={get:()=>Promise.reject(new ApiError('offline fixture')),post:()=>Promise.reject(new ApiError('offline fixture'))};"
                : `const MAP=${JSON.stringify(english)};export const initReactI18next={type:'3rdParty',init(){}};export const useTranslation=()=>({t:(key,values)=>{let value=MAP[key]??key;for(const[name,replacement]of Object.entries(values??{}))value=value.replaceAll(\`{{\${name}}}\`,String(replacement));return value;}});`,
          loader: "js",
        }));
      },
    },
  ],
});

const DEBUG_TEXT = [
  english["game.storyboard.timing.title"],
  english["ui.game.gamesurfacecomponent.storyboardDegradedResult"],
  english["ui.game.gamesurfacecomponent.storyboardGenerationFailed"],
  english["game.storyboard.errorDetails"],
  english["game.storyboard.status.failed"],
  "0 ready / 1 planned",
  "fixture detail",
];

async function composerState(page) {
  return page.evaluate(() => {
    const textarea = document.querySelector(".mari-chat-input-box textarea");
    const box = textarea.closest(".mari-chat-input-box");
    const send = box.querySelector("button");
    const centre = (element) => {
      const rect = element.getBoundingClientRect();
      return [rect.left + rect.width / 2, rect.top + rect.height / 2];
    };
    const boxRect = box.getBoundingClientRect();
    const sheet = document.querySelector("[data-storyboard-phone-sheet]");
    const sheetRect = sheet?.getBoundingClientRect();
    const retryRect = document.querySelector("[data-fixture-retry-line]").getBoundingClientRect();
    const panelRect = box
      .closest('[data-component="GameNarration.ActivePanel"], .overflow-y-auto')
      ?.getBoundingClientRect();
    const overlaps = (a, b) =>
      !!a && !!b && a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right;
    return {
      textareaOnTop: document.elementFromPoint(...centre(textarea)) === textarea,
      sendOnTop: document.elementFromPoint(...centre(send)) === send,
      inViewport: boxRect.top >= 0 && boxRect.bottom <= window.innerHeight,
      sheetOpen: !!sheet,
      sheetOverlapsComposer: !!sheetRect && sheetRect.bottom > boxRect.top && sheetRect.top < boxRect.bottom,
      sheetHeight: sheetRect ? Math.round(sheetRect.height) : 0,
      retryOverComposer: overlaps(retryRect, boxRect),
      retryOverNarration: overlaps(retryRect, panelRect),
    };
  });
}

async function visibleDebugText(page) {
  return page.evaluate((needles) => {
    const found = [];
    for (const element of document.querySelectorAll("body *")) {
      if (element.children.length > 0 || !element.checkVisibility()) continue;
      if (element.closest("[data-fixture-retry-line]")) continue;
      const text = element.textContent ?? "";
      for (const needle of needles) if (text.includes(needle)) found.push(needle);
    }
    return found;
  }, DEBUG_TEXT);
}

const browser = await chromium.launch({ headless: true });
try {
  for (const [width, height] of [
    [360, 740],
    [390, 844],
    [412, 915],
    [844, 390],
  ]) {
    const label = `${width}x${height}`;
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: true });
    await page.setContent(`<style>${css}</style><div id="root"></div>`);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    for (const scenario of ["failed", "image"]) {
      await page.setViewportSize({ width, height });
      await page.evaluate((name) => window.renderScenario(name), scenario);
      const tab = page.locator("[data-storyboard-phone-tab]");
      await tab.waitFor();
      await page.waitForTimeout(100);

      // Rule 1: on phones the storyboard is a collapsed tab; opening it never covers the composer.
      let state = await composerState(page);
      assert.equal(state.sheetOpen, false, `${label} ${scenario}: storyboard starts collapsed`);
      assert.equal(state.textareaOnTop, true, `${label} ${scenario}: composer textarea on top while collapsed`);
      assert.equal(state.sendOnTop, true, `${label} ${scenario}: send button on top while collapsed`);
      assert.equal(state.inViewport, true, `${label} ${scenario}: composer inside the viewport`);
      assert.equal(state.retryOverComposer, false, `${label} ${scenario}: image retry line clears the composer`);
      assert.equal(state.retryOverNarration, false, `${label} ${scenario}: image retry line clears the narration`);
      await tab.click();
      await page.locator("[data-storyboard-phone-sheet]").waitFor();
      await page.waitForTimeout(150);
      state = await composerState(page);
      assert.equal(state.sheetOverlapsComposer, false, `${label} ${scenario}: open sheet clears the composer`);
      assert.ok(state.sheetHeight > 40, `${label} ${scenario}: open sheet has usable height (${state.sheetHeight})`);
      assert.equal(state.textareaOnTop, true, `${label} ${scenario}: composer textarea on top with the sheet open`);
      assert.equal(state.sendOnTop, true, `${label} ${scenario}: send button on top with the sheet open`);

      const closeOnTop = await page.evaluate(() => {
        const close = document.querySelector("[data-storyboard-phone-sheet] button");
        const rect = close.getBoundingClientRect();
        return close.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
      });
      assert.equal(closeOnTop, true, `${label} ${scenario}: the sheet and its close button sit above the HUD layer`);

      // Rule 2: debug and status internals are folded away; a failure shows one friendly line.
      assert.deepEqual(await visibleDebugText(page), [], `${label} ${scenario}: no debug text visible by default`);
      if (scenario === "failed") {
        assert.equal(
          await page.getByText(english["game.storyboard.friendlyFailure"]).first().isVisible(),
          true,
          `${label}: friendly failure line`,
        );
      }
      const details = page.locator("[data-storyboard-phone-sheet] [data-storyboard-debug] > summary");
      await details.click();
      if (scenario === "failed") {
        assert.equal(
          await page.getByText("Provider refused the request (fixture detail).").isVisible(),
          true,
          `${label}: details disclosure reveals the frame error`,
        );
      }
      await details.click();

      // Rule 3: typing with a keyboard-shortened column keeps the composer on top and usable.
      await page.locator(".mari-chat-input-box textarea").focus();
      await page.setViewportSize({ width, height: Math.round(height * 0.55) });
      await page.waitForTimeout(250);
      state = await composerState(page);
      assert.equal(state.inViewport, true, `${label} ${scenario}: composer inside the shortened viewport`);
      assert.equal(
        state.sheetOverlapsComposer,
        false,
        `${label} ${scenario}: sheet clears the composer with the keyboard up`,
      );
      assert.equal(state.textareaOnTop, true, `${label} ${scenario}: textarea on top with the keyboard up`);
      assert.equal(state.sendOnTop, true, `${label} ${scenario}: send on top with the keyboard up`);
      await page.keyboard.type("hello");
      assert.equal(await page.locator(".mari-chat-input-box textarea").inputValue(), "hello");
      await page.locator(".mari-chat-input-box textarea").fill("");

      // The sheet has an obvious close that returns to the collapsed tab.
      await page.getByRole("button", { name: english["game.storyboard.hideViewer"] }).click();
      await page.locator("[data-storyboard-phone-sheet]").waitFor({ state: "detached" });
      await page.locator(".mari-chat-input-box textarea").focus();
      state = await composerState(page);
      assert.equal(state.textareaOnTop, true, `${label} ${scenario}: textarea on top while typing, collapsed`);
      assert.equal(state.inViewport, true, `${label} ${scenario}: composer visible while typing, collapsed`);
      await page.locator(".mari-chat-input-box textarea").blur();
    }
    await page.close();
  }

  // Desktop keeps the full viewer, but its internals are folded behind the same disclosure.
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.setContent(`<style>${css}</style><div id="root"></div>`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => window.renderScenario("failed"));
  await page.locator("[data-storyboard-debug]").waitFor();
  assert.equal(await page.locator("[data-storyboard-phone]").count(), 0, "desktop does not use the phone tab");
  assert.equal(
    await page.locator("[data-fixture-retry-line]").evaluate((element) => getComputedStyle(element).position),
    "absolute",
    "desktop keeps the floating image retry banner",
  );
  assert.deepEqual(await visibleDebugText(page), [], "desktop: no debug text visible by default");
  await page.getByRole("button", { name: english["game.storyboard.retryGeneration"] }).click();
  assert.equal(await page.evaluate(() => window.retried), true, "desktop: friendly failure keeps Retry");
  console.info(
    "Phone storyboard: collapsed tab, sheet clear of the composer at 360/390/412 and landscape, debug folded, image retry line clear of narration and composer, composer on top with the keyboard up.",
  );
} finally {
  await browser.close();
  await fs.rm(tempDirectory, { recursive: true, force: true });
}
