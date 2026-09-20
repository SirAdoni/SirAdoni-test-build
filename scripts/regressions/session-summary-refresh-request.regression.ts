import assert from "node:assert/strict";
import { buildSessionSummaryRefreshProviderMessages } from "../../packages/server/src/routes/game.routes.js";
import type { SessionSummary } from "@marinara-engine/shared";

const savedSummary: SessionSummary = {
  sessionNumber: 3,
  summary: "Résumé en français: la joueuse a choisi la porte nord.",
  resumePoint: "La porte reste fermée.",
  partyDynamics: "Le groupe attend.",
  partyState: "Tous sont présents.",
  keyDiscoveries: ["Une inscription a été lue."],
  characterMoments: ["Mira a proposé une hypothèse."],
  littleDetails: ["Le joueur a demandé une carte."],
  statsSnapshot: { party: { morale: 55 } },
  npcUpdates: ["Mira est prudente."],
  timestamp: "2026-09-13T10:00:00.000Z",
};
const transcript = "[user] Je choisis la porte nord.\n\n[assistant] Mira accepte et attend.";
const messages = buildSessionSummaryRefreshProviderMessages({
  sessionNumber: 3,
  savedSummary,
  transcript,
  continuityEvidence: "Reviewed: Mira accepted the choice [m1: Mira accepte et attend.]",
});
const finalInput = messages.map((message) => message.content ?? "").join("\n\n");

assert.match(finalInput, /Résumé en français/);
assert.match(finalInput, /Je choisis la porte nord/);
assert.match(finalInput, /Mira accepte et attend/);
assert.match(finalInput, /original language|original language/i);
assert.match(finalInput, /player agency/i);
assert.match(finalInput, /offered, accepted, agreed, refused, or decided/i);
assert.doesNotMatch(finalInput, /current metadata|character cards|journal/i);
assert.doesNotMatch(finalInput, /gameCharacterCards|gameJournal|gameWorldState/i);

process.stdout.write("Session summary refresh request regression passed.\n");
