import assert from "node:assert/strict";

// Settings > Features "Send client error reports" (ui.store clientErrorReports, client only). ON
// (default) is today: main.tsx installs the window error listeners and reports reach the sender.
// OFF is upstream: the listeners are never installed and nothing is queued or sent.
const listeners = new Map<string, Array<(event: unknown) => void>>();
const storage = new Map<string, string>();
const fakeWindow = {
  location: { pathname: "/chat", origin: "http://localhost" },
  addEventListener: (type: string, listener: (event: unknown) => void) => {
    listeners.set(type, [...(listeners.get(type) ?? []), listener]);
  },
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
};
Object.assign(globalThis, {
  window: fakeWindow,
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  },
});

const diagnostics = await import("../../packages/client/src/lib/client-diagnostics.js");
const sent: string[] = [];
await diagnostics.configureClientDiagnosticSender(async (record) => {
  sent.push(record.message);
  return true;
});

// OFF = upstream
diagnostics.applyClientErrorReportsSetting(false);
assert.equal(listeners.size, 0, "OFF: no window listeners are installed");
await diagnostics.reportClientDiagnostic({ kind: "error", message: "Tamsin broke the lamp" });
assert.deepEqual(sent, [], "OFF: nothing is sent");
assert.equal(storage.size, 0, "OFF: nothing is queued");

// ON = today
diagnostics.applyClientErrorReportsSetting(true);
assert.ok(listeners.has("error") && listeners.has("unhandledrejection"), "ON: error listeners installed");
// Let the install-time flush of the (empty) queue settle first.
await new Promise((resolve) => setTimeout(resolve, 10));
await diagnostics.reportClientDiagnostic({ kind: "error", message: "Ysolde dropped the key" });
assert.deepEqual(sent, ["Ysolde dropped the key"], "ON: the report reaches the sender");
diagnostics.applyClientErrorReportsSetting(true);
assert.equal(listeners.get("error")?.length, 1, "switching on twice installs once");

// Switching off after install drops reports from the already installed listeners.
diagnostics.applyClientErrorReportsSetting(false);
listeners.get("error")![0]!({ error: new Error("after off"), message: "after off" });
await new Promise((resolve) => setTimeout(resolve, 10));
assert.deepEqual(sent, ["Ysolde dropped the key"], "OFF after ON: nothing more is sent");

console.log("feature-switch-client-error-reports regression passed");
