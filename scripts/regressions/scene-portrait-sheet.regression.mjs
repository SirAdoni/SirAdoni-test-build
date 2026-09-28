import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const screenshotDir = resolve(".tmp/scene-sheet-repair");
mkdirSync(screenshotDir, { recursive: true });

const englishMessages = JSON.parse(readFileSync("packages/client/src/localization/locales/en.json", "utf8"));
const i18nStub = `
  const labels = ${JSON.stringify(englishMessages)};
  export const initReactI18next = { type: "3rdParty" };
  export function useTranslation() {
    return { t: (key, values = {}) => String(labels[key] ?? key).replace(/\\{\\{(\\w+)\\}\\}/g, (_, name) => String(values[name] ?? "")) };
  }
`;

const bundle = await build({
  stdin: {
    contents: `
      import React, { useEffect, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { GamePartyBar } from './src/components/game/GamePartyBar';
      import { GameCharacterSheet } from './src/components/game/GameCharacterSheet';
      import { ensureSceneCharacterCards } from './src/components/game/game-scene-character-cards';
      import { normalizeGameCharacterLibraryProfile } from './src/lib/game-character-profile';
      import { useGameModeStore } from './src/stores/game-mode.store';
      import { initReactI18next } from 'react-i18next';
      void initReactI18next;
      const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="200"><rect width="100" height="100" fill="red"/><rect y="100" width="100" height="100" fill="blue"/></svg>');
      const libraryRaw = {
        description: 'Quenby library description', personality: 'Quenby library personality',
        extensions: {
          backstory: 'Quenby library backstory', appearance: 'Quenby library appearance', aboutMe: 'Quenby library about me',
          rpgStats: { enabled: true, hp: { current: 200, max: 200 },
            pools: [{ name: 'Aegis', current: 100, max: 100 }, { name: 'Tenacity', current: 100, max: 100 }],
            attributes: { STR: 20, DEX: 10, CON: 19, INT: 13, WIS: 16, CHA: 11 } },
        },
      };
      const libraryProfile = normalizeGameCharacterLibraryProfile(libraryRaw);
      const cards = {
        library: {title:'Quenby', avatarUrl:image, avatarCrop:{srcX:0,srcY:0,srcWidth:1,srcHeight:.5}, libraryProfile},
        cleared: {title:'Calista', avatarUrl:image, avatarCrop:null},
        explicit: {title:'Dame Wynne Brack', avatarUrl:image, avatarCrop:{srcX:0,srcY:0,srcWidth:1,srcHeight:.5}, libraryProfile,
          gameCard: { shortDescription:'Explicit card description', class:'Explicit class', abilities:[], strengths:[], weaknesses:[], extra:{},
            rpgStats:{ attributes:[{name:'STR',value:7}], hp:{value:77,max:77}, pools:[{name:'HP',value:77,max:77,color:'#ef4444'},{name:'Custom',value:33,max:44,color:'#a78bfa'}] } } },
        disabled: {title:'No Stats', avatarUrl:image, avatarCrop:{srcX:0,srcY:0,srcWidth:1,srcHeight:.5}, libraryProfile,
          gameCard: { shortDescription:'No stats card', class:'No stats class', abilities:[], strengths:[], weaknesses:[], extra:{} }},
      };
      const sceneCards = ensureSceneCharacterCards(cards,
        [{id:'scene:mentor', name:'Maelis', avatarUrl:image, avatarCrop:{srcX:0,srcY:.5,srcWidth:1,srcHeight:.5}}],
        [{id:'scene:mentor', name:'Maelis', avatarUrl:image,
          libraryProfile:{description:'Maelis library description', appearance:'Maelis library appearance', level:12,
            rpgStats:{attributes:[{name:'WIS',value:18}], hp:{value:120,max:120}, pools:[]}}}], [], 1);
      const members = [
        {id:'scene:quenby', name:'Quenby', avatarUrl:image, avatarCrop:{srcX:0,srcY:.5,srcWidth:1,srcHeight:.5}},
        {id:'scene:mentor', name:'Maelis', avatarUrl:image, avatarCrop:{srcX:0,srcY:.5,srcWidth:1,srcHeight:.5}},
        {id:'cleared', name:'Calista', avatarUrl:image, avatarCrop:{srcX:0,srcY:.5,srcWidth:1,srcHeight:.5}},
        {id:'scene:wynne-brack', name:'Wynne Brack', avatarUrl:image, avatarCrop:{srcX:0,srcY:.5,srcWidth:1,srcHeight:.5}},
        {id:'disabled', name:'No Stats', avatarUrl:image, avatarCrop:{srcX:0,srcY:.5,srcWidth:1,srcHeight:.5}},
      ];
      function App() {
        const selected = useGameModeStore(s=>s.characterSheetCharId);
        const open = useGameModeStore(s=>s.characterSheetOpen);
        const [saved, setSaved] = useState(null);
        useEffect(() => { window.__savedGameCard = saved; }, [saved]);
        return <div id="clipped-game" style={{transform:'translateZ(0)',overflow:'hidden',height:80,width:200}}>
          <GamePartyBar partyMembers={members} partyCards={sceneCards}/>
          {open && sceneCards[selected] && <GameCharacterSheet card={sceneCards[selected]} onClose={()=>useGameModeStore.getState().closeCharacterSheet()} onSave={async (gameCard)=>setSaved(gameCard)}/>}
        </div>;
      }
      window.__normalizeGameCharacterLibraryProfile = normalizeGameCharacterLibraryProfile;
      createRoot(document.getElementById('root')).render(<App/>);
    `,
    loader: "tsx",
    resolveDir: resolve("packages/client"),
  },
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
  plugins: [{
    name: "scene-sheet-i18n-stub",
    setup(plugin) {
      plugin.onResolve({ filter: /^react-i18next$/ }, () => ({ path: "scene-sheet-i18n", namespace: "scene-sheet-i18n" }));
      plugin.onLoad({ filter: /.*/, namespace: "scene-sheet-i18n" }, () => ({ contents: i18nStub, loader: "js" }));
      plugin.onResolve({ filter: /locale-loader(?:\\.tsx?)?$/ }, () => ({ path: "scene-sheet-locale-loader", namespace: "scene-sheet-locale-loader" }));
      plugin.onLoad({ filter: /.*/, namespace: "scene-sheet-locale-loader" }, () => ({ contents: `export const APP_LANGUAGE_OPTIONS = [{ id: "en", label: "English" }]; export const resolveSupportedLocale = (value) => typeof value === "string" ? value : "en"; export const loadLocaleResource = async () => ({ metadata: { locale: "en", direction: "ltr" }, messages: {} });`, loader: "js" }));
    },
  }],
});
const assets = "packages/client/dist/assets";
// The sheet layout depends on the built Tailwind CSS, so this test needs a client build first.
if (!existsSync(assets)) {
  throw new Error(`${assets} is missing. Build the client first (pnpm build, or pnpm --filter @marinara-engine/client build), then rerun.`);
}
const css = readFileSync(`${assets}/${readdirSync(assets).find((file) => /^index-.*\.css$/.test(file))}`, "utf8");
const browser = await chromium.launch({ headless: true });
const pageErrors = [];
try {
  for (const viewport of [{ width: 1200, height: 850 }, { width: 390, height: 850 }]) {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", (error) => pageErrors.push(`${viewport.width}: ${error.message}`));
    await page.route("http://portrait.test/", (route) => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
    await page.goto("http://portrait.test/");
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.waitForTimeout(100);
    if (pageErrors.length) throw new Error(`browser page errors before portrait: ${pageErrors.join(" | ")}`);
    const quenby = page.locator('button[aria-label="Quenby"]:visible img').first();
    await quenby.waitFor();
    assert.equal(await quenby.evaluate((img) => img.style.top), "0%", "uses card face crop instead of scene body crop");
    const singer = page.locator('button[aria-label="Calista"]:visible img').first();
    assert.equal(await singer.evaluate((img) => img.style.top), "", "cleared card crop does not resurrect stale member crop");
    if (viewport.width < 640) {
      await page.getByRole("button", { name: "Open party members" }).click();
      await page.locator("[data-game-party-popover]").getByTitle("Quenby - Click to open character sheet").click();
    } else await quenby.click();
    const dialog = page.getByRole("dialog", { name: "Quenby", exact: true });
    await dialog.waitFor();
    const dialogText = await dialog.innerText();
    for (const expected of ["Quenby library description", "Quenby library personality", "Quenby library backstory", "Quenby library appearance", "Quenby library about me", "200/200", "Aegis", "Tenacity", "20", "10", "19", "13", "16", "11"]) assert.ok(dialogText.includes(expected), `Quenby sheet contains ${expected}`);
    assert.ok(!/LVL\s*9/i.test(dialogText), "library profile does not invent LVL 9");
    assert.ok(!dialogText.includes("Character data will populate as the story progresses"), "library profile is not empty");
    assert.ok((await dialog.boundingBox()).height > 80, "sheet escapes clipped game layer");
    assert.equal(await dialog.isVisible(), true, "library sheet is visible in screenshot state");
    await page.screenshot({ path: resolve(screenshotDir, `quenby-${viewport.width}.png`), fullPage: true });
    await page.getByRole("button", { name: "Edit sheet" }).click();
    await page.getByRole("button", { name: "Save sheet" }).click();
    await page.waitForTimeout(0);
    const librarySave = await page.evaluate(() => window.__savedGameCard);
    assert.equal(librarySave, undefined, "unchanged library-only sheet saves no implicit Game Mode card");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });

    const mentor = page.locator('button[aria-label="Maelis"]:visible img').first();
    if (viewport.width < 640) {
      await page.getByRole("button", { name: "Open party members" }).click();
      await page.locator("[data-game-party-popover]").getByTitle("Maelis - Click to open character sheet").click();
    } else await mentor.click();
    const mentorDialog = page.getByRole("dialog", { name: "Maelis", exact: true });
    await mentorDialog.waitFor();
    const mentorText = await mentorDialog.innerText();
    assert.ok(mentorText.includes("Maelis library description"), "scene-only library character opens a populated sheet");
    assert.ok(mentorText.includes("Maelis library appearance"), "scene-only library profile survives sheet wiring");
    await page.keyboard.press("Escape");
    await mentorDialog.waitFor({ state: "detached" });

    const explicitAvatar = page.locator('button[aria-label="Wynne Brack"]:visible img').first();
    if (viewport.width < 640) {
      await page.getByRole("button", { name: "Open party members" }).click();
      await page.locator("[data-game-party-popover]").getByTitle("Wynne Brack - Click to open character sheet").click();
    } else await explicitAvatar.click();
    const explicitDialog = page.getByRole("dialog", { name: "Dame Wynne Brack", exact: true });
    await explicitDialog.waitFor();
    const explicitText = await explicitDialog.innerText();
    assert.ok(explicitText.includes("77/77") && explicitText.includes("Custom") && explicitText.includes("33/44"), "explicit game card stats win");
    assert.ok(!explicitText.includes("200/200") && !explicitText.includes("Aegis"), "library stats do not override explicit game card stats");
    await page.getByRole("button", { name: "Edit sheet" }).click();
    await page.getByRole("button", { name: "Save sheet" }).click();
    await page.waitForTimeout(0);
    const saved = await page.evaluate(() => window.__savedGameCard);
    assert.equal(saved.rpgStats.hp.value, 77, "save preserves explicit game card HP");
    assert.ok(!JSON.stringify(saved).includes("Quenby library"), "save does not copy library profile into game card");
    await page.keyboard.press("Escape");
    await explicitDialog.waitFor({ state: "detached" });

    const disabledAvatar = page.locator('button[aria-label="No Stats"]:visible img').first();
    if (viewport.width < 640) {
      await page.getByRole("button", { name: "Open party members" }).click();
      await page.locator("[data-game-party-popover]").getByTitle("No Stats - Click to open character sheet").click();
    } else await disabledAvatar.click();
    const disabledDialog = page.getByRole("dialog", { name: "No Stats", exact: true });
    await disabledDialog.waitFor();
    const disabledText = await disabledDialog.innerText();
    assert.ok(disabledText.includes("No stats card") && !disabledText.includes("200/200") && !disabledText.includes("Aegis"), "disabled game stats do not restore library stats");
    await page.close();
  }

  const page = await browser.newPage();
  await page.route("http://portrait.test/", (route) => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
  await page.goto("http://portrait.test/");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const normalized = await page.evaluate(() => {
    const normalize = window.__normalizeGameCharacterLibraryProfile;
    const raw = { description: " keep ", extensions: { rpgStats: { enabled: true, hp: { current: 0, max: 10 }, pools: [{ name: "Zero", current: 0, max: 5 }], attributes: { STR: 0, BAD: "wat" } } } };
    const before = JSON.stringify(raw);
    return { result: normalize(raw), unchanged: JSON.stringify(raw) === before, disabled: normalize({ extensions: { rpgStats: { enabled: false, hp: { current: 99, max: 99 } } } }), malformed: normalize({ extensions: { rpgStats: { enabled: true, hp: { current: "wat", max: 0 }, pools: [{ name: "", current: "wat", max: 0 }], attributes: { STR: "wat" } } } }) };
  });
  assert.deepEqual(normalized.result.rpgStats.hp, { value: 0, max: 10 }, "zero HP/current alias is preserved");
  assert.equal(normalized.result.rpgStats.pools[0].value, 0, "zero pool/current alias is preserved");
  assert.deepEqual(normalized.result.rpgStats.attributes, [{ name: "STR", value: 0 }], "attribute map is normalized and malformed values dropped");
  assert.equal(normalized.unchanged, true, "normalization does not mutate source");
  assert.equal(normalized.disabled.rpgStats, undefined, "disabled RPG stats are ignored");
  assert.equal(normalized.malformed.rpgStats, undefined, "malformed RPG stats are ignored");
  assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join(" | ")}`);
  console.info("Scene portraits passed: contentful library sheet at desktop/mobile, explicit and disabled game-card precedence, save isolation, normalization edge cases, crop behavior, and no page errors.");
} finally {
  await browser.close();
}
