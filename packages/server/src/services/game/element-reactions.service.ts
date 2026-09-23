// ──────────────────────────────────────────────
// Service: Elemental Reaction System
//
// Implements element-based combat chains: the
// "default" preset defines elements, auras, and
// reaction rules.
// ──────────────────────────────────────────────

import type { StatusEffect } from "./combat.service.js";

// ── Core types ──

export interface ElementDefinition {
  id: string;
  name: string;
  emoji: string;
  color: string;
}

export interface ReactionRule {
  /** Element already applied (aura) */
  trigger: string;
  /** Incoming element */
  appliedWith: string;
  /** Resulting reaction name */
  reaction: string;
  /** Damage multiplier applied to the triggering hit */
  damageMultiplier: number;
  /** Status effects inflicted on the target */
  effects: StatusEffect[];
  /** Short description for narration */
  description: string;
}

export interface ElementPreset {
  name: string;
  elements: ElementDefinition[];
  reactions: ReactionRule[];
}

/** Element aura currently on a combatant */
export interface ElementAura {
  element: string;
  /** Gauge units remaining (consumed on reaction) */
  gauge: number;
  /** Who applied the aura */
  sourceId: string;
}

export interface ReactionResult {
  reaction: string;
  description: string;
  damageMultiplier: number;
  appliedEffects: StatusEffect[];
  consumedAura: boolean;
}

// ── Default preset (classic RPG elements) ──

const DEFAULT_ELEMENTS: ElementDefinition[] = [
  { id: "fire", name: "Fire", emoji: "🔥", color: "#ff4500" },
  { id: "ice", name: "Ice", emoji: "❄️", color: "#00bfff" },
  { id: "lightning", name: "Lightning", emoji: "⚡", color: "#ffd700" },
  { id: "poison", name: "Poison", emoji: "☠️", color: "#9400d3" },
  { id: "holy", name: "Holy", emoji: "✨", color: "#fffacd" },
  { id: "shadow", name: "Shadow", emoji: "🌑", color: "#4a0080" },
];

const DEFAULT_REACTIONS: ReactionRule[] = [
  {
    trigger: "fire",
    appliedWith: "ice",
    reaction: "Melt",
    damageMultiplier: 1.5,
    effects: [{ name: "Chilled", modifier: -2, stat: "speed", turnsLeft: 2 }],
    description: "Fire and ice clash — a massive melt eruption deals extra damage",
  },
  {
    trigger: "ice",
    appliedWith: "fire",
    reaction: "Shatter",
    damageMultiplier: 1.3,
    effects: [{ name: "Shattered", modifier: -3, stat: "defense", turnsLeft: 1 }],
    description: "Frozen target shatters under the heat, cracking their armor",
  },
  {
    trigger: "fire",
    appliedWith: "lightning",
    reaction: "Overload",
    damageMultiplier: 1.8,
    effects: [{ name: "Stunned", modifier: -5, stat: "speed", turnsLeft: 1 }],
    description: "Electrical charge ignites the flames — a thunderous overload explosion",
  },
  {
    trigger: "ice",
    appliedWith: "lightning",
    reaction: "Superconduct",
    damageMultiplier: 1.4,
    effects: [{ name: "Conductivity", modifier: -4, stat: "defense", turnsLeft: 2 }],
    description: "Superconducting blast strips away physical resistance",
  },
  {
    trigger: "poison",
    appliedWith: "fire",
    reaction: "Toxic Blaze",
    damageMultiplier: 1.6,
    effects: [{ name: "Burning Toxin", modifier: -5, stat: "hp", turnsLeft: 3 }],
    description: "Poisonous fumes ignite into a noxious inferno",
  },
  {
    trigger: "holy",
    appliedWith: "shadow",
    reaction: "Purification",
    damageMultiplier: 2.0,
    effects: [],
    description: "Light and darkness annihilate each other in a cataclysmic burst",
  },
  {
    trigger: "shadow",
    appliedWith: "holy",
    reaction: "Eclipse",
    damageMultiplier: 2.0,
    effects: [{ name: "Blinded", modifier: -3, stat: "attack", turnsLeft: 2 }],
    description: "Blinding eclipse — darkness engulfs the light, disorienting the target",
  },
  {
    trigger: "lightning",
    appliedWith: "poison",
    reaction: "Electrotoxin",
    damageMultiplier: 1.5,
    effects: [
      { name: "Paralytic Venom", modifier: -4, stat: "speed", turnsLeft: 2 },
      { name: "Corroding", modifier: -3, stat: "hp", turnsLeft: 2 },
    ],
    description: "Electric current accelerates the spread of toxins through the body",
  },
];

// ── Preset registry ──

const PRESETS: Record<string, ElementPreset> = {
  default: { name: "Classic RPG", elements: DEFAULT_ELEMENTS, reactions: DEFAULT_REACTIONS },
};

/** Get a preset by name. Defaults to "default". */
export function getElementPreset(name?: string | null): ElementPreset {
  return PRESETS[name ?? "default"] ?? PRESETS["default"]!;
}

// ── Reaction resolution ──

/**
 * Apply an element to a target that may already have an aura.
 * Returns the reaction (if any) and updated aura.
 */
export function resolveElementApplication(
  existingAura: ElementAura | null,
  incomingElement: string,
  sourceId: string,
  preset?: string,
): { reaction: ReactionResult | null; newAura: ElementAura | null } {
  const { reactions } = getElementPreset(preset);

  // No existing aura → apply as new aura
  if (!existingAura) {
    return {
      reaction: null,
      newAura: { element: incomingElement, gauge: 1, sourceId },
    };
  }

  // Same source re-applying same element → refresh gauge
  if (existingAura.element === incomingElement && existingAura.sourceId === sourceId) {
    return {
      reaction: null,
      newAura: { ...existingAura, gauge: Math.min(2, existingAura.gauge + 0.5) },
    };
  }

  // Look for a reaction
  const rule = reactions.find((r) => r.trigger === existingAura.element && r.appliedWith === incomingElement);

  if (rule) {
    // Reaction found — consume aura
    const newGauge = existingAura.gauge - 1;
    return {
      reaction: {
        reaction: rule.reaction,
        description: rule.description,
        damageMultiplier: rule.damageMultiplier,
        appliedEffects: rule.effects.map((e) => ({ ...e })),
        consumedAura: newGauge <= 0,
      },
      newAura: newGauge > 0 ? { ...existingAura, gauge: newGauge } : null,
    };
  }

  // No reaction — overwrite aura with new element
  return {
    reaction: null,
    newAura: { element: incomingElement, gauge: 1, sourceId },
  };
}

/**
 * Compute bonus damage from an elemental reaction.
 * Takes the base finalDamage and applies the reaction multiplier.
 */
export function applyReactionDamage(baseDamage: number, reaction: ReactionResult): number {
  return Math.floor(baseDamage * reaction.damageMultiplier);
}
