import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const retryRoute = readFileSync(
  new URL("../../packages/server/src/routes/generate/retry-agents-route.ts", import.meta.url),
  "utf8",
);
const generateRoute = readFileSync(
  new URL("../../packages/server/src/routes/generate.routes.ts", import.meta.url),
  "utf8",
);
const generateUtils = readFileSync(
  new URL("../../packages/server/src/routes/generate/generate-route-utils.ts", import.meta.url),
  "utf8",
);
const recoveryHook = readFileSync(
  new URL("../../packages/client/src/hooks/use-generation-recovery.ts", import.meta.url),
  "utf8",
);
const chatArea = readFileSync(
  new URL("../../packages/client/src/components/chat/ChatArea.tsx", import.meta.url),
  "utf8",
);

const closeStart = retryRoute.indexOf("const onClientClose = () => {");
const closeEnd = retryRoute.indexOf('reply.raw.on("close", onClientClose)', closeStart);
assert.notEqual(closeStart, -1, "retry-agent close handler should exist");
assert.notEqual(closeEnd, -1, "retry-agent close handler should be registered");
const closeHandler = retryRoute.slice(closeStart, closeEnd);
assert.match(closeHandler, /clientDisconnected\s*=\s*true/u);
assert.doesNotMatch(closeHandler, /abortController\.abort\(\)/u);

const abortRouteStart = generateRoute.indexOf('app.post("/abort"');
assert.notEqual(abortRouteStart, -1, "explicit generation abort route should exist");
const abortRoute = generateRoute.slice(abortRouteStart, abortRouteStart + 2_000);
assert.match(abortRoute, /activeAgentRuns/u, "explicit abort must include agent-only runs");
assert.match(abortRoute, /controller\.abort\(\)/u, "explicit abort must still cancel controllers");
const passiveAbortStart = generateUtils.indexOf("export function shouldAbortOnPassiveGenerationDisconnect");
assert.notEqual(passiveAbortStart, -1, "passive disconnect helper should exist");
const passiveAbortHelper = generateUtils.slice(passiveAbortStart, passiveAbortStart + 500);
assert.match(passiveAbortHelper, /return false/u, "accepted impersonation turns must survive passive disconnects");

assert.match(recoveryHook, /\/generate\/status\//u);
assert.match(recoveryHook, /setStreaming\(true/u);
assert.match(recoveryHook, /invalidateQueries\(\{ queryKey: chatKeys\.messages/u);
assert.doesNotMatch(recoveryHook, /setAbortController/u, "recovery must not fake an SSE AbortController");
assert.match(chatArea, /useGenerationRecovery\(activeChatId\)/u);

process.stdout.write("Generation recovery regression passed.\n");
