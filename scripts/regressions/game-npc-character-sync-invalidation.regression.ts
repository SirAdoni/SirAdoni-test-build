import assert from "node:assert/strict";
import { gameNpcCharacterSyncInvalidation } from "../../packages/client/src/lib/game-npc-character-sync-policy.ts";

const roster = [{ id: "npc-1", characterId: "char-1", name: "Mara" }];

assert.deepEqual(
  gameNpcCharacterSyncInvalidation(JSON.stringify({ gameNpcs: roster }), {
    gameNpcs: roster,
    links: [{ npcId: "npc-1", characterId: "char-1" }],
  }),
  { refreshChat: false, refreshCharacters: false },
  "links-only idempotent sync must not invalidate either cache",
);

assert.deepEqual(
  gameNpcCharacterSyncInvalidation(
    { gameNpcs: roster },
    {
      gameNpcs: [...roster, { id: "npc-2", characterId: "char-2", name: "Ivo" }],
      links: [{ npcId: "npc-2", characterId: "char-2" }],
    },
  ),
  { refreshChat: true, refreshCharacters: false },
  "a changed roster must refresh chat metadata",
);

assert.deepEqual(
  gameNpcCharacterSyncInvalidation(
    { gameNpcs: roster },
    {
      gameNpcs: roster,
      links: [{ npcId: "npc-1", characterId: "char-1" }],
      updated: [{ npcId: "npc-1", characterId: "char-1" }],
    },
  ),
  { refreshChat: false, refreshCharacters: true },
  "a card update must refresh character queries",
);

assert.deepEqual(
  gameNpcCharacterSyncInvalidation(undefined, { gameNpcs: roster, links: [] }),
  { refreshChat: true, refreshCharacters: false },
  "a missing cached chat must conservatively refresh metadata",
);

assert.deepEqual(
  gameNpcCharacterSyncInvalidation(
    { gameNpcs: roster },
    {
      gameNpcs: roster,
      retracted: [{ npcId: "removed-npc", characterId: "removed-card" }],
    },
  ),
  { refreshChat: true, refreshCharacters: true },
  "retraction must refresh journal metadata even when the roster was already pruned",
);

assert.deepEqual(
  gameNpcCharacterSyncInvalidation(
    { gameNpcs: [{ name: "Mara", characterId: "char-1", id: "npc-1" }] },
    {
      gameNpcs: roster,
    },
  ),
  { refreshChat: false, refreshCharacters: false },
  "JSON object key ordering must not cause a refresh",
);

console.info("Game NPC character sync invalidation regression passed.");
