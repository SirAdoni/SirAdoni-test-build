// ──────────────────────────────────────────────
// Game: NPC Reputation Math Service
//
// Deterministic reputation adjustments from tagged
// player actions. No LLM needed for the math.
// ──────────────────────────────────────────────

import type { GameNpc } from "@marinara-engine/shared";

/** Action tags and their default reputation modifiers. */
export const REPUTATION_ACTION_MODIFIERS: Record<string, number> = {
  // Positive
  helped: 15,
  rescued: 25,
  gifted: 10,
  complimented: 5,
  defended: 20,
  traded_fair: 8,
  healed: 12,
  freed: 20,
  allied: 30,

  // Negative
  threatened: -20,
  attacked: -30,
  robbed: -25,
  insulted: -10,
  lied: -15,
  betrayed: -40,
  ignored: -5,
  deceived: -15,
  killed_ally: -50,

  // Neutral/Contextual
  questioned: 0,
  met: 3,
  traded: 5,
  intimidated: -10,
  persuaded: 2,
  bribed: -3,
};

export const REPUTATION_ACTIONS = Object.keys(REPUTATION_ACTION_MODIFIERS);

export function isSupportedReputationAction(action: string, modifier?: number): boolean {
  return (
    Object.hasOwn(REPUTATION_ACTION_MODIFIERS, action.trim().toLowerCase()) ||
    (modifier !== undefined && Number.isFinite(modifier) && modifier >= -100 && modifier <= 100)
  );
}

export type ReputationTier = "devoted" | "allied" | "friendly" | "neutral" | "unfriendly" | "hostile" | "enemy";

/** Map reputation number to a named tier. */
export function getReputationTier(reputation: number): ReputationTier {
  if (reputation >= 80) return "devoted";
  if (reputation >= 50) return "allied";
  if (reputation >= 20) return "friendly";
  if (reputation >= -20) return "neutral";
  if (reputation >= -50) return "unfriendly";
  if (reputation >= -80) return "hostile";
  return "enemy";
}

// ── Relationship milestones ──

export interface RelationshipMilestone {
  npcName: string;
  previousTier: ReputationTier;
  newTier: ReputationTier;
  direction: "improved" | "worsened";
  /** Flavour text for the milestone event. */
  description: string;
}

const MILESTONE_DESCRIPTIONS: Record<ReputationTier, { up: string; down: string }> = {
  devoted: {
    up: "has pledged unwavering loyalty to the party",
    down: "no longer holds unconditional devotion",
  },
  allied: {
    up: "considers the party trusted allies",
    down: "is reconsidering the alliance",
  },
  friendly: {
    up: "has warmed up and views the party favorably",
    down: "is growing distant from the party",
  },
  neutral: {
    up: "has cooled down and returned to a neutral stance",
    down: "has become indifferent towards the party",
  },
  unfriendly: {
    up: "is slightly less hostile but still wary",
    down: "is clearly displeased with the party",
  },
  hostile: {
    up: "is somewhat less hostile, though still dangerous",
    down: "now views the party with open hostility",
  },
  enemy: {
    up: "is still hostile but no longer sworn to destroy the party",
    down: "has declared themselves an enemy of the party",
  },
};

/** Check if a reputation change crosses a tier boundary and return the milestone. */
function detectMilestone(npcName: string, oldReputation: number, newReputation: number): RelationshipMilestone | null {
  const oldTier = getReputationTier(oldReputation);
  const newTier = getReputationTier(newReputation);
  if (oldTier === newTier) return null;

  const direction = newReputation > oldReputation ? "improved" : "worsened";
  const desc = MILESTONE_DESCRIPTIONS[newTier];
  return {
    npcName,
    previousTier: oldTier,
    newTier,
    direction,
    description: `${npcName} ${direction === "improved" ? desc.up : desc.down}`,
  };
}

/** Apply a reputation change to an NPC. Returns the updated NPC. */
export function applyReputationChange(
  npc: GameNpc,
  action: string,
  customModifier?: number,
): { npc: GameNpc; change: number; newTier: ReputationTier; milestone: RelationshipMilestone | null } {
  const normalizedAction = action.trim().toLowerCase();
  if (!isSupportedReputationAction(normalizedAction, customModifier)) {
    throw new Error(`Unsupported reputation action: ${action}`);
  }
  const modifier = customModifier ?? REPUTATION_ACTION_MODIFIERS[normalizedAction]!;
  const oldReputation = Number.isFinite(npc.reputation) ? npc.reputation : 0;
  const newReputation = Math.max(-100, Math.min(100, oldReputation + modifier));
  const newTier = getReputationTier(newReputation);
  const milestone = detectMilestone(npc.name, oldReputation, newReputation);

  const updated: GameNpc = {
    ...npc,
    reputation: newReputation,
    reputationObserved: true,
    notes: [
      ...(npc.notes ?? []),
      `[${normalizedAction}] reputation ${modifier >= 0 ? "+" : ""}${modifier} → ${newReputation} (${newTier})`,
      ...(milestone ? [`🏛️ Milestone: ${milestone.description}`] : []),
    ],
  };

  return { npc: updated, change: modifier, newTier, milestone };
}

/** Batch-apply reputation changes to multiple NPCs from an actions list. */
export function processReputationActions(
  npcs: GameNpc[],
  actions: Array<{ npcId: string; action: string; modifier?: number }>,
): {
  npcs: GameNpc[];
  changes: Array<{ npcId: string; npcName: string; action: string; change: number; newTier: ReputationTier }>;
  milestones: RelationshipMilestone[];
} {
  const npcMap = new Map(npcs.map((n) => [n.id, { ...n }]));
  const changes: Array<{ npcId: string; npcName: string; action: string; change: number; newTier: ReputationTier }> =
    [];
  const milestones: RelationshipMilestone[] = [];

  for (const { npcId, action, modifier } of actions) {
    if (!isSupportedReputationAction(action, modifier)) continue;
    // Support both ID-based and name-based lookup
    let npc = npcMap.get(npcId);
    if (!npc) {
      // Names are accepted only when unique; two people sharing a name must not share a score.
      const matches = [...npcMap.values()].filter((n) => n.name.trim().toLowerCase() === npcId.trim().toLowerCase());
      if (matches.length === 1) npc = matches[0];
    }
    if (!npc) continue;

    const result = applyReputationChange(npc, action, modifier);
    npcMap.set(npc.id, result.npc);
    changes.push({
      npcId: npc.id,
      npcName: npc.name,
      action,
      change: result.change,
      newTier: result.newTier,
    });
    if (result.milestone) {
      milestones.push(result.milestone);
    }
  }

  return {
    npcs: Array.from(npcMap.values()),
    changes,
    milestones,
  };
}

/** Get a summary of NPC relationships for prompt injection. */
export function buildNpcRelationshipSummary(npcs: GameNpc[]): string {
  if (npcs.length === 0) return "";

  const lines = npcs.map((n) => {
    const tier = getReputationTier(n.reputation);
    return `- ${n.emoji} ${n.name}: ${tier} (${n.reputation}/100)`;
  });

  return lines.join("\n");
}
