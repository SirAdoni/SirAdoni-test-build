import assert from "node:assert/strict";
import {
  runSpatialReconciliationWithRetry,
  sameSpatialReconciliationState,
} from "../../packages/server/src/routes/generate/spatial-reconciliation-retry.ts";

const conflict = new Error("The world map changed during location reconciliation; retry with the updated location.");
type State = {
  currentLocationId: string | null;
  definition: { revision: number };
  definitionRevision: number;
  visibleAnchor: { messageId: string; swipeIndex: number } | null;
  snapshot: { id: string } | null;
  source: string;
  swipe: number;
};

const base: State = {
  currentLocationId: "robert-room",
  definition: { revision: 115 },
  definitionRevision: 115,
  visibleAnchor: { messageId: "turn-1", swipeIndex: 0 },
  snapshot: { id: "snapshot-1" },
  source: "narration",
  swipe: 0,
};
const moved = { ...base, definition: { revision: 116 } };

async function runScenario(options: {
  next?: State;
  commitErrors?: Error[];
  canRetry?: (before: State, after: State) => boolean;
  reconcileError?: Error;
  signal?: AbortSignal;
  onReconcile?: () => void;
}) {
  let reconciliations = 0;
  let commits = 0;
  const result = await runSpatialReconciliationWithRetry({
    initialState: base,
    reconcile: async (state) => {
      reconciliations += 1;
      options.onReconcile?.();
      if (options.reconcileError) throw options.reconcileError;
      return null;
    },
    commit: async () => {
      const error = options.commitErrors?.[commits];
      commits += 1;
      if (error) throw error;
      return { ok: true };
    },
    refreshState: async () => options.next ?? moved,
    canRetry: options.canRetry ?? sameSpatialReconciliationState,
    isConflict: (error) => error === conflict,
    isAccepted: (_directive, snapshot) => snapshot.ok,
    signal: options.signal,
  });
  return { result, reconciliations, commits };
}

const stay = await runScenario({ commitErrors: [conflict] });
assert.equal(stay.commits, 2, "a stay/null-style reconciliation conflict retries once");
assert.equal(stay.reconciliations, 2);
assert.equal(stay.result.state.definition.revision, 116);
assert.equal(stay.result.state.definitionRevision, 115, "snapshot revision stays old after an image-only map edit");
const unchanged = await runScenario({});
assert.equal(unchanged.reconciliations, 1);
assert.equal(unchanged.commits, 1);

const cancellation = new AbortController();
await assert.rejects(runScenario({ signal: cancellation.signal, onReconcile: () => cancellation.abort() }), {
  name: "AbortError",
});

await assert.rejects(
  runScenario({ commitErrors: [conflict, conflict] }),
  /world map changed during location reconciliation/,
);
await assert.rejects(runScenario({ reconcileError: new Error("provider failed") }), /provider failed/);
await assert.rejects(
  runScenario({ commitErrors: [conflict], canRetry: () => false }),
  /world map changed during location reconciliation/,
);
await assert.rejects(
  runScenario({ commitErrors: [conflict], next: { ...moved, currentLocationId: "other-room" } }),
  /world map changed during location reconciliation/,
);
await assert.rejects(
  runScenario({
    commitErrors: [conflict],
    next: { ...moved, visibleAnchor: { messageId: "new-turn", swipeIndex: 0 } },
  }),
  /world map changed during location reconciliation/,
);
await assert.rejects(
  runScenario({
    commitErrors: [conflict],
    next: { ...moved, source: "edited", swipe: 1 },
    canRetry: (before, after) =>
      sameSpatialReconciliationState(before, after) && before.source === after.source && before.swipe === after.swipe,
  }),
  /world map changed during location reconciliation/,
);
await assert.rejects(
  runScenario({
    commitErrors: [conflict],
    canRetry: () => {
      throw new Error("aborted");
    },
  }),
  /aborted/,
);

console.info("Spatial reconciliation retry regression checks passed.");
