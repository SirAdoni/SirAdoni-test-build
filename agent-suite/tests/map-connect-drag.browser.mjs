import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
const engine = resolve(process.env.MARINARA_ENGINE_ROOT || "../Marinara-Engine");
const { build } = createRequire(resolve(engine, "package.json"))("esbuild");
const source = resolve(
  "packages/hierarchical-maps/src/engine/packages/client/src/features/spatial-context/components/MapConnectionHandle.tsx",
).replaceAll("\\", "/");
const bundle = await build({
  stdin: {
    contents: `import React,{useRef} from 'react';import{createRoot}from'react-dom/client';import{MapConnectionHandle}from'${source}';function App(){const ref=useRef(null);return <div id="viewport" style={{position:'relative',width:600,height:300}}><div ref={ref} style={{position:'absolute',inset:0}}><button data-map-node-id="a" style={{position:'absolute',left:90,top:130,width:60,height:40}}>A</button><button data-map-node-id="b" style={{position:'absolute',left:450,top:130,width:60,height:40}}>B</button><MapConnectionHandle id="a" name="A" position={{x:20,y:50}} canvasRef={ref} disabled={false} onConnect={(from,to)=>{window.links.push([from,to]);}}/></div></div>}window.links=[];createRoot(document.getElementById('root')).render(<App/>);`,
    loader: "tsx",
    resolveDir: engine,
  },
  nodePaths: [resolve(engine, "packages/client/node_modules"), resolve(engine, "node_modules")],
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
});
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(
    '<style>[data-map-connection-handle]{position:absolute;width:36px;height:36px;z-index:20}[data-map-connection-preview]{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}</style><div id="root"></div>',
  );
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const handle = page.getByRole("button", { name: "Connect from A" });
  await handle.waitFor();
  async function drag(x, y, cancel = false) {
    const h = await handle.boundingBox();
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 3 });
    assert.equal(await page.locator("[data-map-connection-preview]").count(), 1);
    if (cancel) await page.keyboard.press("Escape");
    await page.mouse.up();
    assert.equal(await page.locator("[data-map-connection-preview]").count(), 0);
  }
  const target = await page.locator('[data-map-node-id="b"]').boundingBox();
  await drag(target.x + 30, target.y + 20);
  assert.deepEqual(await page.evaluate(() => window.links), [["a", "b"]]);
  await drag(350, 240);
  assert.equal(await page.evaluate(() => window.links.length), 1, "empty drop cancels");
  await drag(target.x + 30, target.y + 20, true);
  assert.equal(await page.evaluate(() => window.links.length), 1, "Escape cancels");
  const own = await page.locator('[data-map-node-id="a"]').boundingBox();
  await drag(own.x + 30, own.y + 20);
  assert.equal(await page.evaluate(() => window.links.length), 1, "self connection rejected");
  assert.equal(
    await page.locator('[data-map-node-id="a"]').evaluate((node) => node.style.left),
    "90px",
    "node position unchanged",
  );
  process.stdout.write(
    "Connection drag browser proof passed: preview, target drop, empty/self cancellation, Escape, and unchanged node position.\n",
  );
} finally {
  await browser.close();
}
