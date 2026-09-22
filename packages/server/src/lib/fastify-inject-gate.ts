import type { FastifyInstance } from "fastify";
import { logger } from "./logger.js";

/**
 * Fastify boots the whole instance on the first `inject()` call: after that no route, hook or plugin can be added.
 * Startup registers routes for minutes (capability packages activate one by one), and background work started early
 * in that window (continuity workers, package timers calling their internal routes) could call `inject()` and freeze
 * registration half way, so later packages failed with "Root plugin has already booted" and the next `addHook` threw
 * and killed the process. This holds every `inject()` made before registration ends and releases them afterwards.
 * Nothing awaited by the registration itself may inject (that would boot the app too early anyway), so holding them
 * cannot deadlock working code; a call still held after the warning delay is logged with its stack.
 */
export function holdInjectUntilRegistered(app: FastifyInstance, warnAfterMs = 60_000): () => void {
  const originalInject = app.inject.bind(app) as (...args: unknown[]) => unknown;
  let released = false;
  let release: () => void = () => undefined;
  const registered = new Promise<void>((resolve) => {
    release = resolve;
  });

  const gatedInject = (...args: unknown[]): unknown => {
    if (released || args.length === 0) return originalInject(...args);
    const stack = new Error("inject() called before startup registration finished").stack;
    const warning = setTimeout(() => {
      logger.warn({ stack }, "[startup] An internal request is still waiting for route registration to finish");
    }, warnAfterMs);
    warning.unref?.();
    const run = () => {
      clearTimeout(warning);
      return originalInject(...args);
    };
    const callback = args[1];
    if (typeof callback === "function") {
      void registered.then(run);
      return undefined;
    }
    return registered.then(run);
  };
  (app as unknown as { inject: typeof gatedInject }).inject = gatedInject;

  return () => {
    if (released) return;
    released = true;
    release();
  };
}
