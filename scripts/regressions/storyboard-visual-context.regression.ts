import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { normalizeStoryboardContinuity, normalizeStoryboardAgentSettings } from "../../packages/shared/src/index.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatStoryboardVisualContext,
  reviewAndCorrectStoryboardVisualPlan,
  resolveStoryboardVisualState,
  validateVisualFacts,
  verifyStoryboardVisualPlan,
  visualHistoryHash,
  visualHistoryThrough,
  type VisualSourceMessage,
} from "../../packages/server/src/services/game/storyboard-visual-context.js";

const root = mkdtempSync(join(tmpdir(), "marinara-visual-context-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
const { buildApp } = await import("../../packages/server/src/app.js");
const app = await buildApp();
try {
  const history: VisualSourceMessage[] = [
    { id: "u1", role: "user", content: "I sit on the table and continue working on the magical nexus core." },
    { id: "a1", role: "assistant", content: "Vigil stands beside the table. Diagrams surround the nexus core." },
    { id: "u2", role: "user", content: "The first painting I liked was of a statue I made." },
    { id: "a2", role: "assistant", content: "Vigil asks what the statue was of." },
    { id: "future", role: "user", content: "I stop working and leave for the gardens." },
  ];
  const position = {
    subject: "Robert",
    kind: "position" as const,
    fact: "Robert sits on the tabletop.",
    messageId: "u1",
    quote: "I sit on the table",
  };
  const activity = {
    subject: "Robert",
    kind: "activity" as const,
    fact: "Robert works on the magical nexus core.",
    messageId: "u1",
    quote: "continue working on the magical nexus core",
  };
  const facts = [position, activity];
  const locationContext = "Robert's Chambers: a dark walnut writing table.";
  let analystCalls = 0;
  const state = await resolveStoryboardVisualState({
    history,
    messageId: "a2",
    locationContext,
    checkpoints: [],
    complete: async (system, input) => {
      analystCalls++;
      assert.match(system, /Sitting ON a table is not sitting AT it/);
      assert.doesNotMatch(input, /leave for the gardens/);
      assert.match(input, /magical nexus core/);
      assert.equal(JSON.parse(input).messages.at(-1).id, "a2");
      return { openingFacts: facts, closingFacts: facts, uncertainties: [] };
    },
  });
  assert.equal(analystCalls, 1);
  const custom = normalizeStoryboardContinuity({
    rules: "Custom continuity contract.",
    analystPrompt: "Custom analyst behaviour.",
    reviewPrompt: "Custom review behaviour.",
    repairAttempts: 0,
    historyCharacters: 4000,
  });
  assert.equal(normalizeStoryboardAgentSettings({ visualContinuity: custom }).visualContinuity.rules, custom.rules);
  assert.equal(normalizeStoryboardContinuity({ rules: "" }, custom).rules, "", "Empty prompt is an explicit override");
  assert.equal(normalizeStoryboardContinuity(null, custom).rules, custom.rules, "Reset inherits defaults");
  assert.equal(normalizeStoryboardContinuity({ repairAttempts: 999 }).repairAttempts, 4);
  assert.equal(normalizeStoryboardContinuity({ historyCharacters: -1 }).historyCharacters, 4000);
  let customCalls = 0;
  const customState = await resolveStoryboardVisualState({
    history,
    messageId: "a2",
    locationContext,
    settings: custom,
    checkpoints: [JSON.stringify(state)],
    complete: async (system) => {
      customCalls++;
      assert.match(system, /Custom analyst behaviour/);
      assert.match(system, /Custom continuity contract/);
      assert.doesNotMatch(system, /Sitting ON a table/);
      return { openingFacts: facts, closingFacts: facts, uncertainties: [] };
    },
  });
  assert.equal(customCalls, 1, "Changed settings invalidate existing checkpoints");
  const { applyStoryboardAgentSettings } =
    await import("../../packages/server/src/services/game/storyboard-agent-settings.js");
  const agentStore = {
    ensureBuiltinConfig: async () => ({
      id: "storyboard",
      settings: { visualContinuity: custom },
    }),
  } as unknown as Parameters<typeof applyStoryboardAgentSettings>[1];
  for (const mode of ["game", "roleplay"] as const) {
    const inherited = await applyStoryboardAgentSettings({}, agentStore, mode);
    assert.equal((inherited.storyboardVisualContinuity as typeof custom).rules, custom.rules);
    const overridden = await applyStoryboardAgentSettings(
      { storyboardVisualContinuity: { rules: "Chat rule" } },
      agentStore,
      mode,
    );
    assert.equal((overridden.storyboardVisualContinuity as typeof custom).rules, "Chat rule");
    assert.equal((overridden.storyboardVisualContinuity as typeof custom).analystPrompt, custom.analystPrompt);
    const reset = await applyStoryboardAgentSettings({ storyboardVisualContinuity: null }, agentStore, mode);
    assert.deepEqual(reset.storyboardVisualContinuity, inherited.storyboardVisualContinuity);
  }
  await resolveStoryboardVisualState({
    history,
    messageId: "a2",
    locationContext,
    settings: custom,
    checkpoints: [JSON.stringify(customState)],
    complete: async () => {
      throw new Error("Unchanged custom settings should reuse the checkpoint");
    },
  });
  assert.doesNotMatch(formatStoryboardVisualContext(customState, "", custom), /Sitting ON a table/);
  await verifyStoryboardVisualPlan({
    context: "",
    locationContext,
    frames: [],
    settings: custom,
    complete: async (system) => {
      assert.match(system, /Custom review behaviour/);
      assert.doesNotMatch(system, /Sitting ON a table/);
      return { consistent: true, reason: "" };
    },
  });
  const disabled = normalizeStoryboardContinuity({ enabled: false });
  const disabledState = await resolveStoryboardVisualState({
    history,
    messageId: "a2",
    locationContext,
    settings: disabled,
    checkpoints: [],
    complete: async () => {
      throw new Error("Disabled extraction must not call AI");
    },
  });
  assert.equal(formatStoryboardVisualContext(disabledState, "", disabled), "");
  for (const settings of [disabled, normalizeStoryboardContinuity({ reviewEnabled: false })]) {
    await verifyStoryboardVisualPlan({
      context: "",
      locationContext,
      frames: [],
      settings,
      complete: async () => {
        throw new Error("Disabled review must not call AI");
      },
    });
  }
  for (const malformed of [
    { wrongEnvelope: [] },
    { openingFacts: facts, closingFacts: facts, uncertainties: [{ detail: "unknown" }] },
    { openingFacts: [{ ...position, quote: "fabricated quote" }], closingFacts: [], uncertainties: [] },
  ]) {
    let attempts = 0;
    const repaired = await resolveStoryboardVisualState({
      history,
      messageId: "a2",
      locationContext,
      checkpoints: [],
      complete: async (system) => {
        attempts++;
        if (attempts === 1) return malformed;
        assert.match(system, /previous response failed validation/);
        return { openingFacts: facts, closingFacts: facts, uncertainties: [] };
      },
    });
    assert.equal(attempts, 2);
    assert.deepEqual(repaired.openingFacts, facts);
  }
  let invalidAttempts = 0;
  await assert.rejects(
    resolveStoryboardVisualState({
      history,
      messageId: "a2",
      locationContext,
      checkpoints: [],
      complete: async () => {
        invalidAttempts++;
        return { openingFacts: [], closingFacts: [], uncertainties: [{}] };
      },
    }),
    /invalid model output after one repair/,
  );
  assert.equal(invalidAttempts, 2);
  let providerAttempts = 0;
  await assert.rejects(
    resolveStoryboardVisualState({
      history,
      messageId: "a2",
      locationContext,
      checkpoints: [],
      complete: async () => {
        providerAttempts++;
        throw new Error("provider unavailable");
      },
    }),
    /provider unavailable/,
  );
  assert.equal(providerAttempts, 1);

  assert.throws(
    () =>
      validateVisualFacts(
        {
          openingFacts: [
            { ...position, subject: "First invalid", quote: "bad first" },
            { ...activity, subject: "Second invalid", quote: "bad second" },
          ],
          closingFacts: [],
          uncertainties: [],
        },
        history,
        "a2",
      ),
    (error: unknown) =>
      error instanceof Error && error.message.includes("First invalid") && error.message.includes("Second invalid"),
  );
  const locationFact = {
    subject: "Room",
    kind: "location" as const,
    fact: "Dark walnut writing table in Robert's Chambers.",
    messageId: "locationContext",
    quote: "a dark walnut writing table",
  };
  validateVisualFacts(
    { openingFacts: [locationFact], closingFacts: [], uncertainties: [] },
    history,
    "a2",
    locationContext,
  );
  for (const invalid of [
    { ...locationFact, quote: "invented furnishings" },
    { ...locationFact, kind: "presence" as const },
    { ...locationFact, kind: "activity" as const },
  ]) {
    assert.throws(
      () =>
        validateVisualFacts(
          { openingFacts: [invalid], closingFacts: [], uncertainties: [] },
          history,
          "a2",
          locationContext,
        ),
      /no matching source quote/,
    );
  }
  assert.throws(
    () =>
      validateVisualFacts(
        { openingFacts: [locationFact], closingFacts: [], uncertainties: [] },
        history,
        "a2",
        "A different room",
      ),
    /no matching source quote/,
  );
  const locationState = await resolveStoryboardVisualState({
    history,
    messageId: "a2",
    locationContext,
    checkpoints: [],
    complete: async () => ({ openingFacts: [locationFact], closingFacts: [locationFact], uncertainties: [] }),
  });
  const multiLocationHistory: VisualSourceMessage[] = [
    { id: "workshop-before", role: "assistant", content: "The quiet workshop remains ready beneath the old bridge." },
    {
      id: "walk-turn",
      role: "assistant",
      content:
        "A narrow street replaces the workshop. The arrival places you beside the station desk. The waiting room is small and plainly kept. A wooden bench stands against the far wall beneath a window left open by a hand's width, while a clock ticks above the door.",
    },
  ];
  const denLocationContext = "A quiet workshop beneath the old bridge, with shelves of labeled tools.";
  const bedroomQuote =
    "The waiting room is small and plainly kept. A wooden bench stands against the far wall beneath a window left open by a hand's width.";
  const invalidDestinationFact = {
    subject: "Station Waiting Room",
    kind: "location" as const,
    fact: "The station waiting room is small and plainly kept.",
    messageId: "locationContext",
    quote: bedroomQuote,
  };
  assert.throws(
    () =>
      validateVisualFacts(
        { openingFacts: [], closingFacts: [invalidDestinationFact], uncertainties: [] },
        multiLocationHistory,
        "walk-turn",
        denLocationContext,
      ),
    /no matching source quote/,
    "A destination fact cannot cite the canonical location source",
  );
  let multiLocationAttempts = 0;
  const multiLocationState = await resolveStoryboardVisualState({
    history: multiLocationHistory,
    messageId: "walk-turn",
    openingMessageId: "walk-turn",
    locationContext: denLocationContext,
    checkpoints: [],
    complete: async (system, input) => {
      multiLocationAttempts++;
      assert.match(system, /separate locationContext source/);
      assert.match(system, /never establishes a person's presence, posture, clothing or actions/);
      const payload = JSON.parse(input);
      assert.deepEqual(payload.locationContextSource, { messageId: "locationContext", text: denLocationContext });
      assert.equal(payload.locationContext, undefined, "Continuity input must not duplicate the location source");
      return multiLocationAttempts === 1
        ? { openingFacts: [], closingFacts: [invalidDestinationFact], uncertainties: [] }
        : {
            openingFacts: [],
            closingFacts: [{ ...invalidDestinationFact, messageId: "walk-turn" }],
            uncertainties: [],
          };
    },
  });
  assert.equal(multiLocationAttempts, 2, "The invalid citation should be rejected once and repaired once");
  assert.equal(multiLocationState.closingFacts[0]?.messageId, "walk-turn");
  assert.equal(
    multiLocationState.closingFacts[0]?.quote,
    "The waiting room is small and plainly kept. A wooden bench stands against the far wall beneath a window left open by a hand's width",
    "Only the source substring, without the model-added terminal period, is stored",
  );
  assert.throws(
    () =>
      validateVisualFacts(
        {
          openingFacts: [],
          closingFacts: [
            {
              subject: "Station Waiting Room",
              kind: "location",
              fact: "negated wording",
              messageId: "walk-turn",
              quote: "The waiting room is not small and plainly kept",
            },
          ],
          uncertainties: [],
        },
        multiLocationHistory,
        "walk-turn",
        denLocationContext,
      ),
    /no matching source quote/,
    "Changed or negated wording is never accepted as a source quote",
  );
  const oldLocationContext = "A neutral archive room with labeled drawers.";
  const oldHistory: VisualSourceMessage[] = [
    { id: "old-turn", role: "assistant", content: "The archive room is ready." },
  ];
  const oldState = await resolveStoryboardVisualState({
    history: oldHistory,
    messageId: "old-turn",
    locationContext: oldLocationContext,
    checkpoints: [],
    complete: async () => ({
      openingFacts: [],
      closingFacts: [
        {
          subject: "Archive room",
          kind: "location" as const,
          fact: "The archive room has labeled drawers.",
          messageId: "locationContext",
          quote: oldLocationContext,
        },
      ],
      uncertainties: [],
    }),
  });
  const oldSourceId = Object.keys(oldState.locationContextSources ?? {})[0];
  assert.match(oldSourceId ?? "", /^locationContext:[0-9a-f]{64}$/);
  assert.equal(oldState.closingFacts[0]?.messageId, oldSourceId);
  const provenanceNextHistory: VisualSourceMessage[] = [
    ...oldHistory,
    { id: "next-turn", role: "assistant", content: "The courier waits in the station room." },
  ];
  let provenanceCalls = 0;
  const carriedState = await resolveStoryboardVisualState({
    history: provenanceNextHistory,
    messageId: "next-turn",
    locationContext: "A neutral station room with a painted clock.",
    checkpoints: [JSON.stringify(oldState)],
    complete: async (_system, input) => {
      provenanceCalls++;
      const payload = JSON.parse(input);
      assert.equal(payload.previousFacts[0].messageId, oldSourceId);
      assert.deepEqual(payload.trustedLocationContextSourceIds, [oldSourceId]);
      return {
        openingChanges: { remove: [], upsert: [] },
        closingChanges: { remove: [], upsert: [] },
        uncertainties: [],
      };
    },
  });
  assert.equal(provenanceCalls, 1);
  assert.equal(carriedState.closingFacts[0]?.messageId, oldSourceId);
  assert.equal(carriedState.locationContextSources?.[oldSourceId!], oldLocationContext);
  const sameContextState = await resolveStoryboardVisualState({
    history: provenanceNextHistory,
    messageId: "next-turn",
    locationContext: oldLocationContext,
    checkpoints: [JSON.stringify(oldState)],
    complete: async () => ({
      openingChanges: { remove: [], upsert: [] },
      closingChanges: { remove: [], upsert: [] },
      uncertainties: [],
    }),
  });
  assert.deepEqual(Object.keys(sameContextState.locationContextSources ?? {}), [oldSourceId]);
  const reused = await resolveStoryboardVisualState({
    history: provenanceNextHistory,
    messageId: "next-turn",
    locationContext: "A neutral station room with a painted clock.",
    checkpoints: [JSON.stringify(carriedState)],
    complete: async () => {
      throw new Error("A valid provenance checkpoint should be reusable");
    },
  });
  assert.deepEqual(reused, carriedState);
  const unusedSourceText = "An unused neutral location source.";
  const unusedSourceId = `locationContext:${createHash("sha256").update(unusedSourceText).digest("hex")}`;
  const withUnusedSource = {
    ...carriedState,
    locationContextSources: {
      ...carriedState.locationContextSources,
      [unusedSourceId]: unusedSourceText,
    },
  };
  const pruned = await resolveStoryboardVisualState({
    history: provenanceNextHistory,
    messageId: "next-turn",
    locationContext: "A neutral station room with a painted clock.",
    checkpoints: [JSON.stringify(withUnusedSource)],
    complete: async () => {
      throw new Error("A checkpoint with an unused source should still be reusable");
    },
  });
  assert.equal(pruned.locationContextSources?.[unusedSourceId], undefined);
  assert.equal(Object.keys(pruned.locationContextSources ?? {}).length, 1);
  assert.throws(
    () =>
      validateVisualFacts(
        {
          openingFacts: [],
          closingFacts: [
            {
              subject: "Archive room",
              kind: "location",
              fact: "fabricated",
              messageId: `locationContext:${"0".repeat(64)}`,
              quote: oldLocationContext,
            },
          ],
          uncertainties: [],
        },
        provenanceNextHistory,
        "next-turn",
        "A neutral station room with a painted clock.",
        carriedState.locationContextSources,
      ),
    /no matching source quote|Invalid storyboard location context source/,
  );
  assert.throws(
    () =>
      validateVisualFacts(
        {
          openingFacts: [],
          closingFacts: [
            {
              subject: "Archive room",
              kind: "position",
              fact: "wrong kind",
              messageId: oldSourceId!,
              quote: oldLocationContext,
            },
          ],
          uncertainties: [],
        },
        provenanceNextHistory,
        "next-turn",
        "A neutral station room with a painted clock.",
        carriedState.locationContextSources,
      ),
    /no matching source quote/,
  );
  const tooManySources = Object.fromEntries(
    Array.from({ length: 81 }, (_, index) => {
      const text = `Synthetic source ${index} with enough distinct content.`;
      return [`locationContext:${createHash("sha256").update(text).digest("hex")}`, text];
    }),
  );
  assert.throws(
    () =>
      validateVisualFacts({ openingFacts: [], closingFacts: [], uncertainties: [] }, [], undefined, "", tooManySources),
    /Too many storyboard location context sources/,
  );
  await resolveStoryboardVisualState({
    history,
    messageId: "a2",
    locationContext,
    checkpoints: [JSON.stringify(locationState)],
    complete: async () => {
      throw new Error("Location evidence should remain cacheable");
    },
  });
  const wrapped = await resolveStoryboardVisualState({
    history,
    messageId: "a2",
    locationContext,
    checkpoints: [],
    complete: async () => ({
      openingFacts: [{ ...position, quote: '\"I sit on the table\"' }],
      closingFacts: [],
      uncertainties: [],
    }),
  });
  assert.equal(wrapped.openingFacts[0]?.quote, "I sit on the table");
  let joinedAttempts = 0;
  await assert.rejects(
    resolveStoryboardVisualState({
      history,
      messageId: "a2",
      locationContext,
      checkpoints: [],
      complete: async () => {
        joinedAttempts++;
        return {
          openingFacts: [{ ...position, quote: "I sit on the table magical nexus core" }],
          closingFacts: [],
          uncertainties: [],
        };
      },
    }),
    /no matching source quote/,
  );
  assert.equal(joinedAttempts, 2);
  const cache = JSON.stringify(state);
  const cached = await resolveStoryboardVisualState({
    history,
    messageId: "a2",
    locationContext,
    checkpoints: [cache],
    complete: async () => {
      throw new Error("Unexpected paid call for cached state");
    },
  });
  assert.deepEqual(cached, state);
  await resolveStoryboardVisualState({
    history,
    messageId: "a2",
    locationContext: "Corrected room identity",
    checkpoints: [cache, "legacy invalid JSON"],
    complete: async () => {
      return { openingFacts: facts, closingFacts: facts, uncertainties: [] };
    },
  });
  const gapHistory = [
    ...history.slice(0, 4),
    { id: "gap", role: "assistant", content: "x".repeat(65000) },
    { id: "gap-end", role: "assistant", content: "Vigil asks another question." },
  ];
  const gap = await resolveStoryboardVisualState({
    history: gapHistory,
    messageId: "gap-end",
    locationContext,
    checkpoints: [cache],
    complete: async (_system, input) => {
      const payload = JSON.parse(input);
      assert.equal(payload.historyTruncated, true);
      assert.deepEqual(payload.previousFacts, [], "Do not carry facts over an unread gap that might contain a move");
      return { openingFacts: [], closingFacts: [], uncertainties: [] };
    },
  });
  assert.match(gap.uncertainties.join(" "), /bootstrap window/);
  await assert.rejects(
    resolveStoryboardVisualState({
      history,
      messageId: "a2",
      openingMessageId: "u2",
      locationContext,
      checkpoints: [],
      complete: async () => ({
        openingFacts: [{ ...position, messageId: "u2", quote: "The first painting" }],
        closingFacts: [],
        uncertainties: [],
      }),
    }),
    /source quote/,
    "Episode opening state must precede the episode, not just its last reply",
  );
  const context = formatStoryboardVisualContext(state, history[3]!.content);
  assert.match(context, /magical nexus core/);
  assert.doesNotMatch(context, /leave for the gardens/);
  assert.throws(
    () =>
      validateVisualFacts(
        { openingFacts: [{ ...position, quote: "he sits in a chair" }], closingFacts: [], uncertainties: [] },
        history.slice(0, 4),
      ),
    /source quote/,
  );
  assert.throws(
    () =>
      validateVisualFacts(
        { openingFacts: [{ ...position, messageId: "a2", quote: "Vigil asks" }], closingFacts: [], uncertainties: [] },
        history.slice(0, 4),
      ),
    /source quote/,
  );
  assert.throws(
    () =>
      validateVisualFacts(
        { openingFacts: [position, position], closingFacts: [], uncertainties: [] },
        history.slice(0, 4),
      ),
    /duplicate/,
  );
  assert.notEqual(
    visualHistoryHash(history.slice(0, 4)),
    visualHistoryHash(history.slice(0, 4).map((m) => (m.id === "a1" ? { ...m, activeSwipeIndex: 1 } : m))),
  );
  assert.equal(
    visualHistoryThrough([{ ...history[0]!, extra: '{"hiddenFromAI":true}' }, ...history.slice(1)], "a2").some(
      (m) => m.id === "u1",
    ),
    false,
  );
  await resolveStoryboardVisualState({
    history: history.map((m) => (m.id === "u1" ? { ...m, content: "I stand by the window." } : m)),
    messageId: "a2",
    locationContext,
    checkpoints: [cache],
    complete: async () => {
      analystCalls++;
      return { openingFacts: [], closingFacts: [], uncertainties: ["Position changed."] };
    },
  });
  assert.equal(analystCalls, 2, "Editing an earlier message invalidates the checkpoint");
  const nextHistory = [
    ...history.slice(0, 4),
    { id: "u3", role: "user", content: "Tell me more." },
    { id: "a3", role: "assistant", content: "Vigil continues speaking." },
  ];
  await resolveStoryboardVisualState({
    history: nextHistory,
    messageId: "a3",
    locationContext,
    checkpoints: [cache],
    complete: async (_system, input) => {
      const payload = JSON.parse(input);
      assert.deepEqual(payload.previousFacts, facts);
      assert.deepEqual(
        payload.messages.map((m: VisualSourceMessage) => m.id),
        ["u3", "a3"],
      );
      return { openingFacts: facts, closingFacts: facts, uncertainties: [] };
    },
  });
  const movedHistory = [...history, { id: "a3", role: "assistant", content: "You arrive in the gardens." }];
  const moved = await resolveStoryboardVisualState({
    history: movedHistory,
    messageId: "a3",
    locationContext: "Gardens",
    checkpoints: [cache],
    complete: async (_system, input) => {
      assert.match(input, /stop working/);
      return {
        openingFacts: [],
        closingFacts: [
          {
            subject: "Robert",
            kind: "location",
            fact: "Robert is in the gardens.",
            messageId: "a3",
            quote: "You arrive in the gardens.",
          },
        ],
        uncertainties: [],
      };
    },
  });
  assert.equal(
    moved.closingFacts.some((f) => f.kind === "activity"),
    false,
  );
  await assert.rejects(
    verifyStoryboardVisualPlan({
      context,
      locationContext,
      frames: [{ imagePrompt: "Robert stands in the Root Vault, painting.", characters: ["Robert"] }],
      complete: async () => ({ consistent: false, reason: "Wrong room, posture and activity." }),
    }),
    /Wrong room, posture and activity/,
  );
  await assert.rejects(
    verifyStoryboardVisualPlan({ context, locationContext, frames: [], complete: async () => ({}) }),
    /consistent/,
  );
  let longReviewCalls = 0;
  const longReason = "Preserve the established seating and objects. ".repeat(60);
  await assert.rejects(
    verifyStoryboardVisualPlan({
      context,
      locationContext,
      frames: [],
      complete: async () => {
        longReviewCalls++;
        return { consistent: false, reason: longReason };
      },
    }),
    (error: Error) => error.message === `Storyboard continuity check stopped image generation: ${longReason}`,
  );
  assert.equal(longReviewCalls, 1, "A detailed valid review must reach plan repair, not schema repair");
  await verifyStoryboardVisualPlan({
    context,
    locationContext,
    sourceMessages: history.slice(0, 4),
    characterAppearanceContext: "Robert has established high-elf features.",
    frames: [{ imagePrompt: "Robert works on the nexus core while Vigil talks.", characters: ["Robert", "Vigil"] }],
    complete: async (system, input) => {
      assert.match(system, /separate locationContext source/);
      assert.match(input, /I sit on the table/);
      assert.match(input, /established high-elf features/);
      const payload = JSON.parse(input);
      assert.deepEqual(payload.locationContextSource, { messageId: "locationContext", text: locationContext });
      assert.equal(payload.location, undefined, "Review input must not expose a catch-all location alias");
      return { consistent: true, reason: "Grounded in the scene." };
    },
  });

  const storyboardFrames = [
    { imagePrompt: "Robert sits on the tabletop working on the magical nexus core.", characters: ["Robert"] },
    { imagePrompt: "Vigil stands beside the table and asks a question.", characters: ["Vigil"] },
  ];
  let repairReviewCalls = 0;
  const repairedStoryboardFrames = await reviewAndCorrectStoryboardVisualPlan({
    context,
    locationContext,
    sourceMessages: history.slice(0, 4),
    frames: storyboardFrames,
    complete: async (_system, input) => {
      repairReviewCalls++;
      const payload = JSON.parse(input);
      if (repairReviewCalls === 1) {
        assert.deepEqual(payload.frames, storyboardFrames);
        return {
          consistent: false,
          reason: "Corrected all material continuity issues: the repaired plan is grounded.",
          corrections: [],
          correctedFrames: [
            { imagePrompt: "Robert sits on the tabletop working on the magical nexus core.", characters: ["Robert"] },
            { imagePrompt: "Vigil stands beside the table and asks a question.", characters: ["Vigil"] },
          ],
        };
      }
      assert.deepEqual(payload.originalFrames, storyboardFrames);
      assert.equal(payload.frames[0].characters[0], "Robert");
      return { consistent: true, reason: "The repaired candidate is grounded." };
    },
  });
  assert.equal(repairReviewCalls, 2, "A false original verdict gets one bounded candidate verification");
  assert.deepEqual(repairedStoryboardFrames, storyboardFrames);

  let verifiedRepairCalls = 0;
  const alreadyVerified = await reviewAndCorrectStoryboardVisualPlan({
    context,
    locationContext,
    frames: storyboardFrames,
    complete: async () => {
      verifiedRepairCalls++;
      return {
        consistent: false,
        reason: "The original plan needed a targeted repair.",
        corrections: [],
        repairVerified: true,
        correctedFrames: storyboardFrames,
      };
    },
  });
  assert.equal(verifiedRepairCalls, 1, "Structured repair verification avoids another full-plan review");
  assert.deepEqual(alreadyVerified, storyboardFrames);

  let sparseRepairCalls = 0;
  const sparseRepaired = await reviewAndCorrectStoryboardVisualPlan({
    context,
    locationContext,
    frames: storyboardFrames,
    complete: async (_system, input) => {
      sparseRepairCalls++;
      const payload = JSON.parse(input);
      if (sparseRepairCalls === 1) {
        assert.deepEqual(payload.frames, storyboardFrames);
        return {
          consistent: false,
          reason: "Corrected the first shot's posture.",
          corrections: [
            {
              index: 0,
              imagePrompt: "Robert sits on the tabletop and works on the nexus core.",
              characters: ["Robert"],
            },
          ],
        };
      }
      assert.equal(payload.frames[0].imagePrompt, "Robert sits on the tabletop and works on the nexus core.");
      return { consistent: true, reason: "The sparse repair is grounded." };
    },
  });
  assert.equal(sparseRepairCalls, 2, "Sparse repairs receive one bounded verification");
  assert.equal(sparseRepaired[0]?.imagePrompt, "Robert sits on the tabletop and works on the nexus core.");
  assert.deepEqual(sparseRepaired[1], storyboardFrames[1]);

  let soundSparseCalls = 0;
  const soundSparse = await reviewAndCorrectStoryboardVisualPlan({
    context,
    locationContext,
    frames: storyboardFrames,
    complete: async () => {
      soundSparseCalls++;
      return {
        consistent: true,
        reason: "The plan is grounded.",
        corrections: [
          { index: 0, imagePrompt: "Robert sits on the tabletop and works on the nexus core.", characters: ["Robert"] },
        ],
      };
    },
  });
  assert.equal(soundSparseCalls, 1, "A consistent sparse repair keeps the existing one-call contract");
  assert.equal(soundSparse[0]?.imagePrompt, "Robert sits on the tabletop and works on the nexus core.");

  let matchingDualShapeCalls = 0;
  const matchingDualShape = await reviewAndCorrectStoryboardVisualPlan({
    context,
    locationContext,
    frames: storyboardFrames,
    complete: async () => {
      matchingDualShapeCalls++;
      return {
        consistent: false,
        reason: "The first shot needed a posture repair.",
        corrections: [
          { index: 0, imagePrompt: "Robert sits on the tabletop and works on the nexus core.", characters: ["Robert"] },
        ],
        correctedFrames: [
          { imagePrompt: "Robert sits on the tabletop and works on the nexus core.", characters: ["Robert"] },
          storyboardFrames[1]!,
        ],
        repairVerified: true,
      };
    },
  });
  assert.equal(matchingDualShapeCalls, 1, "Matching sparse and full repairs are accepted without another review");
  assert.equal(matchingDualShape[0]?.imagePrompt, "Robert sits on the tabletop and works on the nexus core.");

  await assert.rejects(
    reviewAndCorrectStoryboardVisualPlan({
      context,
      locationContext,
      frames: storyboardFrames,
      complete: async () => ({
        consistent: false,
        reason: "Conflicting repair payloads.",
        corrections: [{ index: 0, imagePrompt: "Different correction.", characters: ["Robert"] }],
        correctedFrames: [
          { imagePrompt: "Robert sits on the tabletop and works on the nexus core.", characters: ["Robert"] },
          storyboardFrames[1]!,
        ],
      }),
    }),
    /conflicting repairs/,
  );

  let malformedRepairCalls = 0;
  await assert.rejects(
    reviewAndCorrectStoryboardVisualPlan({
      context,
      locationContext,
      frames: storyboardFrames,
      complete: async () => {
        malformedRepairCalls++;
        return {
          consistent: false,
          reason: "Corrected the plan.",
          corrections: [],
          correctedFrames: [storyboardFrames[0]],
        };
      },
    }),
    /incomplete corrected frame plan/,
  );
  assert.equal(malformedRepairCalls, 1, "Malformed repaired plans are rejected before verification");

  let unrepairedCalls = 0;
  await assert.rejects(
    reviewAndCorrectStoryboardVisualPlan({
      context,
      locationContext,
      frames: storyboardFrames,
      complete: async () => {
        unrepairedCalls++;
        return { consistent: false, reason: "Wrong room and posture remain.", corrections: [] };
      },
    }),
    /Wrong room and posture remain/,
  );
  assert.equal(unrepairedCalls, 1, "An unrepaired continuity failure remains blocked");

  const { buildSceneIllustrationProviderPrompt } =
    await import("../../packages/server/src/services/game/game-asset-generation.js");
  const reviewedShot = "Robert sits on the tabletop working on the magical nexus core while Vigil asks a question.";
  for (const promptOverride of [undefined, reviewedShot]) {
    const prompt = await buildSceneIllustrationProviderPrompt({
      chatId: "proof",
      prompt: reviewedShot,
      promptOverride,
      maxPromptCharacters: 8000,
      locationVisualContext: locationContext,
      imgModel: "proof",
      imgBaseUrl: "http://invalid",
      imgApiKey: "",
      useGamePromptTemplate: false,
    });
    assert.match(prompt.prompt, /Robert sits on the tabletop/);
    assert.match(prompt.prompt, /magical nexus core/);
    assert.ok(prompt.prompt.indexOf(locationContext) < prompt.prompt.indexOf(reviewedShot));
    assert.doesNotMatch(prompt.prompt, /openingFacts|closingFacts|messageId|SOURCE-GROUNDED PHYSICAL SCENE/);
  }
  const { buildStoryboardIllustratorMessages, resolveMessageContentForSwipe } =
    await import("../../packages/server/src/routes/game.routes.js");
  const swipeStore = {
    getSwipes: async () => [{ index: 1, content: "Selected alternate scene" }],
  } as unknown as Parameters<typeof resolveMessageContentForSwipe>[0];
  const swipeMessage = { id: "swipe-proof", content: "Current scene", activeSwipeIndex: 0 } as Parameters<
    typeof resolveMessageContentForSwipe
  >[1];
  assert.equal(await resolveMessageContentForSwipe(swipeStore, swipeMessage, 1, true), "Selected alternate scene");
  await assert.rejects(
    resolveMessageContentForSwipe(swipeStore, swipeMessage, 2, true),
    /source swipe is no longer available/,
  );
  const planner = await buildStoryboardIllustratorMessages({
    meta: {
      gameStoryboardPromptTemplates: [{ id: "proof", name: "proof", promptTemplate: "Use only this narration." }],
      gameStoryboardIllustrationPlannerTemplateIds: ["proof"],
    },
    setupConfig: null,
    latestState: { location: "Robert's Chambers" },
    sourceNarration: history[3]!.content,
    sections: [],
    keyframeCount: 1,
    durationSeconds: 5,
    aspectRatio: "16:9",
    generateVideos: false,
    physicalSceneContext: context,
    locationVisualContext: locationContext,
  });
  assert.match(JSON.stringify(planner.messages), /magical nexus core/);
  assert.match(planner.systemPrompt, /Earlier user actions already preceding this reply are context/);
  assert.doesNotMatch(JSON.stringify(planner.messages), /Root Vault/);

  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { createGameStoryboardsStorage } =
    await import("../../packages/server/src/services/storage/game-storyboards.storage.js");
  const chat = await createChatsStorage(app.db).create({
    name: "Visual context proof",
    mode: "game",
    characterIds: [],
  });
  assert(chat);
  const storage = createGameStoryboardsStorage(app.db);
  const row = await storage.create({
    chatId: chat.id,
    messageId: "a2",
    swipeIndex: 0,
    sourceNarration: history[3]!.content,
    sourceNarrationHash: "proof",
    visualSceneState: cache,
  });
  assert.equal(row?.visualSceneState, cache);
  const legacy = await storage.create({
    chatId: chat.id,
    messageId: "a1",
    swipeIndex: 0,
    sourceNarration: "Old scene",
    sourceNarrationHash: "old",
  });
  assert.equal(legacy?.visualSceneState, "");
  const route = readFileSync(new URL("../../packages/server/src/routes/game.routes.ts", import.meta.url), "utf8");
  assert.match(route, /visualSceneState: JSON.stringify\(visualSceneState\)/);
  assert.equal(
    (route.match(/maxPromptCharacters: 16000,/g) ?? []).length,
    2,
    "Preview and render share the final budget and leave continuity evidence with the planner/reviewer",
  );
  console.log(
    "PASS: storyboard continuity, source validation, history edits, selected swipes, hidden/future exclusion, carry-forward, movement, review gate, prompt plumbing and persistence (no provider calls).",
  );
} finally {
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
