import assert from "node:assert/strict";
import type { Message } from "../../packages/shared/src/types/chat.js";
import {
  buildGameSessionReplayTurns,
  visibleReplayMessages,
} from "../../packages/client/src/lib/game-session-replay.js";

// Session Replay shows only what the player could see: hidden and command-only turns never become
// replay turns, player lines or recorded choices, whether extra arrives as an object or a JSON string.
const messages = [
  { id: "open", chatId: "session-a", role: "assistant", content: "The gate of Test Keep opens." },
  { id: "hidden-cue", chatId: "session-a", role: "user", content: "SECRET GM NUDGE", extra: { hiddenFromUser: true } },
  {
    id: "hidden-turn",
    chatId: "session-a",
    role: "assistant",
    content: "HIDDEN NARRATION",
    extra: JSON.stringify({ hiddenFromUser: true }),
  },
  { id: "anchor", chatId: "session-a", role: "user", content: "COMMAND ANCHOR", extra: { commandOnly: true } },
  { id: "player", chatId: "session-a", role: "user", content: "I walk in." },
  { id: "reply", chatId: "session-a", role: "assistant", content: "Torches flicker along the hall." },
  {
    id: "ai-hidden",
    chatId: "session-a",
    role: "assistant",
    content: "Still readable.",
    extra: { hiddenFromAI: true },
  },
] as Message[];

assert.deepEqual(
  visibleReplayMessages(messages).map((message) => message.id),
  ["open", "player", "reply", "ai-hidden"],
  "hidden and command-only turns are filtered; AI-hidden turns stay readable",
);

const turns = buildGameSessionReplayTurns(messages);
assert.deepEqual(
  turns.map((turn) => turn.message.id),
  ["open", "reply", "ai-hidden"],
);
assert.equal(turns[1]!.playerMessage?.id, "player", "the player line comes from the last visible user turn");
const replayText = JSON.stringify(turns);
for (const hidden of ["SECRET GM NUDGE", "HIDDEN NARRATION", "COMMAND ANCHOR"]) {
  assert.ok(!replayText.includes(hidden), `replay leaves out ${hidden}`);
}

// A hidden user turn right after a narration is not treated as the recorded response.
const withHiddenAnswer = [
  {
    id: "ask",
    chatId: "session-b",
    role: "assistant",
    content: "Which door?",
    extra: { cyoaChoices: [{ label: "Left", text: "Take the left door" }] },
  },
  { id: "secret", chatId: "session-b", role: "user", content: "Take the left door", extra: { hiddenFromUser: true } },
  { id: "next", chatId: "session-b", role: "assistant", content: "Silence." },
] as Message[];
const [askTurn] = buildGameSessionReplayTurns(withHiddenAnswer);
assert.equal(askTurn!.recordedChoice, null, "a hidden user turn does not select a recorded choice");

process.stdout.write("game-session-replay-hidden regression passed\n");
