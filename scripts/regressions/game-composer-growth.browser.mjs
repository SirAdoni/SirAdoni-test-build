// Game composer growth: typing or pasting a long turn, and sending it, must not move the narration panel,
// the floating panels or the narration scroll position. Real GameInput, FloatingGamePanel and the
// composer reserve hook, with the narration classes read from GameNarration.tsx; no game server.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { buildClientCss } from "../ui-fixtures/lib/build-client-css.mjs";

const TOLERANCE = 2;
const narrationSource = await fs.readFile(resolve("packages/client/src/components/game/GameNarration.tsx"), "utf8");
const classAfter = (marker) => {
  const at = narrationSource.indexOf(marker);
  assert.ok(at >= 0, `${marker} found in GameNarration.tsx`);
  return narrationSource.slice(at).match(/className="([^"]+)"/)?.[1];
};
const columnClass = narrationSource.match(/return \(\s*<div(?:\s+data-component="[^"]+")?\s+className="(pointer-events-none relative flex[^"]+)"/)?.[1];
const dialogueClass = classAfter('data-tour="game-dialogue"');
const narrationWrapClass = classAfter('<FloatingGamePanel id="narration"');
const panelClass = narrationSource.match(/data-component="GameNarration\.ActivePanel"\s+className="([^"]+)"/)?.[1];
const dockClass = narrationSource.match(/data-game-composer-dock\s+className="([^"]+)"/)?.[1];
const reserveClass = narrationSource.match(/composerDock\.reserved > 0 && "([^"]+)"/)?.[1];
for (const [name, value] of Object.entries({ columnClass, dialogueClass, narrationWrapClass, panelClass, dockClass }))
  assert.ok(value, `${name} found in GameNarration.tsx`);
