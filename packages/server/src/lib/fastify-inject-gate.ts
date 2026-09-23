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
/** The first stack frame outside src/lib, so a held call names the code that made it. */
function callerFrame(stack: string | undefined): string | undefined {
  const frames = (stack ?? "").split("\n").slice(1);
  const frame = frames.find((line) => !/[\\/]lib[\\/]/.test(line) && !line.includes("node:"));
  return frame?.trim().replace(/^at\s+/, "");
}

function describeInjectCall(args: unknown[]): { method: string; url: string | undefined } {
  const first = args[0] as { url?: unknown; method?: unknown } | string | undefined;
  const raw = typeof first === "string" ? first : typeof first?.url === "string" ? first.url : undefined;
  const method = typeof first === "object" && typeof first?.method === "string" ? first.method : "GET";
  return { method, url: raw?.split("?", 1)[0] };
}

export function holdInjectUntilRegistered(app: FastifyInstance, warnAfterMs = 60_000): () => void {
  const originalInject = app.inject.bind(app) as (...args: unknown[]) => unknown;
  let released = false;
  let heldCount = 0;
  let maxHeldMs = 0;
  const urls = new Set<string>();
  let release: () => void = () => undefined;
  const registered = new Promise<void>((resolve) => {
    release = resolve;
  });

  const gatedInject = (...args: unknown[]): unknown => {
    if (released || args.length === 0) return originalInject(...args);
    const stack = new Error("inject() called before startup registration finished").stack;
    const { method, url } = describeInjectCall(args);
    const heldAt = Date.now();
    heldCount++;
    if (url && urls.size < 10) urls.add(`${method} ${url}`);
    logger.debug(
      { event: "startup.inject_held", method, url, heldCount, caller: callerFrame(stack) },
      "[startup] Holding an internal request until route registration finishes",
    );
    const warning = setTimeout(() => {
      logger.warn(
        { event: "startup.inject_held", method, url, heldMs: Date.now() - heldAt, stack },
        "[startup] An internal request is still waiting for route registration to finish",
      );
    }, warnAfterMs);
    warning.unref?.();
    const run = () => {
      clearTimeout(warning);
      maxHeldMs = Math.max(maxHeldMs, Date.now() - heldAt);
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
    if (heldCount > 0) {
      // Held calls run on the next microtasks; report after they are dispatched so maxHeldMs is final.
      queueMicrotask(() => {
        logger.info(
          { event: "startup.inject_released", heldCount, maxHeldMs, urls: [...urls] },
          "[startup] Released %d internal requests held during registration",
          heldCount,
        );
      });
    }
  };
}
