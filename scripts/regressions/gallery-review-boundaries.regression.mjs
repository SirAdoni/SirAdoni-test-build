import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import ts from "typescript";
const root = new URL("../../", import.meta.url);
const read = (p) =>
  process.env.REPRO_HEAD
    ? execFileSync("git", ["show", process.env.REPRO_HEAD + ":" + p], { cwd: root, encoding: "utf8" })
    : readFileSync(new URL(p, root), "utf8");
const parse = (p) => ts.createSourceFile(p, read(p), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const find = (s, p) => {
  let result;
  const walk = (n) => {
    if (p(n)) result = n;
    ts.forEachChild(n, walk);
  };
  walk(s);
  assert.ok(result);
  return result;
};
const evaluate = (code, scope) =>
  new Function(
    ...Object.keys(scope),
    ts.transpileModule("const result = " + code + ";", { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
      .outputText + ";return result;",
  )(...Object.values(scope));
let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log("PASS " + name);
  } catch (e) {
    failures++;
    console.error("FAIL " + name + ": " + e.message);
  }
};
check("Select all respects displayed image limit and preserves search semantics", () => {
  const s = parse("packages/client/src/components/chat/ChatGallery.tsx");
  const expression = find(
    s,
    (n) => ts.isVariableDeclaration(n) && n.name.getText(s) === "selectableImageIds",
  ).initializer.getText(s);
  const images = Array.from({ length: 100 }, (_, i) => ({ id: "image-" + i }));
  const scope = {
    images,
    visibleLimit: 48,
    assetSearchActive: false,
    filteredAssets: [],
    chatId: "chat",
    useMemo: (f) => f(),
    getChatGalleryImageId: (a) => a.imageId,
  };
  assert.equal(evaluate(expression, scope).length, 48);
  assert.equal(evaluate(expression, { ...scope, visibleLimit: Infinity }).length, 100);
  assert.deepEqual(
    evaluate(expression, { ...scope, assetSearchActive: true, filteredAssets: [{ imageId: "image-99" }] }),
    ["image-99"],
  );
});
check("Lightbox leaves arrow defaults alone without navigation callbacks", () => {
  const s = parse("packages/client/src/components/chat/ChatImageLightbox.tsx");
  const handler = find(
    s,
    (n) => ts.isJsxAttribute(n) && n.name.getText(s) === "onKeyDown" && n.getText(s).includes("ArrowLeft"),
  ).initializer.expression.getText(s);
  for (const enabled of [false, true]) {
    let prevented = 0;
    const fn = evaluate(handler, {
      onPrevious: undefined,
      onNext: undefined,
      isGalleryBrowsingEnabled: () => enabled,
      queryClient: {},
    });
    fn({
      key: "ArrowRight",
      target: { closest: () => null },
      preventDefault: () => prevented++,
      stopPropagation: () => {},
    });
    assert.equal(prevented, 0);
  }
});
check("Gallery hook and dispatch use the same successful-settings requirement", () => {
  const s = parse("packages/client/src/hooks/use-feature-settings.ts");
  const fn = find(s, (n) => ts.isFunctionDeclaration(n) && n.name?.text === "useFeatureEnabled")
    .getText(s)
    .replace(/^export /, "");
  for (const status of ["pending", "error", "success"]) {
    const query = { status, isError: status === "error", data: { effective: { galleryBrowsing: true } } };
    const actual = new Function(
      "useFeatureSettings",
      "resolveFeatureEnabled",
      ts.transpileModule(fn, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText +
        ';return useFeatureEnabled("galleryBrowsing");',
    )(
      () => query,
      () => false,
    );
    assert.equal(actual, status === "success");
  }
});
if (failures) process.exitCode = 1;
