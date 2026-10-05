import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-scene-timeline-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";

const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { withMessageExtraPatchQueue } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { applyFeatureSettingsValue, getFeatureSettings } =
  await import("../../packages/server/src/services/features/feature-settings.js");
const { isSceneTimelineEnabled } = await import("../../packages/server/src/services/game/game-feature-switches.js");
const { appendSceneVisits, sceneTurnHash } =
  await import("../../packages/server/src/services/game/scene-timeline-model.js");
const { readSource } = await import("../../packages/server/src/services/game/scene-timeline.service.js");

const db = await getDB();
const originalFeatureSettings = getFeatureSettings();
try {
  applyFeatureSettingsValue(JSON.stringify({ sceneTimeline: true }));
  const connection = await createConnectionsStorage(db).create({
    name: "Synthetic scene test",
    provider: "custom",
    model: "fixture",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "synthetic",
  });
  const chats = createChatsStorage(db);
  const chat = await chats.create({
    name: "Synthetic scene timeline",
    mode: "game",
    characterIds: [],
    connectionId: connection.id,
    promptPresetId: null,
  });
  const playerTurn = await chats.createMessage({
    chatId: chat.id,
    role: "user",
    content: "We enter the western archive.",
  });
  const gmTurn = await chats.createMessage({
    chatId: chat.id,
    role: "assistant",
    content: "The western archive door is sealed. We cross into the eastern gallery. A bell rings.",
  });
  const visits = [
    {
      location: "Western Archive",
      present: ["Player One"],
      participants: ["Player One"],
      departures: [],
      facts: [{ text: "The archive door is sealed.", quote: "The western archive door is sealed." }],
    },
    {
      location: "Eastern Gallery",
      present: ["Player One", "Guide One"],
      participants: ["Player One", "Guide One"],
      departures: [],
      facts: [{ text: "A bell rings.", quote: "A bell rings." }],
    },
  ];
  const source = await readSource(db, chat.id);
  const turn = source.turns.find((entry) => entry.message.id === gmTurn.id);
  assert.ok(turn, "the synthetic assistant turn is the timeline source");
  const scenes: Array<{
    id: string;
    location: string;
    participants: string[];
    present: string[];
    summary: string;
    closed: boolean;
    reviewed: boolean;
    messageIds: string[];
  }> = [];
  appendSceneVisits(scenes, gmTurn.id, visits);
  assert.equal(scenes[0]?.closed, true, "a location change closes the prior scene");
  const firstScene = scenes[0]!;
  const reviewHash = sceneTurnHash(`scene-review-v2:${turn.hash}`, firstScene.summary);
  assert.ok(playerTurn.id, "the preceding player turn anchors the GM source");

  await chats.updateMessageExtraForSwipe(gmTurn.id, 0, {
    gameSceneTimeline: { visits, hash: turn.hash },
    gameSceneReviews: {
      [firstScene.id]: {
        hash: reviewHash,
        summary: "Verified from the transcript: the archive door is sealed.",
        corrections: [],
        reviewedAt: "2026-10-01T00:00:00.000Z",
      },
    },
  });

  const beforeRestart = await (
    await import("../../packages/server/src/services/game/scene-timeline.service.js")
  ).readSceneTimeline(db, chat.id);
  assert.deepEqual(
    beforeRestart.scenes.map((scene) => [scene.location, scene.closed, scene.reviewed]),
    [
      ["Western Archive", true, true],
      ["Eastern Gallery", false, false],
    ],
    "ordered visits and the reviewed closure persist from message extras",
  );

  applyFeatureSettingsValue(JSON.stringify({ sceneTimeline: false }));
  const disabledRead = await (
    await import("../../packages/server/src/services/game/scene-timeline.service.js")
  ).readSceneTimeline(db, chat.id);
  assert.equal(disabledRead.scenes.length, 2, "turning the app switch OFF retains saved timeline history");

  const restarted =
    await import("../../packages/server/src/services/game/scene-timeline.service.js?scene-restart-regression");
  assert.equal(await restarted.sceneTimelineRecap(db, chat.id), "", "OFF mode does not add a timeline recap");
  applyFeatureSettingsValue(JSON.stringify({ sceneTimeline: true }));
  const recap = await restarted.sceneTimelineRecap(db, chat.id);
  assert.match(recap, /Western Archive/);
  assert.match(recap, /Verified from the transcript: the archive door is sealed\./);
  assert.doesNotMatch(recap, /A bell rings/, "the open next scene is not included in the reviewed recap");

  const readAdmission = (raw: unknown) => {
    let metadata = raw;
    if (typeof metadata === "string") {
      try {
        metadata = JSON.parse(metadata);
      } catch {
        metadata = {};
      }
    }
    return isSceneTimelineEnabled(metadata as Record<string, unknown>);
  };
  const assertQueuedWriteDenied = async (disable: () => Promise<void> | void, label: string) => {
    const beforeMessage = await chats.getMessage(gmTurn.id);
    const beforeSwipe = (await chats.getSwipes(gmTurn.id)).find((swipe) => swipe.index === 0);
    let release!: () => void;
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => (announceStarted = resolve));
    const blocker = withMessageExtraPatchQueue(gmTurn.id, async () => {
      announceStarted();
      await new Promise<void>((resolve) => (release = resolve));
    });
    await started;
    const pendingWrite = chats.updateMessageExtraForSwipe(
      gmTurn.id,
      0,
      { sceneTimelineAdmissionProbe: label },
      undefined,
      readAdmission,
    );
    await disable();
    release();
    await blocker;
    assert.equal(await pendingWrite, null, `${label}: a disabled queued timeline write is refused`);
    assert.deepEqual(
      (await chats.getMessage(gmTurn.id))?.extra,
      beforeMessage?.extra,
      `${label}: message mirror is unchanged`,
    );
    assert.deepEqual(
      (await chats.getSwipes(gmTurn.id)).find((swipe) => swipe.index === 0)?.extra,
      beforeSwipe?.extra,
      `${label}: source swipe is unchanged`,
    );
  };
  await assertQueuedWriteDenied(() => applyFeatureSettingsValue(JSON.stringify({ sceneTimeline: false })), "app OFF");
  await assertQueuedWriteDenied(async () => {
    applyFeatureSettingsValue(JSON.stringify({ sceneTimeline: true }));
    const currentChat = await chats.getById(chat.id);
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(String(currentChat?.metadata ?? "{}"));
    } catch {
      metadata = {};
    }
    await chats.updateMetadata(chat.id, { ...metadata, gameSceneTimelineEnabled: false });
  }, "per-chat OFF");
  const currentChat = await chats.getById(chat.id);
  let currentMetadata: Record<string, unknown> = {};
  try {
    currentMetadata = JSON.parse(String(currentChat?.metadata ?? "{}"));
  } catch {
    currentMetadata = {};
  }
  delete currentMetadata.gameSceneTimelineEnabled;
  await chats.updateMetadata(chat.id, currentMetadata);
  applyFeatureSettingsValue(JSON.stringify({ sceneTimeline: true }));

  const changed = await chats.updateMessageContent(
    gmTurn.id,
    "The replacement swipe moves directly to the eastern gallery.",
  );
  assert.ok(changed);
  const afterSwipe = await restarted.readSceneTimeline(db, chat.id);
  assert.equal(afterSwipe.remaining, 1, "a replacement swipe invalidates the prior source hash for re-extraction");
} finally {
  applyFeatureSettingsValue(JSON.stringify(originalFeatureSettings));
  await closeDB();
  rmSync(dataDir, { recursive: true, force: true });
}
