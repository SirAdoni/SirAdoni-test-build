export type NpcBackfillBatchResult = { changed: boolean; issues?: number };

export async function runNpcBackfillBatches(options: {
  runBatch: (pass: number) => Promise<NpcBackfillBatchResult>;
  saveCheckpoint: (status: "running" | "completed" | "completed_with_issues" | "failed", pass: number) => Promise<void>;
  maxPasses?: number;
}): Promise<{ passes: number }> {
  const maxPasses = options.maxPasses ?? 5000;
  let pass = 0;
  let issues = 0;
  await options.saveCheckpoint("running", pass);
  try {
    while (true) {
      pass += 1;
      const result = await options.runBatch(pass);
      issues += result.issues ?? 0;
      if (!result.changed) {
        await options.saveCheckpoint(issues > 0 ? "completed_with_issues" : "completed", pass);
        return { passes: pass };
      }
      await options.saveCheckpoint("running", pass);
      if (pass >= maxPasses) throw new Error("NPC transcript backfill exceeded the safe batch limit; retry to resume");
    }
  } catch (error) {
    await options.saveCheckpoint("failed", pass);
    throw error;
  }
}
