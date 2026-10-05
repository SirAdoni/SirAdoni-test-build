import assert from "node:assert/strict";
import { runAppUpdateRefresh } from "../../packages/client/src/lib/app-update-prompt.js";

const storage = new Map<string, string>();
const session = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
};
Object.assign(globalThis, {
  sessionStorage: session,
  window: {
    location: { href: "https://app.test/" },
    setTimeout,
    clearTimeout,
  },
});

const immediateWait = async () => undefined;
const runCase = async (refresh: () => void | Promise<void>, suffix: string) => {
  (window.location as { href: string }).href = "https://app.test/" + suffix;
  let fallbackCount = 0;
  await runAppUpdateRefresh(refresh, {
    operationTimeoutMs: 0,
    activationDelayMs: 0,
    wait: immediateWait,
    fallback: () => {
      fallbackCount += 1;
    },
  });
  return fallbackCount;
};

assert.equal(await runCase(() => undefined, "noop"), 1, "a resolving no-op falls back to one reload");
assert.equal(await runCase(() => undefined, "retry"), 1, "a later explicit retry remains allowed");
assert.equal(await runCase(() => Promise.reject(new Error("rejected")), "reject"), 1, "a rejected update falls back");
assert.equal(await runCase(() => new Promise<void>(() => undefined), "pending"), 1, "a pending update times out once");

const order: string[] = [];
await runAppUpdateRefresh(
  () => {
    order.push("refresh");
  },
  {
    operationTimeoutMs: 100,
    activationDelayMs: 17,
    wait: async (milliseconds) => {
      order.push("activation");
      assert.equal(milliseconds, 17);
    },
    fallback: () => {
      order.push("fallback");
    },
  },
);
assert.deepEqual(order, ["refresh", "activation", "fallback"], "activation delay precedes fallback");

let resolveLate!: () => void;
let lateSettled = false;
let lateNavigations = 0;
let delayedFallbacks = 0;
const delayed = runAppUpdateRefresh(
  () =>
    new Promise<void>((resolve) => {
      resolveLate = () => {
        lateSettled = true;
        lateNavigations += 1;
        (window.location as { href: string }).href = "https://app.test/late-callback";
        resolve();
      };
    }),
  { operationTimeoutMs: 0, activationDelayMs: 0, wait: immediateWait, fallback: () => (delayedFallbacks += 1) },
);
await delayed;
assert.equal(lateSettled, false, "the helper returns after timeout without cancelling the callback");
resolveLate();
await Promise.resolve();
assert.equal(lateSettled, true, "the original callback may settle later");
assert.equal(lateNavigations, 1, "a late callback may still navigate after timeout");
assert.equal(delayedFallbacks, 1, "late settlement does not trigger another helper fallback");

let attempts = 0;
let fallbackAttempts = 0;
await runAppUpdateRefresh(
  () => {
    attempts += 1;
  },
  {
    activationDelayMs: 0,
    wait: immediateWait,
    fallback: () => {
      fallbackAttempts += 1;
      throw new Error("reload blocked");
    },
  },
);
assert.equal(attempts, 1);
assert.equal(fallbackAttempts, 1, "a throwing fallback is attempted once without recursion");
await runAppUpdateRefresh(
  () => {
    attempts += 1;
  },
  { activationDelayMs: 0, wait: immediateWait, fallback: () => (fallbackAttempts += 1) },
);
assert.equal(attempts, 2, "fallback failure releases the single-flight guard for a later retry");
assert.equal(fallbackAttempts, 2);

let rejectLate!: (reason: unknown) => void;
let rejectedFallbacks = 0;
let unhandledRejections = 0;
const recordUnhandled = () => {
  unhandledRejections += 1;
};
process.on("unhandledRejection", recordUnhandled);
const lateRejection = runAppUpdateRefresh(
  () =>
    new Promise<void>((_, reject) => {
      rejectLate = () => reject(new Error("late rejection"));
    }),
  { operationTimeoutMs: 0, activationDelayMs: 0, wait: immediateWait, fallback: () => (rejectedFallbacks += 1) },
);
await lateRejection;
rejectLate(new Error("late rejection"));
await new Promise<void>((resolve) => setTimeout(resolve, 0));
process.off("unhandledRejection", recordUnhandled);
assert.equal(rejectedFallbacks, 1, "a late rejection does not repeat the fallback");
assert.equal(unhandledRejections, 0, "the timed-out callback's late rejection is handled");

let calls = 0;
let fallbacks = 0;
const pending = runAppUpdateRefresh(
  () => {
    calls += 1;
    return new Promise<void>(() => undefined);
  },
  { operationTimeoutMs: 0, activationDelayMs: 0, wait: immediateWait, fallback: () => (fallbacks += 1) },
);
const duplicate = runAppUpdateRefresh(
  () => {
    calls += 1;
  },
  { operationTimeoutMs: 0, activationDelayMs: 0, wait: immediateWait, fallback: () => (fallbacks += 1) },
);
await Promise.all([pending, duplicate]);
assert.equal(calls, 1, "single-flight invokes the update callback once");
assert.equal(fallbacks, 1, "single-flight performs one fallback");

await runAppUpdateRefresh(
  () => {
    calls += 1;
  },
  { activationDelayMs: 0, wait: immediateWait, fallback: () => (fallbacks += 1) },
);
assert.equal(calls, 2, "a completed timeout releases the guard for a later retry");
assert.equal(fallbacks, 2);

console.info(
  "App update prompt regression passed: no-op, rejection, timeout, activation ordering, late resolve/rejection, fallback failure, retry, and single-flight.",
);
