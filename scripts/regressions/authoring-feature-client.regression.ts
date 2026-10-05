import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import * as shared from "../../packages/shared/src/schemas/feature-settings.schema.js";

const require = createRequire(import.meta.url);
const state = { status: "success", data: { settings: {} as Record<string, boolean>, envOverrides: {} } };
const values = new Map<string, any>();
const requests: Array<{ method: string; path: string }> = [];
const queries: any[] = [];
let releaseSave: ((value: unknown) => void) | undefined;
const qc = {
  getQueryState: () => ({ status: state.status, data: state.data }),
  getQueryData: (key: readonly string[]) => (key[0] === "features" ? state.data : values.get(JSON.stringify(key))),
  setQueryData: (key: readonly string[], value: any) => {
    const id = JSON.stringify(key);
    values.set(id, typeof value === "function" ? value(values.get(id)) : value);
  },
  getQueriesData: () => [],
  invalidateQueries: async () => undefined,
};
const api = Object.fromEntries(
  ["get", "post", "put", "delete"].map((method) => [
    method,
    (path: string) => {
      requests.push({ method, path });
      if (method === "put" && path === "/prep-board")
        return new Promise((resolve) => {
          releaseSave = resolve;
        });
      return Promise.resolve({ logged: 0 });
    },
  ]),
);
const modules = new Map<string, any>();
function load(name: string): any {
  if (modules.has(name)) return modules.get(name);
  const filename = new URL(`../../packages/client/src/hooks/${name}.ts`, import.meta.url);
  const source = readFileSync(filename, "utf8");
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  const deps = (id: string): unknown => {
    if (id === "@marinara-engine/shared") return shared;
    if (id === "react") return { useCallback: (callback: unknown) => callback };
    if (id === "sonner") return { toast: { error: () => undefined } };
    if (id === "../localization/i18n") return { i18n: { t: (key: string) => key } };
    if (id === "../lib/api-client") return { api, ApiError: class extends Error {} };
    if (id === "@tanstack/react-query")
      return {
        useQueryClient: () => qc,
        useMutation: (options: unknown) => options,
        useQuery: (options: any) => {
          if (options.queryKey[0] === "features") return { data: state.data, isError: state.status === "error" };
          queries.push(options);
          return { data: qc.getQueryData(options.queryKey) };
        },
      };
    if (id.startsWith("./use-")) return load(id.slice(2));
    return require(id);
  };
  vm.runInNewContext(
    result.outputText,
    { module, exports: module.exports, require: deps },
    { filename: filename.pathname },
  );
  modules.set(name, module.exports);
  return module.exports;
}
const features = load("use-feature-settings");
const dice = load("use-game-tools");
const tables = load("use-random-tables");
const prep = load("use-prep-board");
const flags = ["gamePrepBoard", "randomTables", "diceLog"] as const;
for (const name of flags) {
  assert.equal(features.useFeatureEnabled(name), false, `${name}: absent is OFF`);
  state.data.settings[name] = true;
  assert.equal(features.useFeatureEnabled(name), true);
  state.status = "error";
  assert.equal(features.useFeatureEnabled(name), false, "stale ON data must fail closed after query error");
  assert.equal(features.getCachedFeatureEnabled(qc, name), false);
  state.status = "success";
  state.data.settings[name] = false;
}
const boardKey = ["prep-board", "chat"];
values.set(JSON.stringify(boardKey), { board: { sections: [], items: [] }, revision: 1, gameId: "game" });
prep.usePrepBoard("chat");
dice.useDiceLog("chat", "game");
tables.useRandomTables("chat");
tables.useLorebookTableSources("lorebook");
assert.ok(
  queries.every((query) => query.enabled === false),
  "disabled observers do not fetch",
);
assert.equal(queries.find((query) => query.queryKey[0] === "game-dice-log").refetchInterval, false);
const rolls = tables.useRandomTableRolls("chat");
await assert.rejects(rolls.roll.mutationFn({ tableId: "table", log: true }), /settings.features.disabled/);
const entry = { source: "player", chatId: "chat", result: {} };
dice.recordDiceLogEntry(qc, entry);
assert.equal(requests.length, 0, "OFF performs no optional request");
state.data.settings.randomTables = true;
state.data.settings.diceLog = true;
await rolls.roll.mutationFn({ tableId: "table", log: true });
dice.recordDiceLogEntry(qc, entry);
await Promise.resolve();
assert.equal(requests.length, 2, "ON enables independent table and history operations");
state.data.settings.randomTables = false;
state.data.settings.diceLog = false;
await assert.rejects(rolls.oracle.mutationFn({ likelihood: "even", log: true }), /settings.features.disabled/);
dice.recordDiceLogEntry(qc, entry);
assert.equal(requests.length, 2, "existing callbacks recheck after ON to OFF");
state.data.settings.gamePrepBoard = true;
const editor = prep.usePrepBoard("chat");
editor.edit((board: any) => ({ ...board, items: [{ text: "first" }] }));
editor.edit((board: any) => ({ ...board, items: [{ text: "queued" }] }));
assert.ok(releaseSave, "first enabled save started");
state.data.settings.gamePrepBoard = false;
releaseSave({ revision: 2, updatedAt: "fixture" });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(
  requests.filter((request) => request.path === "/prep-board").length,
  1,
  "disable suppresses queued follow-up save",
);
assert.equal(
  editor.edit(() => ({ sections: [], items: [] })),
  null,
);
assert.ok(values.has(JSON.stringify(boardKey)), "turning OFF retains cached content");
console.log("Authoring client default/OFF/ON/OFF, error and queued-save regression passed.");
