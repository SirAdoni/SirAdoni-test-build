import { logger } from "../../lib/logger.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { StoryboardProgress } from "@marinara-engine/shared";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DATA_DIR } from "../../utils/data-dir.js";

const historyPath = (chatId: string) =>
  join(DATA_DIR, "storyboard-timings", `${createHash("sha256").update(chatId).digest("hex")}.jsonl`);

export async function storyboardProgressHistory(chatId: string) {
  try {
    return (await readFile(historyPath(chatId), "utf8"))
      .trim()
      .split("\n")
      .slice(-100)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

const currentTiming = new AsyncLocalStorage<{ time: <T>(stage: string, action: () => Promise<T>) => Promise<T> }>();

export function timeStoryboardStage<T>(stage: string, action: () => Promise<T>): Promise<T> {
  return currentTiming.getStore()?.time(stage, action) ?? action();
}

type Step = { stage: string; startedAt: number; durationMs?: number; failed?: boolean };
const runs = new Map<string, { startedAt: number; finishedAt?: number; steps: Step[] }>();

export function storyboardProgress(chatId: string): StoryboardProgress | null {
  const run = runs.get(chatId);
  if (!run) return null;
  const now = Date.now();
  return {
    active: run.finishedAt === undefined,
    startedAt: run.startedAt,
    elapsedMs: (run.finishedAt ?? now) - run.startedAt,
    targetMs: 120_000,
    steps: run.steps.map((step) => ({
      ...step,
      offsetMs: step.startedAt - run.startedAt,
      elapsedMs: step.durationMs ?? now - step.startedAt,
    })),
  };
}

export function startStoryboardProgress(
  chatId: string,
  lockStartedAt?: number,
  identity?: { messageId: string; swipeIndex: number; previewOnly: boolean },
) {
  // Only retain recent runs; no transcript, credentials or image payloads live here.
  runs.delete(chatId);
  if (runs.size >= 100) runs.delete(runs.keys().next().value!);
  const run: { startedAt: number; finishedAt?: number; steps: Step[] } = {
    startedAt: lockStartedAt ?? Date.now(),
    steps: [],
  };
  if (lockStartedAt !== undefined)
    run.steps.push({ stage: "Storyboard lock wait", startedAt: lockStartedAt, durationMs: Date.now() - lockStartedAt });
  runs.set(chatId, run);
  async function time<T>(stage: string, action: () => Promise<T>): Promise<T> {
    const step: Step = { stage, startedAt: Date.now() };
    run.steps.push(step);
    try {
      return await currentTiming.run({ time: (child, task) => time(`${stage} / ${child}`, task) }, action);
    } catch (error) {
      step.failed = true;
      throw error;
    } finally {
      step.durationMs = Date.now() - step.startedAt;
      logger.info(
        { chatId, stage, durationMs: step.durationMs, failed: step.failed ?? false },
        "[storyboard] Stage finished",
      );
    }
  }
  return {
    time,
    finish() {
      if (run.finishedAt !== undefined) return;
      run.finishedAt = Date.now();
      logger.info({ chatId, durationMs: run.finishedAt - run.startedAt }, "[storyboard] Run finished");
      // Persist this specific run, even if a newer turn has replaced the live view.
      const report = {
        ...identity,
        active: false,
        startedAt: run.startedAt,
        elapsedMs: run.finishedAt - run.startedAt,
        steps: run.steps.map((step) => ({
          ...step,
          offsetMs: step.startedAt - run.startedAt,
          elapsedMs: step.durationMs,
        })),
      };
      return mkdir(join(DATA_DIR, "storyboard-timings"), { recursive: true })
        .then(() => appendFile(historyPath(chatId), JSON.stringify(report) + "\n"))
        .catch((error) => logger.error(error, "[storyboard] Could not save timing history"));
    },
  };
}
