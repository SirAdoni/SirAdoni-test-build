import assert from "node:assert/strict";
import type { GameTurnStoryboard, GameTurnStoryboardKeyframe } from "../../packages/shared/src/types/game";
import {
  isGameTurnStoryboardPreparationFailure,
  isGameTurnStoryboardRendering,
} from "../../packages/client/src/hooks/use-game-storyboards";

const frame = (status: GameTurnStoryboardKeyframe["status"]): GameTurnStoryboardKeyframe => ({
  id: status,
  storyboardId: "story",
  index: 0,
  title: "",
  sectionStartIndex: null,
  sectionEndIndex: null,
  anchorQuote: "",
  anchorKind: "",
  narrationBeat: "",
  mangaPanelPrompt: "",
  imagePrompt: "",
  videoPrompt: "",
  animationSuitability: "",
  characters: [],
  continuityNotes: "",
  cameraMotion: "",
  transitionHint: "",
  durationSeconds: 0,
  aspectRatio: "16:9",
  chatImageId: null,
  sceneVideoId: null,
  image: null,
  video: null,
  status,
  error: null,
  createdAt: "",
  updatedAt: "",
});

const storyboard = (overrides: Partial<GameTurnStoryboard> = {}): GameTurnStoryboard => ({
  id: "story",
  chatId: "chat",
  messageId: "message",
  swipeIndex: 0,
  snapshotId: null,
  sessionNumber: null,
  turnNumber: null,
  title: "",
  sourceNarration: "",
  sourceNarrationHash: "",
  status: "rendering_images",
  provider: "fixture",
  model: "fixture",
  directorPrompt: "",
  error: null,
  keyframes: [],
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

assert.equal(isGameTurnStoryboardRendering(storyboard({ error: "planner failed" })), false);
assert.equal(
  isGameTurnStoryboardRendering(
    storyboard({ error: "one frame failed", keyframes: [frame("failed"), frame("rendering_image")] }),
  ),
  true,
);
assert.equal(isGameTurnStoryboardRendering(storyboard({ status: "failed", keyframes: [frame("planned")] })), false);
assert.equal(isGameTurnStoryboardPreparationFailure(storyboard({ status: "failed" })), true);
assert.equal(isGameTurnStoryboardPreparationFailure(storyboard({ status: "failed", keyframes: [frame("failed")] })), false);
console.info("game-storyboard-status regression passed");
