import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
const engine = resolve(process.env.MARINARA_ENGINE_ROOT || "../Marinara-Engine");
const { build } = createRequire(resolve(engine, "package.json"))("esbuild");
const base = resolve(
  "packages/hierarchical-maps/src/engine/packages/client/src/features/spatial-context/components",
).replaceAll("\\", "/");
const vectors = JSON.parse(await readFile(base + "/location-vectors.json", "utf8"));
assert.equal(vectors.length, 1599);
assert.equal(new Set(vectors.map((v) => v.id)).size, vectors.length);
assert.ok(
  vectors.every(
    (v) =>
      v.id.length <= 16 &&
      v.nodes.length &&
      v.nodes.every(([tag]) => ["path", "rect", "circle", "ellipse", "polygon", "polyline", "line"].includes(tag)),
  ),
);
const rocket = vectors.find((v) => v.name === "rocket").id;
const result = await build({
  stdin: {
    contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {LocalMapCanvas} from '${base}/LocalMapCanvas';
function App(){const [connectionEditing,setConnectionEditing]=useState(false);window.setConnectionEditing=setConnectionEditing;const [places,setPlaces]=useState([{id:'a',name:'Fantasy Manor',icon:'${rocket}',links:[],placement:{x:25,y:40}},{id:'b',name:'Tower',links:[],placement:{x:75,y:40}}]);window.resetPlacement=()=>setPlaces(old=>old.map(p=>p.id==="a"?{...p,placement:{x:25,y:40}}:p));return <LocalMapCanvas locations={places} selectedId="a" onSelect={()=>{}} onEnter={id=>window.entered=id} editing connectionEditing={connectionEditing} hierarchyProfile={{showConnections:false}} onMove={(id,placement)=>{window.moved=id;window.savedPlacement=placement;setPlaces(old=>old.map(p=>p.id===id?{...p,placement}:p))}} onConnect={(from,to)=>window.connected=[from,to]} />};createRoot(document.getElementById('root')).render(<App/>);`,
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
      name: "contract",
      setup(b) {
        b.onResolve({ filter: /maps-model$/ }, () => ({ path: "model", namespace: "fixture" }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents:
            "export const SPATIAL_LOCATION_ICON_MAX_LENGTH=16;export const resolveSpatialLinkPresentation=()=>({});export const spatialLinkPresentationKey=(a,b)=>a+b;export const spatialLinkStrokeDasharray=()=>undefined;",
        }));
      },
    },
  ],
});
const browser = await chromium.launch();
try {
  for (const width of [1200, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on("pageerror", (error) => console.error(error));
    await page.setContent(
      `<style>body{margin:10px} [data-marinara-maps-world-canvas]{position:relative;overflow:hidden}[data-marinara-maps-world-canvas]>div,[data-marinara-maps-editor-canvas]{position:absolute;inset:0}[data-marinara-maps-editor-canvas]>div{position:absolute;width:104px}[data-map-node-id]{width:104px;height:44px}[data-map-connection-handle]{position:absolute;width:36px;height:36px}[data-marinara-maps-world-canvas]>button{position:absolute;right:4px;top:4px;z-index:20}svg{display:block}</style><div id="root"></div>`,
    );
    await page.addScriptTag({ content: result.outputFiles[0].text });
    const a = page.locator("[data-map-node-id=a]");
    await a.waitFor();
    assert.ok((await page.locator("[data-marinara-maps-world-canvas]").boundingBox()).height >= 280);
    assert.equal(
      await a.locator("[data-location-symbol=rocket] svg").count(),
      1,
      "Explicit vector overrides manor guessing",
    );
    let box = await a.boundingBox();
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 35, box.y + 70, { steps: 3 });
    await page.mouse.up();
    assert.equal(await page.evaluate(() => window.moved), "a");
    const snapped = await page.evaluate(() => window.savedPlacement);
    assert.equal(snapped.x % 5, 0);
    assert.equal(snapped.y % 5, 0);
    for (let i = 0; i < 25; i++) await a.press("ArrowRight");
    assert.ok((await page.evaluate(() => window.savedPlacement)).x > 100, "Can move beyond the original right edge");
    for (let i = 0; i < 60; i++) await a.press("ArrowLeft");
    assert.ok((await page.evaluate(() => window.savedPlacement)).x < 0, "Can move beyond the original left edge");
    await page.evaluate(() => window.resetPlacement());
    assert.equal(await page.locator("[data-map-connection-handle]").count(), 0, "Browse mode hides plus handles");
    await page.evaluate(() => window.setConnectionEditing(true));
    const handle = page.locator("[data-map-connection-handle=a]");
    await handle.click();
    await page.locator("[data-map-node-id=b]").click();
    assert.deepEqual(await page.evaluate(() => window.connected), ["a", "b"]);
    await handle.click();
    await page.evaluate(() => window.setConnectionEditing(false));
    await handle.waitFor({ state: "detached" });
    await page.evaluate(() => {
      window.connected = null;
    });
    await page.locator("[data-map-node-id=b]").click();
    assert.equal(await page.evaluate(() => window.connected), null, "Leaving edit mode cancels a pending link");
    const canvas = page.locator("[data-marinara-maps-world-canvas]");
    const before = (await a.boundingBox()).width;
    const canvasBox = await canvas.boundingBox();
    await page.mouse.move(canvasBox.x + 40, canvasBox.y + canvasBox.height * 0.7);
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(100);
    assert.ok(Math.abs((await a.boundingBox()).width - before) < 1, "Zoom preserves marker size");
    const prior = await canvas.locator(":scope>div").getAttribute("style");
    await page.mouse.move(canvasBox.x + 40, canvasBox.y + canvasBox.height * 0.8);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + 90, canvasBox.y + canvasBox.height * 0.8 + 20);
    await page.mouse.up();
    assert.notEqual(await canvas.locator(":scope>div").getAttribute("style"), prior, "Background drag pans");
    await page.getByRole("button", { name: "Reset map zoom and pan" }).click();
    await a.dblclick();
    assert.equal(await page.evaluate(() => window.entered), "a");
    await page.close();
  }
  console.log(
    "1,599 unique safe vectors; full-screen desktop/mobile selection, drag, connect, zoom, pan and enter passed.",
  );
} finally {
  await browser.close();
}
