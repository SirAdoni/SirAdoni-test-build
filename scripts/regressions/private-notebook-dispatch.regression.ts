import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import * as shared from "../../packages/shared/src/index.js";

const require = createRequire(import.meta.url);
const state = { status: "success", data: { settings: {} as Record<string, boolean> } };
let requests = 0;
const qc = {
  getQueryState: () => ({ status: state.status }),
  getQueryData: () => state.data,
};
const modules = new Map<string, any>();
function load(name: string): any {
  if (modules.has(name)) return modules.get(name);
  const filename = new URL(`../../packages/client/src/hooks/${name}.ts`, import.meta.url);
  const source = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const deps = (id: string): unknown => {
    if (id === "@marinara-engine/shared") return shared;
    if (id === "sonner") return { toast: { error() {} } };
    if (id === "../localization/i18n") return { translate: (key: string) => key };
    if (id === "../lib/api-client")
      return {
        api: {
          put: async () => {
            requests++;
            return {};
          },
        },
        ApiError: class extends Error {},
      };
    if (id === "@tanstack/react-query")
      return {
        useQueryClient: () => qc,
        useMutation: (options: unknown) => options,
        useQuery: () => ({ data: state.data, isSuccess: state.status === "success" }),
      };
    if (id.startsWith("./use-")) return load(id.slice(2));
    return require(id);
  };
  vm.runInNewContext(source, { module, exports: module.exports, require: deps }, { filename: filename.pathname });
  modules.set(name, module.exports);
  return module.exports;
}
const feature = "privateNotebook";
const features = load("use-feature-settings");
const mutation = load("use-private-notebook").useUpdatePrivateNotebook();
const input: unknown = { chatId: "fixture", input: {} };
assert.equal(features.useFeatureEnabled(feature), false, "missing opt-in stays OFF");
await assert.rejects(() => mutation.mutationFn(input));
assert.equal(requests, 0);
state.data.settings[feature] = true;
assert.equal(features.useFeatureEnabled(feature), true);
await mutation.mutationFn(input);
assert.equal(requests, 1);
state.data.settings[feature] = false;
await assert.rejects(() => mutation.mutationFn(input), "previously created mutation must recheck OFF");
state.data.settings[feature] = true;
state.status = "error";
assert.equal(features.useFeatureEnabled(feature), false, "stale ON data after error fails closed");
await assert.rejects(() => mutation.mutationFn(input));
assert.equal(requests, 1, "OFF/error callbacks must not dispatch requests");
console.info("Feature dispatch regression passed.");
