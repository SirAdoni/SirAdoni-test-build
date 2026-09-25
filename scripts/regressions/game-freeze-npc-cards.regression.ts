import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Settings > Features "Session-frozen NPC cards" (gameFreezeNpcCardsPerSession).
// In a long Game session the cached prompt fell from about 93% to 25-28% every few turns with nothing edited by hand:
// the NPC biographer reworded a named character's card (no fact changed), the card rode in the uncached update
// section, and once six cards or 30,000 characters were waiting the whole list was folded into the cached reference
// blocks ahead of the history, re-sending about 105,000 tokens. With the switch on:
// - cached cards stay frozen for the session; a change rides uncached as its changed lines only;
// - they fold at the next session, or once the carried changes cost more than re-sending everything after the cards;
// - a rewording that changes no facts is neither saved nor sent.
// With the switch off the planner and the prompt text are byte-identical to before.
const root = mkdtempSync(join(tmpdir(), "marinara-freeze-npc-cards-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = `${process.env.DATA_DIR}/storage`; // never the live store named in .env

try {
  const { planNamedCardLayout, buildNamedCardDelta, NAMED_CARD_FREEZE_MIN_FOLD_CHARS } =
    await import("../../packages/server/src/services/game/named-card-cache.js");
  const { isSubstantivelySameText } = await import("../../packages/server/src/services/game/card-text-similarity.js");
  const { buildGmSystemPromptParts } = await import("../../packages/server/src/services/game/gm-prompts.js");

  // ── Rewording detection ──
  const base =
    "Tarn Velio is a quiet courier from Oskel Reach. She is 34, keeps a scarred left hand hidden, and owes the Harbor Guild two favors.";
  assert.ok(isSubstantivelySameText(base, base.replace("quiet courier", "courier, quiet,")));
  assert.ok(
    isSubstantivelySameText(
      base,
      "Tarn Velio is a quiet courier from Oskel Reach. She is 34, keeps her scarred left hand hidden, and owes the Harbor Guild two favors.",
    ),
    "a one-word rewording is not a change",
  );
  assert.ok(!isSubstantivelySameText(base, base.replace("34", "43")), "a changed number is a change");
  assert.ok(!isSubstantivelySameText(base, base.replace("Harbor Guild", "Salt Guild")), "a changed name is a change");
  assert.ok(!isSubstantivelySameText(base, base.replace("keeps a", "never keeps a")), "a negation is a change");
  assert.ok(
    !isSubstantivelySameText(base, `${base} She secretly reports to the magistrate.`),
    "an added sentence is a change",
  );

  // ── Deltas carry changed lines only ──
  const paragraph = Array.from({ length: 30 }, (_, i) => `Detail number ${i} about the courier and her routes.`).join(
    " ",
  );
  const cached = `Name: Tarn Velio\nDescription: ${paragraph}\nPersonality: guarded`;
  const changed = cached.replace("Detail number 7 about", "Detail number 7, newly learned, about");
  const delta = buildNamedCardDelta("Tarn Velio", cached, changed)!;
  assert.ok(delta, "a small edit becomes a delta");
  assert.ok(delta.length < 400, `delta stays small (${delta.length})`);
  assert.match(delta, /newly learned/u);
  assert.ok(!delta.includes("Detail number 12"), "unchanged sentences are not repeated");

  // ── Frozen planner ──
  const card = (id: string, text = `${id} original`) => ({ id, name: id, card: `Name: ${id}\n${text}` });
  const freeze = (turnKey: number, suffixChars = 400_000, sessionKey = "2") => ({ sessionKey, turnKey, suffixChars });
  const filler = Array.from({ length: 20 }, (_, i) => `tarn record line ${i}`).join("\n");
  const first = planNamedCardLayout(null, [card("tarn", filler), card("brisa"), card("odo")], { freeze: freeze(1) });
  const baseline = first.stable.map((entry) => entry.card).join("|");
  let snapshot = first.snapshot;
  // Eight turns, each adding a new person and changing a card: today's planner would have folded at six.
  for (let turn = 2; turn <= 9; turn += 1) {
    const current = [
      card("tarn", `${filler}\nlearned fact ${turn}`),
      card("brisa"),
      card("odo"),
      ...Array.from({ length: turn - 1 }, (_, i) => card(`new${i}`)),
    ];
    const plan = planNamedCardLayout(snapshot, current, { freeze: freeze(turn) });
    assert.equal(plan.folded, false, `turn ${turn} keeps the cards frozen`);
    assert.equal(plan.stable.map((entry) => entry.card).join("|"), baseline);
    const tarn = plan.updates.find((entry) => entry.id === "tarn")!;
    assert.equal(tarn.delta, true, "a changed cached card rides as a delta");
    snapshot = plan.snapshot;
  }
  // The same turn planned twice (a preview or retry) does not count twice.
  const again = planNamedCardLayout(snapshot, [card("tarn", `${filler}\nlearned fact 9`)], { freeze: freeze(9) });
  assert.equal(again.changed, false);
  // A rewording of a cached card sends nothing.
  const reworded = planNamedCardLayout(first.snapshot, [card("tarn", filler.replace("line 3", "line, 3"))], {
    freeze: freeze(2),
  });
  assert.equal(reworded.updates.length, 0);
  // Folding once the carried changes cost more than re-sending the history after the cards.
  const costly = planNamedCardLayout(first.snapshot, [card("tarn", "y".repeat(NAMED_CARD_FREEZE_MIN_FOLD_CHARS))], {
    freeze: freeze(2, 10_000),
  });
  assert.equal(costly.folded, true);
  const cheap = planNamedCardLayout(first.snapshot, [card("tarn", "y".repeat(NAMED_CARD_FREEZE_MIN_FOLD_CHARS))], {
    freeze: freeze(2, 500_000),
  });
  assert.equal(cheap.folded, false, "a long history raises the fold threshold");
  // A new session folds everything once.
  const nextSession = planNamedCardLayout(snapshot, [card("tarn", `${filler}\nlearned fact 9`), card("new0")], {
    freeze: freeze(1, 0, "3"),
  });
  assert.equal(nextSession.folded, true);
  assert.equal(nextSession.updates.length, 0);
  assert.match(nextSession.stable[0]!.card, /learned fact 9/u);

  // ── Switch off: prompt text unchanged ──
  const ctx = {
    gameActiveState: "exploration",
    storyArc: null,
    plotTwists: null,
    map: null,
    npcs: [],
    sessionSummaries: [],
    sessionNumber: 2,
    partyNames: [],
    partyCards: [],
    playerName: "Rowan Mercer",
    gmCharacterCard: null,
    difficulty: "normal",
    genre: "scifi",
    setting: "original",
    tone: "balanced",
    rating: "sfw",
    sceneCharacterCards: [{ name: "tarn", card: "Name: tarn\nold text" }],
    sceneCharacterCardUpdates: [{ name: "tarn", card: "Name: tarn\nnew text" }],
  } as any;
  const off = buildGmSystemPromptParts(ctx, { cacheFriendly: true });
  assert.match(
    off.dynamic,
    /Current library cards for people named in this session who are not in the party\. Where a person also appears in an earlier library card block, this newer card replaces it\./u,
  );
  const on = buildGmSystemPromptParts({ ...ctx, sceneCharacterCardUpdatesFrozen: true }, { cacheFriendly: true });
  assert.match(on.dynamic, /a list of changes applies to their earlier library card block/u);
  assert.equal(on.reference, off.reference, "the cached reference blocks are the same either way");

  // ── Cache-stable Game layout: its rebuild threshold counts the history after its block ──
  const { planGameStableLayout } = await import("../../packages/server/src/services/generation/game-stable-layout.js");
  const foldsAfter = (historyChars: number) => {
    const history = [
      { role: "user", content: "u".repeat(historyChars / 2), contextKind: "history" },
      { role: "assistant", content: "a".repeat(historyChars / 2), contextKind: "history" },
    ];
    const tail = (version: string) => ({
      role: "user",
      content: `<party>\n${Array.from({ length: 80 }, (_, i) => `member line ${i} ${version}`.padEnd(200, ".")).join("\n")}\n</party>`,
      contextKind: "injection",
    });
    let snap: any = null;
    for (let turn = 1; turn <= 12; turn += 1) {
      const plan = planGameStableLayout([...history, tail(turn === 1 ? "v1" : "v2")] as any, snap);
      if (turn > 1 && plan.folded) return turn;
      snap = plan.snapshot;
    }
    return null;
  };
  assert.notEqual(foldsAfter(4_000), null, "a short history rebuilds the block soon");
  assert.equal(foldsAfter(2_000_000), null, "a long history keeps the block while the carried change is cheaper");

  // ── Simulated session: shared prefix per turn, before and after ──
  // Twelve named cards of about 3,000 characters sit ahead of about 400,000 characters of history. Between turns
  // the biographer rewrites one card (every other time only rewording it) and a new person is named every third turn.
  const cardText = (id: string, facts: number, wording: number) =>
    [
      `Name: ${id}`,
      ...Array.from(
        { length: 40 },
        (_, i) => `Line ${i} of the ${i === 0 && wording % 2 ? "record" : "file"} on ${id}.`,
      ),
      ...Array.from({ length: facts }, (_, i) => `Established fact ${i} about ${id}.`),
    ].join("\n");
  const simulate = (frozen: boolean) => {
    const people = Array.from({ length: 12 }, (_, i) => `npc${i}`);
    const facts = new Map(people.map((id) => [id, 0]));
    const wording = new Map(people.map((id) => [id, 0]));
    const saved = new Map(people.map((id) => [id, cardText(id, 0, 0)]));
    let snap: any = null;
    let history = "h".repeat(400_000);
    let previousPrompt = "";
    const shares: number[] = [];
    for (let turn = 1; turn <= 20; turn += 1) {
      if (turn > 1) {
        const target = people[turn % people.length]!;
        if (turn % 2) facts.set(target, facts.get(target)! + 1);
        else wording.set(target, wording.get(target)! + 1);
        const proposed = cardText(target, facts.get(target)!, wording.get(target)!);
        if (!(frozen && isSubstantivelySameText(saved.get(target)!, proposed))) saved.set(target, proposed);
        if (turn % 3 === 0) {
          const id = `late${turn}`;
          people.push(id);
          saved.set(id, cardText(id, 0, 0));
        }
        history += "x".repeat(3_000);
      }
      const current = people.map((id) => ({ id, name: id, card: saved.get(id)! }));
      const plan = frozen
        ? planNamedCardLayout(snap, current, {
            freeze: { sessionKey: "2", turnKey: turn, suffixChars: history.length },
          })
        : planNamedCardLayout(snap, current);
      snap = plan.snapshot;
      const prompt = [
        "system rules ".repeat(800),
        ...plan.stable.map((entry: { card: string }) => entry.card),
        history,
        ...plan.updates.map((entry: { card: string }) => entry.card),
        `live values for turn ${turn}`,
      ].join("\n");
      let shared = 0;
      while (shared < previousPrompt.length && previousPrompt.charCodeAt(shared) === prompt.charCodeAt(shared))
        shared += 1;
      shares.push(turn === 1 ? 0 : Math.round((shared / prompt.length) * 100));
      previousPrompt = prompt;
    }
    return shares;
  };
  const before = simulate(false);
  const after = simulate(true);
  console.log(`shared prefix per turn, switch off: ${before.join(" ")}`);
  console.log(`shared prefix per turn, switch on:  ${after.join(" ")}`);
  assert.ok(
    before.slice(1).some((share) => share < 50),
    "the old layout breaks the cache mid-session",
  );
  assert.ok(
    after.slice(1).every((share) => share >= 80),
    "no turn after the first falls below 80%",
  );

  console.log("game-freeze-npc-cards regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
