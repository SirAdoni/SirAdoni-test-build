import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAIProvider } from "../../packages/server/src/services/llm/providers/openai.provider.js";
import {
  appendOpenAIStreamCaptureChunk,
  persistOpenAIEmptyStreamCapture,
} from "../../packages/server/src/services/llm/providers/openai-stream-inspection.js";

const originalDataDir = process.env.DATA_DIR;
const dataDir = await mkdtemp(join(tmpdir(), "marinara-openai-stream-"));
process.env.DATA_DIR = dataDir;

function sse(payloads: string[]): string {
  return payloads.map((payload) => `data: ${payload}\n\n`).join("") + "data: [DONE]\n\n";
}

let responses: string[][] = [];
const server = createServer(async (_request, response) => {
  const chunks = responses.shift() ?? [];
  response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "regression-request" });
  for (const chunk of chunks) {
    response.write(chunk);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  response.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
const provider = new OpenAIProvider(`http://127.0.0.1:${address.port}/v1`, "regression-key", undefined, undefined, undefined, "nanogpt");
const capturePath = join(dataDir, "logs", "llm-empty");
const captureFiles = async () => {
  try {
    return await readdir(capturePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

try {
  // This is the real adapter path: split one SSE frame across response reads.
  responses.push([
    'data: {"id":"x","choices":[{"delta":{"cont',
    'ent":"Ar"},"finish_reason":null}]}\n\n',
    'data: {"id":"x","choices":[{"delta":{"content":"temis"},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  const valid = await provider.chatComplete([{ role: "user", content: "hello" }], { model: "TheDrummer/Artemis-v1.1", stream: true });
  assert.equal(valid.content, "Artemis");
  assert.equal((await captureFiles()).length, 0);

  const fixturePath = process.env.OPENAI_STREAM_FIXTURE;
  if (fixturePath) {
    responses.push([await readFile(fixturePath, "utf8")]);
    const fixture = await provider.chatComplete([{ role: "user", content: "fixture" }], {
      model: "TheDrummer/Artemis-v1.1",
      stream: true,
    });
    assert.ok(fixture.content);
    assert.equal((await captureFiles()).length, 0);
  }

  responses.push([
    'data: {"id":"x","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
    'data: {"id":"x","choices":[{"delta":{"text":"unrecognized"},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  const unknown = await provider.chatComplete([{ role: "user", content: "hello" }], { model: "TheDrummer/Artemis-v1.1", stream: true });
  assert.equal(unknown.content, null);
  let files = await captureFiles();
  assert.equal(files.length, 1);
  const unknownCapture = JSON.parse(await readFile(join(capturePath, files[0]!), "utf8")) as Record<string, unknown>;
  assert.match(String(unknownCapture.rawStream), /unrecognized/);
  assert.equal(unknownCapture.status, 200);
  assert.equal(unknownCapture.requestId, "regression-request");
  assert.doesNotMatch(String(unknownCapture.requestBody), /regression-key/);

  responses.push([sse(['{"id":"x","usage":{"prompt_tokens":2,"completion_tokens":0,"total_tokens":2},"choices":[]}'])]);
  const usageOnly = await provider.chatComplete([{ role: "user", content: "hello" }], { model: "TheDrummer/Artemis-v1.1", stream: true });
  assert.equal(usageOnly.content, null);
  files = await captureFiles();
  assert.equal(files.length, 2);

  for (let index = 0; index < 11; index += 1) {
    await persistOpenAIEmptyStreamCapture({
      requestBody: "{}",
      requestBodyBytes: 2,
      requestBodyTruncated: false,
      rawStream: `capture-${index}`,
      rawStreamBytes: 10,
      truncated: false,
      status: 200,
      model: "test",
      contentType: "text/event-stream",
      requestId: null,
    });
  }
  assert.equal((await captureFiles()).length, 10);
  const capped = appendOpenAIStreamCaptureChunk("", "😀😀", 5);
  assert.ok(Buffer.byteLength(capped.value, "utf8") <= 5);
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  await rm(dataDir, { recursive: true, force: true });
}

console.log("openai stream inspection regression passed");
