import assert from "node:assert/strict";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const component = resolve("packages/client/src/components/characters/CharacterReferences.tsx").replaceAll("\\", "/");
const bundle = await build({
  stdin: {
    contents: `import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {CharacterReferencesProvider,GameCharacterReferences,CharacterLinkedContent} from '${component}';
    function Layout({children}){return <section>{children}</section>}
    window.rows=[{id:'brynna',data:{name:'Brynna Coldstream',extensions:{}}},{id:'ann1',data:{name:'Anna Rose'}},{id:'ann2',data:{name:'Anna Gray'}}];
    function App(){const [tick,setTick]=useState(0);return <><button id="rename" onClick={()=>{window.rows[0]={id:'brynna',data:{name:'Brynna Snow',extensions:{referenceNames:['Brynna Coldstream']}}};window.rows=[...window.rows];setTick(tick+1)}}>Rename fixture</button>
      <CharacterReferencesProvider><GameCharacterReferences cards={{brynna:{title:tick?'Brynna Snow':'Brynna Coldstream'},'npc:guard':{title:'Gatekeeper Orin'}}} onOpen={id=>window.opened=id}>
      <div id="message"><CharacterLinkedContent><p>Brynna Coldstream spoke to Anna. Gatekeeper Orin nodded.</p><code>Brynna Coldstream</code><a href="#existing">Brynna Coldstream</a><p>Annabelle</p></CharacterLinkedContent></div>
      <div id="widget"><CharacterLinkedContent currentNames>Brynna Coldstream</CharacterLinkedContent></div>
      <div id="short"><CharacterLinkedContent currentNames>Brynna</CharacterLinkedContent></div>
      <div id="html"><CharacterLinkedContent><Layout><div dangerouslySetInnerHTML={{__html:'<p title="Brynna Coldstream">Brynna Coldstream</p><pre>Brynna Coldstream</pre><a href="#existing">Brynna Coldstream</a>'}} /></Layout></CharacterLinkedContent></div>
      </GameCharacterReferences></CharacterReferencesProvider></>};createRoot(document.getElementById('root')).render(<App/>);`,
    loader: "tsx",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  nodePaths: [resolve("packages/client/node_modules")],
  plugins: [
    {
      name: "fixture",
      setup(b) {
        b.onResolve({ filter: /use-characters$/ }, () => ({ path: "characters", namespace: "fixture" }));
        b.onResolve({ filter: /ui.store$/ }, () => ({ path: "ui", namespace: "fixture" }));
        b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: "i18n", namespace: "fixture" }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
          contents:
            path === "characters"
              ? "export const useCharacters=()=>({data:window.rows});"
              : path === "ui"
                ? "export const useUIStore={getState:()=>({openCharacterDetail:id=>window.opened=id})};"
                : "export const useTranslation=()=>({t:(_key,{name})=>'Open '+name});",
        }));
      },
    },
  ],
});
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1200, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const message = page.locator("#message");
    assert.equal(
      await message.locator("[data-character-reference]").count(),
      2,
      "Only unambiguous prose names are linked",
    );
    assert.equal(await message.locator("code button,a button").count(), 0);
    await message.getByRole("button", { name: "Open Brynna Coldstream", exact: true }).click();
    assert.equal(await page.evaluate(() => window.opened), "brynna");
    await message.getByRole("button", { name: "Open Gatekeeper Orin", exact: true }).focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => window.opened), "npc:guard");
    assert.equal(await page.locator("#html [data-character-reference]").count(), 1);
    assert.equal(await page.locator("#html p").getAttribute("title"), "Brynna Coldstream");
    await page.locator("#rename").click();
    await page.locator("#widget").getByRole("button", { name: "Open Brynna Snow", exact: true }).waitFor();
    assert.equal(await page.locator("#widget button").textContent(), "Brynna Snow");
    assert.equal(await page.locator("#short button").textContent(), "Brynna", "Short widget names stay compact");
    assert.equal(
      await message.getByRole("button", { name: "Open Brynna Snow", exact: true }).textContent(),
      "Brynna Coldstream",
      "Historical wording is preserved",
    );
    await message.getByRole("button", { name: "Open Brynna Snow", exact: true }).click();
    assert.equal(await page.evaluate(() => window.opened), "brynna", "Rename retains target ID");
    await page.close();
  }
  process.stdout.write(
    "Character reference browser proof: message/HTML/widget links, NPCs, keyboard, ambiguity, code/link exclusion and rename continuity passed at desktop/mobile widths.\n",
  );
} finally {
  await browser.close();
}
