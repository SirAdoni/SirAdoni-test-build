export interface SpatialReconciliationRetryArgs<State, Directive, Snapshot> {
  initialState: State;
  reconcile(state: State): Promise<Directive>;
  commit(directive: Directive, state: State): Promise<Snapshot>;
  refreshState(): Promise<State>;
  canRetry(before: State, after: State): Promise<boolean> | boolean;
  isConflict(error: unknown): boolean;
  isAccepted(directive: Directive, snapshot: Snapshot): boolean;
  allowRejectedRetry?: boolean;
  signal?: AbortSignal;
}

export function sameSpatialReconciliationState<
  State extends {
    currentLocationId: string | null;
    visibleAnchor: { messageId: string; swipeIndex: number } | null;
    snapshot: { id: string } | null;
    definition: { revision: number } | null;
  },
>(before: State, after: State): boolean {
  return (
    before.currentLocationId === after.currentLocationId &&
    before.visibleAnchor?.messageId === after.visibleAnchor?.messageId &&
    before.visibleAnchor?.swipeIndex === after.visibleAnchor?.swipeIndex &&
    before.snapshot?.id === after.snapshot?.id &&
    before.definition?.revision !== after.definition?.revision
  );
}

export async function runSpatialReconciliationWithRetry<State, Directive, Snapshot>(
  args: SpatialReconciliationRetryArgs<State, Directive, Snapshot>,
): Promise<{ directive: Directive; snapshot: Snapshot; state: State; reconciliationCount: number }> {
  const maxReconciliations = 2;
  let state = args.initialState;
  let reconciliationCount = 1;
  args.signal?.throwIfAborted();
  let directive = await args.reconcile(state);

  for (;;) {
    try {
      args.signal?.throwIfAborted();
      const snapshot = await args.commit(directive, state);
      if (args.isAccepted(directive, snapshot)) {
        return { directive, snapshot, state, reconciliationCount };
      }
      if (!args.allowRejectedRetry || reconciliationCount >= maxReconciliations) {
        throw new Error("The map rejected the narrated location change; the saved location was not updated.");
      }
      reconciliationCount += 1;
      args.signal?.throwIfAborted();
      state = await args.refreshState();
      args.signal?.throwIfAborted();
      directive = await args.reconcile(state);
    } catch (error) {
      if (!args.isConflict(error) || reconciliationCount >= maxReconciliations) throw error;
      args.signal?.throwIfAborted();
      const nextState = await args.refreshState();
      if (!(await args.canRetry(state, nextState))) throw error;
      state = nextState;
      reconciliationCount += 1;
      args.signal?.throwIfAborted();
      directive = await args.reconcile(state);
    }
  }
}
