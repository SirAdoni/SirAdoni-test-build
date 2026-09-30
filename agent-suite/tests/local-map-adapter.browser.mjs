import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
const engine = resolve(process.env.MARINARA_ENGINE_ROOT || "../Marinara-Engine");
const { build } = createRequire(resolve(engine, "package.json"))("esbuild");
const adapter = resolve(
  "packages/hierarchical-maps/src/engine/packages/client/src/components/game/GameLocalMap.tsx",
).replaceAll("\\", "/");
const result = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {GameLocalMap} from '${adapter}';
const map={id:'local-fixture',name:'Vault',description:'Keep map detail',type:'node',partyPosition:'a',nodes:[{id:'a',label:'Manor',description:'Keep room detail',emoji:'🏡',discovered:true,x:20,y:20},{id:'b',label:'Secret archive',description:'Secret',emoji:'📚',discovered:false,x:70,y:60}],edges:[{from:'a',to:'b',label:'Hallway'}]};
createRoot(document.getElementById('root')).render(<GameLocalMap chatId="fixture" map={map} spatial={{}} onSave={async value=>{window.savedLocal=value}} onMove={id=>{window.moved=id}}/>);`,
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
      name: "renderer-contract",
      setup(builder) {
        builder.onResolve({ filter: /\/GameWorldMap$/ }, () => ({ path: "renderer", namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: `import React from 'react';export function GameWorldMap(props){window.localView=props.spatial;return React.createElement('button',{onClick:()=>props.onSaveDefinition({...props.spatial.definition,locations:props.spatial.definition.locations.map(l=>l.id==='a'?{...l,placement:{x:35,y:40}}:l)})},'Save local fixture')}`,
          resolveDir: engine,
        }));
      },
    },
  ],
});
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: result.outputFiles[0].text });
  await page.getByRole("button", { name: "Save local fixture" }).click();
  const view = await page.evaluate(() => window.localView);
  assert.equal(view.definition.locations.length, 3);
  assert.equal(view.definition.locations[2].name, "Unknown location");
  assert.equal(view.definition.locations[2].description, "");
  const saved = await page.evaluate(() => window.savedLocal);
  assert.equal(saved.nodes.length, 2);
  assert.equal(saved.nodes[0].x, 35);
  assert.equal(saved.nodes[0].description, "Keep room detail");
  assert.equal(saved.nodes[1].label, "Secret archive");
  assert.equal(saved.nodes[1].discovered, false);
  assert.equal(saved.partyPosition, "a");
  assert.deepEqual(saved.edges, [{ from: "a", to: "b", label: "Hallway" }]);
  process.stdout.write(
    "Local adapter contract passed: rooms, details, discovery, edges, party position preserved. Renderer is stubbed in this adapter-only test.\n",
  );
} finally {
  await browser.close();
}
