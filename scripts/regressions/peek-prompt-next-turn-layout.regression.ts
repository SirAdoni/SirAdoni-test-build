import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The peek-prompt live preview has no pending player message, so it used to show app runtime blocks (the World
// Maps spatial context) straight after the system prompt, while a real game turn on a non-subscription provider
// moves them to the current turn. The preview now applies the same layout as a real turn.
const { layoutAsNextTurn } = await import("../../packages/server/src/services/generation/prompt-cache-layout.js");

type Message = {
  role: "system" | "user" | "assistant";
  content: string;
  contextKind?: "prompt" | "history" | "injection";
  providerMetadata?: Record<string, unknown>;
};
const system: Message = { role: "system", content: "GM system prompt" };
const spatial: Message = {
  role: "system",
  content: '<spatial_context mode="game" authority="application">Current path: Tide Hall</spatial_context>',
  contextKind: "injection",
  providerMetadata: { marinaraRuntimeContext: true },
};
const olderUser: Message = { role: "user", content: "I open the door.", contextKind: "history" };
const lastAssistant: Message = { role: "assistant", content: "Corvina waves you in.", contextKind: "history" };
const preview = [system, spatial, olderUser, lastAssistant];

const game = layoutAsNextTurn(preview, { chatMode: "game", provider: "nanogpt" });
assert.deepEqual(
  game.map((message) => message.content),
  // A real turn keeps the last reply adjacent to the player's message, so runtime context sits just before
  // that reply (live dry run of a regenerate: spatial at 158, reply at 159, player turn at 160).
  [system.content, olderUser.content, spatial.content, lastAssistant.content],
  "game preview on a non-subscription provider carries runtime context at the current turn, like a real turn",
);
assert.equal(game.length, preview.length, "the placeholder turn is removed again");

const roleplay = layoutAsNextTurn(preview, { chatMode: "roleplay", provider: "nanogpt" });
assert.deepEqual(roleplay, preview, "other modes keep the assembler order on non-subscription providers");

const unchanged = layoutAsNextTurn([system, olderUser, lastAssistant], { chatMode: "game", provider: "openai" });
assert.deepEqual(
  unchanged.map((message) => message.content),
  [system.content, olderUser.content, lastAssistant.content],
  "no runtime context: nothing moves",
);

const route = readFileSync(new URL("../../packages/server/src/routes/chats.routes.ts", import.meta.url), "utf8");
assert.match(
  route,
  /layoutAsNextTurn\(injectOwnerSpatialPrompt\(assembled\.messages, ownerSpatialProjection\), \{\s*chatMode,\s*provider: connection\?\.provider,/u,
  "peek-prompt live preview applies the real-turn layout",
);
assert.match(route, /source: "live_preview",\s*layout: "next-turn",/u, "the preview is labelled with its layout");

console.log("peek-prompt next-turn layout regression passed");
