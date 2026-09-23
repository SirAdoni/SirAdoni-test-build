import assert from "node:assert/strict";
import Fastify from "../../packages/server/node_modules/fastify/fastify.js";

const { GENERATE_STATUS_RATE_LIMIT, rateLimitHook, resetRateLimitBucketsForTests } =
  await import("../../packages/server/src/middleware/rate-limit.js");

const app = Fastify();
app.addHook("onRequest", rateLimitHook);
app.get("/api/generate/status/:chatId", async () => ({ active: false }));
app.post("/api/generate", async () => ({ ok: true }));

try {
  for (let i = 0; i < 60; i += 1) {
    const response = await app.inject({ method: "POST", url: "/api/generate", payload: {} });
    assert.equal(response.statusCode, 200, `POST generation request ${i + 1} remains within its limit`);
  }
  const rejectedPost = await app.inject({ method: "POST", url: "/api/generate", payload: {} });
  assert.equal(rejectedPost.statusCode, 429, "POST generation remains capped at 60/minute");

  resetRateLimitBucketsForTests();
  for (let i = 0; i < 60; i += 1) {
    const response = await app.inject({ method: "GET", url: "/api/generate/status/chat-1" });
    assert.equal(response.statusCode, 200, `status poll ${i + 1} remains independent of POST quota`);
  }
  const postAfterStatusPolls = await app.inject({ method: "POST", url: "/api/generate", payload: {} });
  assert.equal(postAfterStatusPolls.statusCode, 200, "status polling does not consume POST generation quota");
  assert.equal(postAfterStatusPolls.headers["ratelimit-limit"], "60");

  resetRateLimitBucketsForTests();
  for (let i = 0; i < GENERATE_STATUS_RATE_LIMIT.max; i += 1) {
    const response = await app.inject({ method: "GET", url: "/api/generate/status/chat-1" });
    assert.equal(response.statusCode, 200, `status request ${i + 1} remains within its bounded limit`);
  }
  const rejectedStatus = await app.inject({ method: "GET", url: "/api/generate/status/chat-1" });
  assert.equal(rejectedStatus.statusCode, 429, "status polling still has an independent bounded limit");
} finally {
  await app.close();
  resetRateLimitBucketsForTests();
}

console.info("Generate status rate-limit regression passed.");
