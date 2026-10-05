import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import ts from "typescript";

// Execute the actual component and callback expressions. An optional frozen ref
// makes the original failures reproducible without replacing working source.
const root = new URL("../../", import.meta.url);
const read = (path: string) =>
  process.env.REPRO_HEAD
    ? execFileSync("git", ["show", `${process.env.REPRO_HEAD}:${path}`], { cwd: root, encoding: "utf8" })
    : readFileSync(new URL(path, root), "utf8");
const requireClient = createRequire(new URL("packages/client/package.json", root));
const jsx = requireClient("react/jsx-runtime");
const { renderToStaticMarkup } = requireClient("react-dom/server");
const compile = (code: string) =>
  ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
const parse = (name: string, code: string) =>
  ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const find = (source: ts.SourceFile, predicate: (node: ts.Node) => boolean): ts.Node => {
  let found: ts.Node | undefined;
  const walk = (node: ts.Node) => {
    if (predicate(node)) found = node;
    ts.forEachChild(node, walk);
  };
  walk(source);
  assert.ok(found, "required production expression exists");
  return found;
};
const evaluate = (expression: string, scope: Record<string, unknown>) =>
  new Function(...Object.keys(scope), `${compile(`const result = (${expression});`)}; return result;`)(
    ...Object.values(scope),
  );
const failures: string[] = [];
const check = (name: string, run: () => void) => {
  try {
    run();
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    failures.push(name);
    process.stderr.write(`FAIL ${name}: ${String(error)}\n`);
  }
};

check("disabled continuity is neutral; receipt keys use stable IDs", () => {
  let enabled = false;
  const batches = ["first", "second"].map((id) => ({ id, sessionNumber: 1, status: "published", sourceCurrent: true }));
  const status = { isSuccess: true, data: { config: { mode: "active" }, batches, gaps: [] } };
  const exports: Record<string, any> = {};
  const dependencies: Record<string, unknown> = {
    "react/jsx-runtime": jsx,
    "@tanstack/react-query": { useQuery: () => status },
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
    "../../lib/api-client": { api: {} },
    "../../hooks/use-feature-settings": { useFeatureEnabled: (key: string) => key === "gameMemoryControls" || enabled },
    "./GameMemorySettings": { GameMemorySettings: () => null },
  };
  new Function("require", "exports", compile(read("packages/client/src/components/game/GameContinuityPanel.tsx")))(
    (id: string) => {
      assert.ok(id in dependencies, id);
      return dependencies[id];
    },
    exports,
  );
  const off = renderToStaticMarkup(exports.GameContinuityPanel({ chatId: "fixture" }));
  assert.doesNotMatch(off, /role="alert"/);
  assert.match(off, /ui.game.continuity.disabled/);
  enabled = true;
  const keys: string[] = [];
  const visit = (element: any) => {
    if (Array.isArray(element)) return element.forEach(visit);
    if (!element || typeof element !== "object") return;
    if (element.type === "li") keys.push(element.key);
    visit(element.props?.children);
  };
  visit(exports.GameContinuityPanel({ chatId: "fixture" }));
  assert.deepEqual(keys.sort(), ["first", "second"]);
});

check("Resume dispatch uses currently enabled steps and refuses an empty selection", () => {
  const source = parse("CampaignIndexDialog.tsx", read("packages/client/src/components/game/CampaignIndexDialog.tsx"));
  const initializer = (name: string) =>
    (
      find(source, (n) => ts.isVariableDeclaration(n) && n.name.getText(source) === name) as ts.VariableDeclaration
    ).initializer!.getText(source);
  const button = find(
    source,
    (n) =>
      ts.isJsxElement(n) &&
      n.openingElement.tagName.getText(source) === "button" &&
      n.getText(source).includes('t("ui.game.campaignIndex.resume")'),
  ) as ts.JsxElement;
  const attr = (name: string) =>
    (
      (
        button.openingElement.attributes.properties.find(
          (n) => ts.isJsxAttribute(n) && n.name.getText(source) === name,
        ) as ts.JsxAttribute
      ).initializer as ts.JsxExpression
    ).expression!.getText(source);
  for (const memoryEnabled of [false, true])
    for (const continuityEnabled of [false, true]) {
      const sent: unknown[] = [];
      const steps = { registerOwners: true, backfill: true, publishVerified: true };
      const effectiveSteps = evaluate(initializer("effectiveSteps"), { steps, memoryEnabled, continuityEnabled });
      const run = { isPending: false, mutate: (body: unknown) => sent.push(body) };
      const canStart = evaluate(initializer("canStart"), { steps, effectiveSteps, run, lineageHeld: false });
      const scope = { steps, effectiveSteps, canStart, run, jobTargetMismatch: false, job: {} };
      assert.equal(evaluate(attr("disabled"), scope), !memoryEnabled && !continuityEnabled);
      evaluate(attr("onClick"), scope)();
      assert.deepEqual(sent, canStart ? [effectiveSteps] : []);
    }
});

check("late OFF reports an SSE error and prevents the dice follow-up dispatch", () => {
  const source = parse("generate.routes.ts", read("packages/server/src/routes/generate.routes.ts"));
  const guard = find(
    source,
    (n) => ts.isVariableDeclaration(n) && n.name.getText(source) === "cancelIfOptionalMemoryWasDisabled",
  ) as ts.VariableDeclaration;
  const call = find(
    source,
    (n) =>
      ts.isCallExpression(n) &&
      n.expression.getText(source) === "provider.chat" &&
      n.arguments[0]?.getText(source) === "continuationMessages",
  );
  let declaration = call;
  while (!ts.isVariableStatement(declaration)) declaration = declaration.parent;
  const block = declaration.parent as ts.Block;
  const previous = block.statements
    .slice(0, block.statements.indexOf(declaration as ts.Statement))
    .findLast((n) => ts.isIfStatement(n) && n.expression.getText(source) === "cancelIfOptionalMemoryWasDisabled()");
  assert.ok(previous, "the actual dice provider dispatch has a late-OFF guard");
  for (const disabled of [false, true]) {
    const abortController = new AbortController();
    const events: unknown[] = [];
    const cancel = evaluate(guard.initializer!.getText(source), {
      wasOptionalMemoryPromptDisabled: () => disabled,
      memoryControlsPromptApplied: true,
      campaignMemoryPromptApplied: true,
      abortController,
      reply: {},
      sendSseEvent: (_reply: unknown, event: unknown) => events.push(event),
    });
    const dispatch = new Function(
      "cancelIfOptionalMemoryWasDisabled",
      `${compile(previous.getText(source))}; return "sent";`,
    );
    assert.equal(dispatch(cancel), disabled ? null : "sent");
    assert.equal(abortController.signal.aborted, disabled);
    assert.equal(events.length, disabled ? 1 : 0);
    if (disabled) assert.equal((events[0] as { type: string }).type, "error");
  }
});
assert.deepEqual(failures, [], "production boundary regressions");