assert.equal(
  narrationSource.match(/ref=\{composerDock\.dockRef\}\s+data-game-composer-dock/g)?.length,
  2,
  "both composer docks report their height to the send reserve",
);
assert.ok(
  /isStreaming && \([\s\S]{0,400}minHeight: composerDock\.reserved/.test(narrationSource),
  "the generation status holds the composer dock's height",
);
assert.ok(reserveClass, "the send reserve keeps the phone dock's bottom bleed");

const tempDirectory = await fs.mkdtemp(resolve(os.tmpdir(), "marinara-composer-growth-"));
const cssPath = resolve(tempDirectory, "client.css");
await buildClientCss(cssPath);
const css = await fs.readFile(cssPath, "utf8");
const source = (path) => resolve(`packages/client/src/components/game/${path}`).replaceAll("\\", "/");

const fixture = `
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GameInput } from '${source("GameInput.tsx")}';
import { FloatingGamePanel, GamePanelContext } from '${source("FloatingGamePanel.tsx")}';
import { useComposerDockReserve } from '${source("game-composer-stability.ts")}';
const COLUMN = ${JSON.stringify(columnClass)};
const DIALOGUE = ${JSON.stringify(dialogueClass)};
const WRAP = ${JSON.stringify(narrationWrapClass)};
const PANEL = ${JSON.stringify(panelClass)};
const DOCK = ${JSON.stringify(dockClass)};
const RESERVE = ${JSON.stringify(reserveClass)};
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
window.sent = [];
function App() {
  const surface = useRef(null);
  const [streaming, setStreaming] = useState(false);
  const dock = useComposerDockReserve();
  return (
    <QueryClientProvider client={client}>
      <div ref={surface} style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: '#123' }}>
        <GamePanelContext.Provider value={{ chatId: 'fixture-chat', surface, layoutEditing: false, layoutRevision: 0 }}>
          <FloatingGamePanel id="map" width={260}>
            <div data-fixture-hud className="p-2 text-white" style={{ height: 90 }}>Placeholder map</div>
          </FloatingGamePanel>
          <FloatingGamePanel id="widget:alpha" width={220} autoGrow>
            <div data-fixture-hud className="p-2 text-white" style={{ height: 70 }}>Placeholder widget</div>
          </FloatingGamePanel>
          <div className={COLUMN}>
            <div className={DIALOGUE}>
              <div className="relative isolate min-h-0 flex flex-1 pointer-events-none" data-component="GameNarration.SpriteStage" />
              <FloatingGamePanel id="narration" width={896} bottom autoGrow reserveSpace>
                <div className={WRAP}>
                  <div data-component="GameNarration.ActivePanel" className={PANEL}>
                    <div data-fixture-narration className="game-narration-prose max-h-[45svh] overflow-y-auto rounded-xl border px-3 py-2.5 md:max-h-48">
                      {Array.from({ length: Number(location.hash.slice(1)) || 14 }, (_, index) => (
                        <p key={index} data-fixture-line={index} className="mb-2 text-base text-white">
                          Placeholder narration paragraph {index + 1}. The traveller walks on and the road keeps going.
                        </p>
                      ))}
                    </div>
                    {!streaming && (
                      <div ref={dock.dockRef} data-game-composer-dock className={DOCK}>
                        <GameInput
                          inline
                          draftKey="fixture-chat"
                          hasPartyMembers={false}
                          pendingMoveLabel={null}
                          onRollDice={async () => null}
                          onSend={async (body) => { window.sent.push(body.length); setStreaming(true); return true; }}
                        />
                      </div>
                    )}
                    {streaming && (
                      <div className={dock.reserved > 0 ? RESERVE : undefined} style={{ minHeight: dock.reserved || undefined }}>
                        <div data-fixture-status className="mt-2 flex items-center gap-1 text-xs text-white/50">Writing</div>
                      </div>
                    )}
                  </div>
                </div>
              </FloatingGamePanel>
            </div>
          </div>
        </GamePanelContext.Provider>
      </div>
    </QueryClientProvider>
  );
}
createRoot(document.getElementById('root')).render(<App />);
`;

const bundle = await build({
  stdin: { contents: fixture, loader: "tsx", resolveDir: process.cwd() },
  nodePaths: [resolve("packages/client/node_modules")],
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' },
  logLevel: "error",
  plugins: [
    {
      name: "fixture-modules",
      setup(plugin) {
        plugin.onResolve({ filter: /^react-i18next$/ }, () => ({ path: "translation", namespace: "fixture" }));
        plugin.onResolve({ filter: /lib\/api-client$/ }, () => ({ path: "api", namespace: "fixture" }));
        plugin.onResolve({ filter: /capabilities\/CapabilityElement$/ }, () => ({
          path: "capability",
          namespace: "fixture",
        }));
        plugin.onResolve({ filter: /locale-loader$/ }, () => ({ path: "locales", namespace: "fixture" }));
        plugin.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          contents:
            args.path === "api"
              ? "export class ApiError extends Error{};const offline=()=>Promise.reject(new ApiError('offline fixture'));export const api={get:offline,post:offline,put:offline,patch:offline,delete:offline};export const isRequestTimeoutError=()=>false;export const requestTimeoutSignal=(ms,upstream)=>upstream??new AbortController().signal;"
              : args.path === "locales"
                ? "export const APP_LANGUAGE_OPTIONS=[];export const resolveSupportedLocale=()=>'en';export const loadLocaleResource=async()=>null;export const normalizeLocaleResource=(value)=>value;"
                : args.path === "capability"
                  ? "export const CapabilityElement=()=>null;"
                  : "export const initReactI18next={type:'3rdParty',init(){}};const t=(key)=>key;export const useTranslation=()=>({t,i18n:{language:'en'}});export const Trans=({children})=>children??null;",
          loader: "js",
        }));
      },
    },
  ],
});
const script = bundle.outputFiles[0].text;

