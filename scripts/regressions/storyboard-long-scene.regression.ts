import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const ts = require("typescript");
const { z } = require("zod");

// Exercise the actual route's private schema and normalizer without starting a writer or provider.
const route = readFileSync(new URL("../../packages/server/src/routes/game.routes.ts", import.meta.url), "utf8");
const schemaStart = route.indexOf("const generateStoryboardSchema = z.object(");
const sectionStart = route.indexOf("sections: z", schemaStart) + "sections: ".length;
const sectionEnd = route.indexOf("    keyframeCount:", sectionStart);
const expression = route.slice(sectionStart, sectionEnd).trim().replace(/,$/, "");
const schema = new Function("z", `return ${expression}`)(z);
const ast = ts.createSourceFile("game.routes.ts", route, ts.ScriptTarget.Latest, true);
const names = new Set([
  "normalizeStoryboardSections",
  "normalizeStoryboardSourceSectionKind",
  "normalizeStoryboardAnchorKind",
  "compactStoryboardText",
  "asStoryboardRecord",
]);
const functions = ast.statements
  .filter((node) => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text))
  .map((node) => node.getText(ast));
assert.equal(functions.length, names.size);
const kinds = route.match(/const STORYBOARD_ANCHOR_KINDS[\s\S]*?;/)![0];
const compiled = ts.transpileModule(kinds + functions.join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const normalize = new Function(`${compiled};return normalizeStoryboardSections;`)() as (
  sections: unknown,
  text: string,
) => Array<{ index: number; content: string }>;
const sections = Array.from({ length: 317 }, (_, index) => ({
  index,
  kind: "narration",
  content: index === 316 ? "The evening ends with the last performance and the return home." : `Scene beat ${index}.`,
}));
assert.equal(schema.safeParse(sections).success, true);
assert.equal(normalize(sections, "").length, 317);
assert.equal(normalize(sections, "").at(-1)?.content, sections[316]!.content);
assert.equal(normalize(undefined, sections.map((s) => s.content).join("\n\n")).length, 317);
assert.equal(schema.safeParse(Array.from({ length: 1001 }, (_, index) => ({ ...sections[0], index }))).success, true);
assert.equal(schema.safeParse(Array.from({ length: 1002 }, (_, index) => ({ ...sections[0], index }))).success, false);
assert.equal(schema.safeParse([{ ...sections[0], index: 1001 }]).success, false);
assert.equal(schema.safeParse([{ ...sections[0], content: "x".repeat(6001) }]).success, false);
assert.equal(
  schema.safeParse(Array.from({ length: 34 }, (_, index) => ({ ...sections[0], index, content: "x".repeat(6000) })))
    .success,
  false,
);
assert.equal(schema.safeParse(undefined).success, true);
console.info(
  "Long storyboard scenes retain all 317 sections including their ending; section, index and total-size limits remain enforced.",
);
