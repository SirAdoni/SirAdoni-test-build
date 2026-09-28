import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyInstance } from "fastify";
import { logger } from "./logger.js";

/** An internal inject that would deadlock route registration was rejected immediately. */
export class InjectDuringRegistrationError extends Error {
  readonly code = "MARINARA_INJECT_DURING_REGISTRATION";
  constructor(message: string) {
    super(message);
    this.name = "InjectDuringRegistrationError";
  }
}

type FailFastScope = { active: boolean };
const failFastScope = new AsyncLocalStorage<FailFastScope>();

/** Registration-awaited operations must fail fast if they attempt an inject. */
export async function failInjectFastDuring<T>(operation: () => Promise<T> | T): Promise<T> {
  const scope: FailFastScope = { active: true };
  try {
    return await failFastScope.run(scope, operation);
  } finally {
    scope.active = false;
  }
}

export type InjectGateOptions = {
  /** Log a warning with the caller stack after this long. */
  warnAfterMs?: number;
  /** Reject an outstanding inject after this long so startup cannot hang forever. */
  maxHoldMs?: number;
};

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

export function holdInjectUntilRegistered(app: FastifyInstance, options: InjectGateOptions = {}): () => void {
  const warnAfterMs = options.warnAfterMs ?? 60_000;
  const maxHoldMs = options.maxHoldMs ?? 10 * 60_000;
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
    const callback = typeof args[1] === "function" ? (args[1] as (error: unknown) => void) : null;
    if (failFastScope.getStore()?.active) {
      const error = new InjectDuringRegistrationError(
        "app.inject() cannot run while startup is still registering routes; call internal routes after activate() and selfCheck() return",
      );
      if (callback) {
        queueMicrotask(() => callback(error));
        return undefined;
      }
      return Promise.reject(error);
    }

    const stack = new Error("inject() called before startup registration finished").stack;
    const { method, url } = describeInjectCall(args);
    const heldAt = Date.now();
    heldCount++;
    if (url && urls.size < 10) urls.add(`${method} ${url}`);
    logger.debug(
      { event: "startup.inject_held", method, url, heldCount, caller: callerFrame(stack) },
      "[startup] Holding an internal request until route registration finishes",
    );
    let warning: NodeJS.Timeout | undefined;
    let limit: NodeJS.Timeout | undefined;
    const finishWait = () => {
      clearTimeout(warning);
      clearTimeout(limit);
      maxHeldMs = Math.max(maxHeldMs, Date.now() - heldAt);
    };
    const held = new Promise<void>((resolve, reject) => {
      warning = setTimeout(() => {
        logger.warn(
          { event: "startup.inject_held", method, url, heldMs: Date.now() - heldAt, stack },
          "[startup] An internal request is still waiting for route registration to finish",
        );
      }, warnAfterMs);
      limit = setTimeout(() => {
        finishWait();
        reject(
          new InjectDuringRegistrationError(
            `app.inject() waited ${maxHoldMs} ms for startup registration to finish and was cancelled`,
          ),
        );
      }, maxHoldMs);
      warning.unref?.();
      limit.unref?.();
      void registered.then(() => {
        finishWait();
        resolve();
      });
    });
    const run = () => {
      finishWait();
      return originalInject(...args);
    };
    if (callback) {
      held.then(
        () => {
          try {
            run();
          } catch (error) {
            callback(error);
          }
        },
        (error: unknown) => callback(error),
      );
      return undefined;
    }
    return held.then(run);
  };
  (app as unknown as { inject: typeof gatedInject }).inject = gatedInject;

  return () => {
    if (released) return;
    released = true;
    release();
    if (heldCount > 0) {
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
