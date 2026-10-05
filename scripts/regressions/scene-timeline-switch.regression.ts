import assert from "node:assert/strict";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { isGameSceneTimelineEnabled } from "../../packages/shared/src/utils/game-feature-switches.js";
import {
  isSceneTimelineEnabled,
  snapshotPresenceTimeline,
} from "../../packages/server/src/services/game/game-feature-switches.js";
import {
  applyFeatureSettingsValue,
  getFeatureSettings,
} from "../../packages/server/src/services/features/feature-settings.js";
import {
  isSceneTimelinePending,
  queueSceneTimeline,
  sceneTimelineRecap,
} from "../../packages/server/src/services/game/scene-timeline.service.js";

const party = [
  { id: "player-1", name: "Player One" },
  { id: "guide-1", name: "Guide One" },
];

assert.equal(isGameSceneTimelineEnabled({}), true, "existing games default to timeline presence");
assert.equal(
  isGameSceneTimelineEnabled({ gameSceneTimelineEnabled: false }),
  false,
  "the per-game switch disables scene tracking",
);

const snapshot = snapshotPresenceTimeline([{ characterId: "guide-1", name: "Guide One" }], party);
assert.deepEqual(snapshot.scenes[0]?.present, ["Guide One"], "OFF mode honors the saved tracker snapshot");
assert.equal(snapshot.pending, false, "snapshot fallback never queues timeline work");

const noMatch = snapshotPresenceTimeline([{ name: "Unknown Witness" }], party);
assert.deepEqual(
  noMatch.scenes[0]?.present,
  ["Player One", "Guide One"],
  "a snapshot with no known party match preserves upstream all-party availability",
);

const originalSettings = getFeatureSettings();
try {
  applyFeatureSettingsValue(null);
  assert.equal(isSceneTimelineEnabled({}), false, "app-level opt-in defaults OFF even when a chat defaults ON");
  applyFeatureSettingsValue(JSON.stringify({ sceneTimeline: true }));
  assert.equal(isSceneTimelineEnabled({}), true, "app and chat defaults allow the opted-in timeline");
  assert.equal(
    isSceneTimelineEnabled({ gameSceneTimelineEnabled: false }),
    false,
    "the chat-level setting remains an independent second gate",
  );
  applyFeatureSettingsValue(JSON.stringify({ sceneTimeline: false }));
  assert.equal(isSceneTimelineEnabled({ gameSceneTimelineEnabled: true }), false, "app OFF overrides chat ON");
  queueSceneTimeline({} as never, "disabled-chat");
  assert.equal(isSceneTimelinePending("disabled-chat"), false, "app OFF never starts a background timeline job");
  assert.equal(await sceneTimelineRecap({} as never, "disabled-chat"), "", "app OFF never attaches a scene recap");

  // Run the actual route admission block with the real feature resolver and an awaited chat read.
  const route = readFileSync(new URL("../../packages/server/src/routes/game.routes.ts", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("game.routes.ts", route, ts.ScriptTarget.Latest, true);
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    nodes.push(node);
    node.forEachChild(visit);
  };
  visit(parsed);
  const resultNode = nodes.find(
    (n) => ts.isVariableDeclaration(n) && n.name.getText(parsed) === "sceneTimelineDisabledResult",
  ) as ts.VariableDeclaration;
  assert.ok(resultNode?.initializer);
  const disabled = new Function(`return (${resultNode.initializer.getText(parsed)});`)();
  const consumer = nodes.find(
    (n) => ts.isIfStatement(n) && n.expression.getText(parsed) === "conclusionResult === sceneTimelineDisabledResult",
  );
  assert.ok(consumer);
  const consume = new Function(
    "conclusionResult",
    "sceneTimelineDisabledResult",
    "reply",
    ts.transpileModule(consumer.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
  );
  const start = route.indexOf("      if (sceneTimelineRecapText) {");
  const end = route.indexOf("      const result = await withLlmRequestTimeout(conclusionTimeoutMs", start);
  assert.ok(start > 0 && end > start, "conclusion admission must immediately precede provider dispatch");
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const dispatch = new AsyncFunction(
    "sceneTimelineRecapText",
    "createChatsStorage",
    "app",
    "chatId",
    "parseMeta",
    "isSceneTimelineEnabled",
    "sceneTimelineDisabledResult",
    "send",
    `${route.slice(start, end)}\nreturn send();`,
  );
  for (const change of ["global", "chat", "deleted", "unchanged"] as const) {
    applyFeatureSettingsValue(JSON.stringify({ sceneTimeline: true }));
    let calls = 0;
    let status = 200;
    const reply = {
      status(value: number) {
        status = value;
        return this;
      },
      send(value: unknown) {
        return value;
      },
    };
    const storage = () => ({
      async getById() {
        await Promise.resolve();
        if (change === "global") applyFeatureSettingsValue(null);
        return change === "deleted" ? undefined : { metadata: { gameSceneTimelineEnabled: change !== "chat" } };
      },
    });
    const result = await dispatch(
      "optional scene recap",
      storage,
      {},
      "fixture",
      (value: unknown) => value,
      isSceneTimelineEnabled,
      disabled,
      () => calls++,
    );
    consume(result, disabled, reply);
    assert.equal(calls, change === "unchanged" ? 1 : 0, `late ${change} admission`);
    assert.equal(status, change === "unchanged" ? 200 : 403);
  }
  applyFeatureSettingsValue(null);
  let baselineCalls = 0;
  await dispatch(
    "",
    () => {
      throw new Error("No optional recap needs admission");
    },
    {},
    "fixture",
    undefined,
    isSceneTimelineEnabled,
    disabled,
    () => baselineCalls++,
  );
  assert.equal(baselineCalls, 1, "fresh OFF preserves the ordinary conclusion dispatch");
} finally {
  applyFeatureSettingsValue(JSON.stringify(originalSettings));
}
