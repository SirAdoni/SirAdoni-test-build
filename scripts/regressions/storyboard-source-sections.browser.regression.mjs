import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const clientBuilder = resolve("packages/client/src/components/game/game-storyboard-ui.ts").replaceAll("\\", "/");
const clientParser = resolve("packages/client/src/components/game/GameNarration.tsx").replaceAll("\\", "/");
const serverParser = resolve("packages/server/src/services/game/segment-edits.ts").replaceAll("\\", "/");
const sharedSkillCheck = resolve("packages/shared/src/utils/skill-check-tag.ts").replaceAll("\\", "/");
const sharedSheetCommands = resolve("packages/shared/src/utils/sheet-command-tag.ts").replaceAll("\\", "/");
const sharedDiceBranch = resolve("packages/shared/src/utils/dice-branch.ts").replaceAll("\\", "/");
const sharedTextMatching = readFileSync(resolve("packages/shared/src/utils/text-matching.ts"), "utf8");
const sharedQuoteFormat = readFileSync(resolve("packages/shared/src/utils/quote-format.ts"), "utf8");
const importedNames = new Set(["default"]);
for (const source of [readFileSync(clientBuilder, "utf8"), readFileSync(clientParser, "utf8"), readFileSync(serverParser, "utf8")]) {
  for (const match of source.matchAll(/import\s*\{([^}]+)\}/g)) {
    for (const name of match[1].split(",")) {
      const identifier = name.trim().split(/\s+as\s+/u).pop();
      if (identifier && /^[A-Za-z_$][\w$]*$/u.test(identifier)) importedNames.add(identifier);
    }
  }
}
const genericExports = [...importedNames].map((name) => (name === "default" ? "export default {};" : `export const ${name}=undefined;`)).join("");
const bundle = await build({
  stdin: {
    contents: `import{buildStoryboardSectionsFromMessage}from'${clientBuilder}';import{buildStoryboardSourceSections}from'${serverParser}';const content=\`Narration: The room is quiet.\nDialogue [Alice]: \"Hello there.\n[Alice] [main]: \"Main line.\"\n[Alice] [side]: \"Side line.\"\n[Alice] [extra]: \"Extra line.\"\n[Alice] [action]: reaches for the key.\n[Alice] [thought]: \"I should hurry.\"\n[Alice] [whisper]: \"Quietly.\"\n[camelCaseSpeaker] [main]: \"Camel line.\"\n[Book: A worn journal]\n[Note: A margin note]\`;const edits=new Map([['m:1',{speaker:'Alice Prime',content:'\"Edited hello\"'}],['m:9',{readableContent:'Edited journal',readableType:'book'}]]);const deletes=new Set(['m:3']);const meta={'segmentEdit:m:1':{speaker:'Alice Prime',content:'\"Edited hello\"'},'segmentEdit:m:9':{readableContent:'Edited journal',readableType:'book'},'segmentDelete:m:3':true};window.__sections={client:buildStoryboardSectionsFromMessage({id:'m',content},edits,deletes),server:buildStoryboardSourceSections(content,meta,'m')};`,
    loader: "tsx",
    resolveDir: process.cwd(),
  },
  nodePaths: [resolve("packages/client/node_modules"), resolve("packages/server/node_modules")],
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  plugins: [
    {
      name: "storyboard-section-fixtures",
      setup(buildApi) {
        buildApi.onResolve({ filter: /^(react|react\/jsx-runtime|lucide-react|react-i18next|@marinara-engine\/shared)$/ }, ({ path }) => ({ path, namespace: "fixture" }));
        buildApi.onResolve({ filter: /^(\.\.?\/|[A-Za-z]:)/ }, ({ path }) => {
          if (/(?:game-storyboard-ui|GameNarration|segment-edits|game-tag-parser|dialogue-quotes|skill-check-tag|sheet-command-tag|dice-branch|dice-pool|dice-notation)(?:\.js|\.ts|\.tsx)?$/u.test(path)) return undefined;
          if (path.includes("live-state")) return { path: "fixture-ruleset-live-state", namespace: "fixture" };
          return { path, namespace: "fixture" };
        });
        buildApi.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => {
          if (path === "@marinara-engine/shared")
            return {
              contents: `${sharedTextMatching}\n${sharedQuoteFormat}\nexport * from '${sharedSkillCheck}';export * from '${sharedSheetCommands}';export * from '${sharedDiceBranch}';export const formatSkillCheckResultSummary=()=>'';export const GAME_STORYBOARD_ANIMATION_DURATION_SECONDS_DEFAULT=5;export const GAME_STORYBOARD_ANIMATION_DURATION_SECONDS_MAX=30;export const GAME_STORYBOARD_ANIMATION_DURATION_SECONDS_MIN=1;export const GAME_STORYBOARD_KEYFRAME_COUNT_DEFAULT=4;export const GAME_STORYBOARD_KEYFRAME_COUNT_MAX=12;export const GAME_STORYBOARD_KEYFRAME_COUNT_MIN=1;`,
              loader: "ts",
              resolveDir: process.cwd(),
            };
          if (path === "fixture-ruleset-live-state") return { contents: "export const RULESET_SHEET_OP_NAMES=[];", loader: "js" };
          if (path === "react-i18next") return { contents: "export const useTranslation=()=>({t:(x)=>x});export const Trans=()=>null;", loader: "js" };
          if (path === "react") return { contents: "export default {};export const lazy=(fn)=>fn;export const forwardRef=(fn)=>fn;export const memo=(fn)=>fn;export const createContext=()=>({});export const Suspense=()=>null;export const useEffect=()=>{};export const useLayoutEffect=()=>{};export const useMemo=(fn)=>fn();export const useState=(x)=>[x,()=>{}];export const useCallback=(fn)=>fn;export const useRef=()=>({current:null});", loader: "js" };
          if (path.includes("game-character-name-match")) return { contents: "export const findNamedMapValue=(map,key)=>map.get(key);", loader: "js" };
          if (path === "react/jsx-runtime") return { contents: "export const jsx=()=>null;export const jsxs=()=>null;export const Fragment=()=>null;", loader: "js" };
          return { contents: genericExports, loader: "js" };
        });
      },
    },
  ],
});

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error("storyboard fixture page error", error));
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(() => window.__sections);
  assert.deepEqual(result.server, result.client, "server and client storyboard source sections must match");
  console.info("Storyboard source section parity passed.");
} finally {
  await browser.close();
}
