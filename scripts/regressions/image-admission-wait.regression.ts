import assert from "node:assert/strict";
import {
  BackgroundConnectionBusyError,
  beginForegroundConnection,
  resetConnectionAdmissionForTests,
  tryBackgroundConnection,
  waitForImageConnection,
  withConnectionAdmission,
} from "../../packages/server/src/services/generation/connection-admission.js";

resetConnectionAdmissionForTests();
const release = beginForegroundConnection("image");
assert.deepEqual(tryBackgroundConnection("image", new Date()), {
  acquired: false,
  reason: "foreground",
  retryAfterMs: 1000,
});
release();
const cooldown = tryBackgroundConnection("image", new Date());
assert.equal(cooldown.acquired, false);
if (!cooldown.acquired) assert.equal(cooldown.reason, "cooldown");
resetConnectionAdmissionForTests();
const first = tryBackgroundConnection("image", new Date(), "first");
assert.ok(first.acquired);
let calls = 0;
const result = waitForImageConnection(() =>
  withConnectionAdmission("image", { kind: "background", groupId: "second" }, async () => {
    calls++;
    return "image bytes";
  }),
);
setTimeout(() => first.release("completed"), 10);
assert.equal(await result, "image bytes");
assert.equal(calls, 1, "provider is called once, only after admission");

let attempts = 0;
const badPrompt = new Error("Provider rejected prompt");
await assert.rejects(
  waitForImageConnection(async () => {
    attempts++;
    throw badPrompt;
  }),
  (error) => error === badPrompt,
);
assert.equal(attempts, 1, "provider failures must not be retried by the admission loop");
const abort = new AbortController();
const waiting = waitForImageConnection(async () => {
  throw new BackgroundConnectionBusyError("image");
}, abort.signal);
abort.abort();
await assert.rejects(waiting, { name: "AbortError" });
await assert.rejects(
  waitForImageConnection(
    async () => {
      throw new BackgroundConnectionBusyError("image");
    },
    undefined,
    0,
  ),
  /could not start after waiting/,
);
await assert.rejects(
  waitForImageConnection(async () => {
    throw new BackgroundConnectionBusyError("image", "quarantined", 3600000);
  }),
  /60 minutes remaining/,
);
console.info(
  "Image admission: waits, calls provider once, cancels, bounds waiting, preserves real failures and explains cooldowns.",
);
