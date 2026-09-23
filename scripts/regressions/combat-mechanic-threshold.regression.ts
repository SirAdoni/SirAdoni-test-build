import assert from "node:assert/strict";
import { resolveCombatRound, type CombatantStats } from "../../packages/server/src/services/game/combat.service.js";
import {
  createCombatDirector,
  commandCombatDirector,
} from "../../packages/server/src/services/game/combat-director.service.js";
import type { Combatant, CombatMechanic } from "../../packages/shared/src/types/game.js";

// hp_threshold mechanics fire once, on the round the owner crosses the threshold, not every round after.
const mechanic = (): CombatMechanic => ({
  name: "Enrage",
  description: "Lashes out when wounded",
  ownerName: "boss",
  trigger: "hp_threshold",
  hpThreshold: 50,
  effectType: "damage_all",
  power: 0.05,
});

type Fighter = CombatantStats & { side?: "player" | "enemy" };
const fighter = (id: string, side: "player" | "enemy", hp: number): Fighter => ({
  id,
  name: id,
  side,
  hp,
  maxHp: 100,
  mp: 0,
  maxMp: 0,
  attack: 1,
  defense: 1000,
  speed: 10,
  level: 1,
  skills: [],
  statusEffects: [],
});
const enrages = (actions: { skillName?: string }[]) => actions.filter((a) => a.skillName === "Enrage").length;

// Classic: the boss starts below the threshold, so nothing crosses and nothing fires.
{
  const party = [fighter("hero", "player", 100), fighter("boss", "enemy", 40)];
  const result = resolveCombatRound(party, 3, "normal", undefined, { type: "defend" }, [mechanic()]);
  assert.equal(enrages(result.actions), 0, "A boss already below its threshold does not re-fire every round");
}

// Classic: a damage-over-time tick carries the boss across the threshold, so it fires that round.
{
  const boss = fighter("boss", "enemy", 55);
  boss.statusEffects = [{ name: "Burn", modifier: -10, stat: "hp", turnsLeft: 2 }];
  const party = [fighter("hero", "player", 100), boss];
  const result = resolveCombatRound(party, 1, "normal", undefined, { type: "defend" }, [mechanic()]);
  assert.ok(boss.hp <= 50, "Burn tick should drop the boss to the threshold");
  assert.equal(enrages(result.actions), 1, "Crossing the threshold fires the mechanic once");
}

// Directed: the mechanic fires on the first round end below the threshold, then never again.
{
  const unit = (id: string, side: Combatant["side"], hp: number): Combatant => ({
    id,
    name: id,
    side,
    hp,
    maxHp: 100,
    mp: 0,
    maxMp: 0,
    attack: 1,
    defense: 1000,
    speed: 10,
    level: 1,
    skills: [],
  });
  const s = createCombatDirector({
    id: "threshold",
    anchor: "a",
    party: [{ ...unit("hero", "player", 100), speed: 10000 }],
    enemies: [unit("boss", "enemy", 40)],
    style: "classic",
    gm: false,
    difficulty: "normal",
    seed: 1,
    mechanics: [mechanic()],
  });
  const fired = () => s.log.filter((e) => e.kind === "mechanic" && e.text.includes("Enrage")).length;
  commandCombatDirector(s, { type: "classic", action: { type: "defend" } });
  assert.equal(s.round, 2);
  assert.ok(fired() >= 1, "Directed fights fire the threshold mechanic once the boss is below it");
  const afterFirst = fired();
  commandCombatDirector(s, { type: "classic", action: { type: "defend" } });
  assert.equal(s.round, 3);
  assert.equal(fired(), afterFirst, "Directed fights do not re-fire a threshold mechanic");
  // The mark must survive the JSON round-trip the director state takes through the database.
  const reloaded = JSON.parse(JSON.stringify(s.mechanics)) as Array<{ thresholdFiredRound?: number }>;
  assert.equal(reloaded[0]?.thresholdFiredRound, 1);
}

console.log("Combat mechanics: hp_threshold fires once on crossing in classic and directed fights.");
