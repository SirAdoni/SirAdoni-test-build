import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import * as shared from "../../packages/shared/dist/index.js";

const require = createRequire(import.meta.url);
const clientRequire = createRequire(resolve("packages/client/package.json"));
const ts = require("typescript");
const { QueryClient } = clientRequire("@tanstack/react-query");

test("actual Wiki and independent leaf hooks reject missing, late-OFF and failed settings without dispatch", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const requests = [];
  const queries = [];
  let current = { chatId: "chat", time: "baseline" };
  const api = Object.fromEntries(
    ["get", "post", "put"].map((method) => [
      method,
      async (path, body) => {
        requests.push({ method, path, body });
        return {};
      },
    ]),
  );
  const reactQuery = {
    useQueryClient: () => qc,
    useQuery: (options) => {
      if (options.queryKey[0] === shared.FEATURE_SETTINGS_KEY)
        return qc.getQueryState(options.queryKey) ?? { status: "pending" };
      queries.push(options);
      return options;
    },
    useInfiniteQuery: (options) => {
      queries.push(options);
      return options;
    },
    useMutation: (options) => ({ ...options, mutateAsync: options.mutationFn }),
  };
  const modules = new Map();
  const load = (name) => {
    if (modules.has(name)) return modules.get(name);
    const source = readFileSync(`packages/client/src/hooks/${name}.ts`, "utf8");
    const js = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const module = { exports: {} };
    runInNewContext(
      js,
      {
        module,
        exports: module.exports,
        URLSearchParams,
        crypto: globalThis.crypto,
        require: (id) => {
          if (id === "@tanstack/react-query") return reactQuery;
          if (id === "@marinara-engine/shared") return shared;
          if (id === "react") return { useRef: (value) => ({ current: value }) };
          if (id === "../lib/api-client") return { api };
          if (id === "./use-feature-settings") return load("use-feature-settings");
          if (id === "./use-chats") return { chatKeys: { detail: (id) => ["chats", id] } };
          if (id === "../stores/game-state.store")
            return {
              useGameStateStore: {
                getState: () => ({
                  current,
                  setGameState: (value) => {
                    current = value;
                  },
                }),
              },
            };
          throw new Error(`Unexpected hook dependency ${id}`);
        },
      },
      { filename: name },
    );
    modules.set(name, module.exports);
    return module.exports;
  };
  const set = (flags) => qc.setQueryData([shared.FEATURE_SETTINGS_KEY], { settings: flags });
  const memory = load("use-campaign-memory");
  const leaf = load("use-campaign-leaf");
  const faction = load("use-faction-web");
  const family = load("use-family-tree");
  const calendar = load("use-game-calendar");
  const history = load("use-world-history");
  const cases = [
    ...["Entities", "Entity", "EntityFacts", "Timeline", "Audit", "References"].map((suffix) => [
      "campaignWiki",
      () =>
        memory[`useCampaignMemory${suffix}`](
          "chat",
          ...(["Entity", "EntityFacts", "References"].includes(suffix) ? ["entity"] : []),
        ),
    ]),
    ["campaignWiki", () => memory.useCampaignMemorySource("chat", "message", "hash", { enabled: true })],
    ...[
      "usePreviewCampaignMemoryMutation",
      "useApplyCampaignMemoryMutation",
      "useUpdateCampaignMemoryFact",
      "useCompensateCampaignMemoryMutation",
      "usePreviewCampaignMemoryImport",
      "useApplyCampaignMemoryImport",
    ].map((name) => ["campaignWiki", () => memory[name]("chat")]),
    ["familyTree", () => family.useFamilyTree("chat")],
    ["factionWeb", () => faction.useFactionWeb("chat", "org", 0, false)],
    ["factionWeb", () => faction.useFactionHistory("chat", "relation", 0)],
    ...["factionWeb", "worldHistory"].flatMap((flag) => [
      [flag, () => leaf.useCampaignLeafEntities("chat", flag, { kind: "organization" })],
      [flag, () => leaf.useCampaignLeafMutation("chat", flag)],
    ]),
    ["worldHistory", () => history.useWorldHistory("chat", { q: "", offset: 0, archived: false })],
    ...["useGameCalendar", "useSaveGameCalendar", "useAdvanceGameCalendar", "useSetGameCalendarDate"].map((name) => [
      "gameCalendar",
      () => calendar[name]("chat"),
    ]),
  ];
  const payload = {
    fact: { factId: "fact", revision: 1 },
    changes: {},
    action: "save",
    sourceId: "a",
    targetId: "b",
    kind: "parent",
    note: "",
    operationId: "op",
  };
  const dispatch = (hook) =>
    hook.queryFn
      ? hook.queryFn({ signal: new AbortController().signal, pageParam: 0 })
      : (hook.mutationFn ?? hook.save)(payload);
  for (const [flag, make] of cases) {
    qc.removeQueries({ queryKey: [shared.FEATURE_SETTINGS_KEY] });
    const missing = make();
    if (missing.queryFn) assert.equal(missing.enabled, false, flag);
    await assert.rejects(async () => dispatch(missing), /FEATURE_DISABLED/);
    set({ campaignMemory: true, [flag]: false });
    await assert.rejects(async () => dispatch(make()), /FEATURE_DISABLED/);
    if (flag !== "gameCalendar") {
      set({ [flag]: true, campaignMemory: false });
      await assert.rejects(async () => dispatch(make()), /FEATURE_DISABLED/);
    }
    set({ [flag]: true, ...(flag === "gameCalendar" ? {} : { campaignMemory: true }) });
    const on = make();
    if (on.queryFn) assert.equal(on.enabled, true, flag);
    await dispatch(on);
    const count = requests.length;
    set({});
    await assert.rejects(async () => dispatch(on), /FEATURE_DISABLED/);
    assert.equal(requests.length, count);
    set({ [flag]: true, ...(flag === "gameCalendar" ? {} : { campaignMemory: true }) });
    await dispatch(on);
    qc.getQueryCache()
      .find({ queryKey: [shared.FEATURE_SETTINGS_KEY] })
      .setState({ status: "error", error: new Error("settings unavailable") });
    await assert.rejects(async () => dispatch(on), /FEATURE_DISABLED/);
  }
  assert(requests.some(({ path }) => path.includes("/memory/factions/mutations")));
  assert(requests.some(({ path }) => path.includes("/memory/world-history/entities")));
  assert(requests.some(({ path }) => path.includes("/memory/factions/audit")));
  set({ gameCalendar: true });
  const advance = calendar.useAdvanceGameCalendar("chat");
  set({});
  // This is a response to a write already admitted while ON. Keep the local clock
  // consistent with the persisted response; OFF still rejects every new dispatch above.
  const saved = { calendar: {}, formattedTime: "persisted time" };
  advance.onSuccess(saved);
  assert.equal(current.time, "persisted time");
  assert.deepEqual(qc.getQueryData(["game-calendar", "chat"]), saved);
  qc.clear();
});
