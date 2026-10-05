import type { ContinuityRuntime } from "../services/game/continuity-runtime.js";

declare module "fastify" {
  interface FastifyInstance {
    gameContinuity: ContinuityRuntime;
    continuityChanges: { notify(chatId: string, messageIds?: Iterable<string>): void };
    sessionSummaryRefresh?: {
      onDependencyChanged(chatId: string): Promise<void>;
    };
  }
}
