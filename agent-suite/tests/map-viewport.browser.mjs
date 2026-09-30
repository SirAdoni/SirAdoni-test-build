import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const engine = resolve(process.env.MARINARA_ENGINE_ROOT || "../Marinara-Engine");
const requireEngine = createRequire(resolve(engine, "package.json"));
const { build } = requireEngine("esbuild");
const components = resolve(
  "packages/hierarchical-maps/src/engine/packages/client/src/features/spatial-context/components",
).replaceAll("\\", "/");
const bundle = await build({
  stdin: {
    contents: `import React, {useRef} from 'react'; import {createRoot} from 'react-dom/client';
    import {MapViewport} from '${components}/MapViewport.tsx';
    import {SpatialLocationIcon} from '${components}/SpatialLocationIcon.tsx';
    import {LocationVectorChoices} from '${components}/LocationVectorChoices.tsx';
    import {LocationEmojiChoices} from '${components}/LocationEmojiChoices.tsx';
    import {LiveMapConnection} from '${components}/LiveMapConnection.tsx';
    const spatial={currentLocationId:'a',definition:{revision:7,locations:[{id:'a',name:'Manor',links:[{targetId:'b',state:'available',bidirectional:true}]},{id:'b',name:'Garden',links:[]},{id:'c',name:'Tower',links:[{targetId:'b',state:'available',bidirectional:true}]}]}};
    function App(){const ref=useRef(null); return <><MapViewport contentRef={ref} compact={false}><button id="marker" onPointerDown={e=>e.stopPropagation()}><SpatialLocationIcon name="Williams Manor" icon="🏛️"/></button></MapViewport><SpatialLocationIcon name="Williams Manor" icon="emoji:🏡"/><LocationVectorChoices onSelect={value=>window.chosen=value}/><LocationEmojiChoices onSelect={value=>window.chosen=value}/><LiveMapConnection chatId="fixture" spatial={spatial} fromId="a" toId="c" onClose={()=>{}}/></>}; createRoot(document.getElementById('root')).render(<App/>);`,
    loader: "tsx",
    resolveDir: engine,
  },
  nodePaths: [resolve(engine, "packages/client/node_modules"), resolve(engine, "node_modules")],
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  plugins: [
    {
      name: "shared-constant",
      setup(builder) {
        builder.onResolve({ filter: /maps-model$/ }, () => ({ path: "maps-model", namespace: "fixture" }));
        builder.onResolve({ filter: /use-spatial-context$/ }, () => ({ path: "mutation", namespace: "fixture" }));
        builder.onResolve({ filter: /use-map-confirmation$/ }, () => ({ path: "confirmation", namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          contents:
            args.path === "mutation"
              ? "export function useUpdateSpatialContext(){return {isPending:false, mutateAsync:async value=>{window.savedConnection=value;}}}"
              : args.path === "confirmation"
                ? "export function useMapConfirmation(){return {confirmAction:async()=>true,confirmationDialog:null}}"
                : "export const SPATIAL_LOCATION_ICON_MAX_LENGTH=16;",
        }));
      },
    },
  ],
});
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [900, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    const assetRequests = [];
    let failAssets = false;
    await page.route("http://icons.fixture/**", async (route) => {
      const file = new URL(route.request().url()).pathname.split("/").pop();
      if (file.startsWith("game-icons-")) {
        assetRequests.push(file);
        if (failAssets) return route.fulfill({ status: 503, body: "Unavailable" });
        return route.fulfill({
          contentType: "application/json",
          body: await readFile(resolve("packages/hierarchical-maps/assets/icons", file), "utf8"),
        });
      }
      return route.fulfill({ contentType: "text/html", body: "<html></html>" });
    });
    await page.goto("http://icons.fixture/");
    await page.setContent(
      `<style>body{margin:20px;background:#17131d;color:#eee} [data-marinara-maps-world-canvas]{position:relative;width:100%;aspect-ratio:16/9;overflow:hidden} [data-marinara-maps-world-canvas]>div{position:absolute;inset:0;background:#292432} #marker{position:absolute;left:100px;top:80px;font-size:24px}svg{display:block}</style><div id="root"></div>`,
    );
    await page.addStyleTag({
      content: "[data-marinara-maps-world-canvas]>button{position:absolute;right:4px;top:4px;z-index:20}",
    });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const canvas = page.locator("[data-marinara-maps-world-canvas]");
    await canvas.waitFor();
    const content = canvas.locator(":scope > div");
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + 180, box.y + 100);
    await page.mouse.wheel(0, -300);
    await page.waitForFunction(() =>
      document.querySelector("[data-marinara-maps-world-canvas]>div").style.transform.includes("scale(1."),
    );
    const before = await content.getAttribute("style");
    await page.mouse.move(box.x + 240, box.y + 150);
    await page.mouse.down();
    await page.mouse.move(box.x + 280, box.y + 175, { steps: 5 });
    await page.mouse.up();
    assert.notEqual(await content.getAttribute("style"), before, "left-drag pans");
    await page.getByRole("button", { name: "Reset map zoom and pan", exact: true }).click();
    assert.match(await content.getAttribute("style"), /translate\(0px, 0px\) scale\(1\)/);
    await page.mouse.move(box.x + 180, box.y + 100);
    await page.mouse.wheel(0, 300);
    await page.waitForFunction(() =>
      document.querySelector("[data-marinara-maps-world-canvas]>div").style.transform.includes("scale(0."),
    );
    assert.equal(await page.locator('[data-location-symbol="manor"] svg').count(), 1);
    assert.ok(
      (await page.locator("[data-marinara-location-icon]").allTextContents()).includes("🏡"),
      "explicit emoji overrides automatic icon",
    );
    await page.locator("summary").filter({ hasText: "Choose a location emoji" }).click();
    assert.equal(await page.getByRole("button", { name: /Use location emoji/ }).count(), 112);
    await page.getByRole("button", { name: "Use location emoji 🏡", exact: true }).click();
    assert.equal(await page.evaluate(() => window.chosen), "emoji:🏡");
    await page.getByRole("textbox", { name: "Route name" }).fill("Garden passage");
    await page.getByRole("combobox", { name: "Travel direction" }).selectOption("both");
    await page.getByRole("button", { name: "Save connection", exact: true }).click();
    const saved = await page.evaluate(() => window.savedConnection);
    assert.equal(saved.expectedRevision, 7);
    assert.equal(saved.expectedCurrentLocationId, "a");
    assert.equal(saved.definition.locations[0].links.length, 2);
    assert.equal(saved.definition.locations[2].links[0].targetId, "b", "Other incoming path to Garden survives");
    assert.deepEqual(saved.definition.locations[0].links[1], {
      targetId: "c",
      bidirectional: true,
      state: "available",
      label: "Garden passage",
    });
    assert.equal(saved.replacementCurrentLocationId, undefined, "Editing connections does not move the player");
    assert.equal(assetRequests.length, 0, "Closed picker fetches no artwork");
    await page.locator("summary").filter({ hasText: "Choose a vector symbol" }).click();
    await page.getByRole("combobox", { name: "Icon collection" }).selectOption("lucide");
    await page.getByRole("searchbox").fill("rocket");
    await page.getByRole("button", { name: "Rocket", exact: true }).click();
    assert.match(await page.evaluate(() => window.chosen), /^v:[a-f0-9]{12}$/);
    assert.equal(await page.locator("[data-location-symbol=rocket] svg").count(), 1);
    await page.getByRole("searchbox").fill("zzzznomatch");
    assert.equal(await page.getByText("No matching symbols.").count(), 1);
    await page.getByRole("combobox", { name: "Icon collection" }).selectOption("game");
    failAssets = true;
    await page.getByRole("searchbox").fill("death star");
    await page.getByRole("button", { name: "Some icons could not load. Retry" }).waitFor();
    failAssets = false;
    await page.getByRole("button", { name: "Some icons could not load. Retry" }).click();
    await page.locator('[data-location-symbol="death-star"] svg path').waitFor();
    await page.getByRole("button", { name: "Death star", exact: true }).click();
    const gameId = await page.evaluate(() => window.chosen);
    assert.match(gameId, /^v:[a-f0-9]{12}$/);
    assert.equal(assetRequests.length, 2, "One requested shard, then one explicit retry");
    await page.getByRole("searchbox").fill("death skull");
    await page.locator('[data-location-symbol="death-skull"] svg path').waitFor();
    assert.equal(assetRequests.length, 2, "Same shard is cached");
    await page.locator("summary").filter({ hasText: "Choose a vector symbol" }).click();
    await page.locator('[data-location-symbol="death-skull"]').waitFor({ state: "detached" });
    assert.equal(await page.locator('[data-location-symbol="death-skull"]').count(), 0, "Closing unmounts icon grid");
    await page.close();
  }
  process.stdout.write(
    "Desktop and narrow viewport: real wheel zoom in/out, left-drag pan, reset, manor SVG, and 112-choice emoji selection passed.\n",
  );
} finally {
  await browser.close();
}