// Everything the player sees move: the narration panel, each floating panel, and the first narration line
// (which also moves if the narration scroll position jumps inside its box).
async function startSampling(page) {
  await page.evaluate(() => {
    const rect = (element) => {
      const box = element.getBoundingClientRect();
      return [box.left, box.top, box.width, box.height];
    };
    const read = () => {
      const floats = {};
      for (const panel of document.querySelectorAll("[data-game-floating-panel]"))
        floats[panel.getAttribute("data-game-floating-panel")] = rect(panel);
      const narration = document.querySelector("[data-fixture-narration]");
      return {
        panel: rect(document.querySelector('[data-component="GameNarration.ActivePanel"]')),
        firstLine: rect(document.querySelector('[data-fixture-line="0"]')),
        narrationScroll: narration.scrollHeight - narration.scrollTop,
        floats,
      };
    };
    window.baseline = read();
    window.worst = { delta: 0, what: "" };
    const compare = (a, b, what) => {
      a.forEach((value, index) => {
        const delta = Math.abs(value - b[index]);
        if (delta > window.worst.delta) window.worst = { delta, what };
      });
    };
    const loop = () => {
      const now = read();
      compare(now.panel, window.baseline.panel, "narration panel");
      compare(now.firstLine, window.baseline.firstLine, "narration line (scroll)");
      compare([now.narrationScroll], [window.baseline.narrationScroll], "narration scrollTop relative to content");
      for (const [id, box] of Object.entries(window.baseline.floats))
        compare(now.floats[id] ?? [NaN, NaN, NaN, NaN], box, `floating panel ${id}`);
      window.sampleFrame = requestAnimationFrame(loop);
    };
    loop();
  });
}
const stopSampling = (page) =>
  page.evaluate(() => {
    cancelAnimationFrame(window.sampleFrame);
    return window.worst;
  });

const longTurn = Array.from(
  { length: 40 },
  (_, index) => `Line ${index + 1} of a long placeholder turn that keeps going.`,
)
  .join(" ")
  .slice(0, 2000);

const browser = await chromium.launch({ headless: true });
const results = [];
try {
  // A short narration lets the panel grow with its content; a long one scrolls inside its capped box.
  for (const [width, height, lines] of [
    [390, 844, 1],
    [390, 844, 14],
    [820, 1180, 1],
    [820, 1180, 14],
    [1440, 900, 1],
    [1440, 900, 14],
  ]) {
    const label = `${width}x${height} ${lines} lines`;
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 768 });
    const errors = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.error(error);
    });
    // A real origin: GameInput and the panels keep drafts and layout in localStorage.
    await page.route("http://composer.fixture/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<style>${css}</style><body style="margin:0"><div id="root"></div></body>`,
      }),
    );
    await page.goto(`http://composer.fixture/#${lines}`);
    await page.addScriptTag({ content: script });
    const textarea = page.locator("[data-game-composer-dock] textarea");
    await textarea.waitFor();
    assert.equal(
      await page.locator("[data-game-floating-panel]").count(),
      width >= 1024 ? 3 : 0,
      `${label}: panels float only on desktop`,
    );
    // Read part of the narration first, so a scroll jump inside the narration box would show.
    await page.evaluate(() => {
      const narration = document.querySelector("[data-fixture-narration]");
      narration.scrollTop = Math.floor((narration.scrollHeight - narration.clientHeight) / 2);
    });
    await textarea.click();
    await page.waitForTimeout(300);

    await startSampling(page);
    await page.keyboard.insertText(longTurn);
    await page.waitForTimeout(250);
    await page.keyboard.type(" and a few more typed words at the end", { delay: 15 });
    await page.waitForTimeout(250);
    const typing = await stopSampling(page);
    const grown = await textarea.evaluate((element) => element.clientHeight);
    assert.ok(grown >= 100, `${label}: the composer grew for the long turn (${grown}px)`);
    assert.ok(
      await textarea.evaluate((element) => element.scrollHeight > element.clientHeight + 100),
      `${label}: a long turn scrolls inside the capped composer`,
    );
    assert.ok(
      typing.delta <= TOLERANCE,
      `${label}: ${typing.what} moved ${typing.delta.toFixed(1)}px while typing and pasting`,
    );

    await startSampling(page);
    await page.keyboard.press("Enter");
    await page.locator("[data-fixture-status]").waitFor();
    await page.waitForTimeout(400);
    const sending = await stopSampling(page);
    assert.deepEqual(
      await page.evaluate(() => window.sent),
      [longTurn.length + " and a few more typed words at the end".length],
      `${label}: the stubbed send received the turn`,
    );
    assert.ok(sending.delta <= TOLERANCE, `${label}: ${sending.what} moved ${sending.delta.toFixed(1)}px on send`);
    assert.deepEqual(errors, [], `${label}: no page errors`);
    results.push(`${label} typing ${typing.delta.toFixed(1)}px, send ${sending.delta.toFixed(1)}px`);
    await page.close();
  }
  console.info(`Game composer growth regression passed (${results.join("; ")})`);
} finally {
  await browser.close();
  await fs.rm(tempDirectory, { recursive: true, force: true });
}
