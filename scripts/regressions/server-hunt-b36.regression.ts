import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Batch 36: image-generation.ts (sharp loader race, ComfyUI placeholder substitution,
// ComfyUI prompt cancel on abort) and openai-chatgpt-image.ts (SSE frame reader).

const dataDir = mkdtempSync(join(tmpdir(), "marinara-b36-"));
process.env.DATA_DIR = dataDir;
process.env.LOG_LEVEL = "silent";

const imageGenerationSource = readFileSync(
  new URL("../../packages/server/src/services/image/image-generation.ts", import.meta.url),
  "utf8",
);

// ── 1. sharp loader memoises the in-flight import (private function, so source-level check) ──
assert.ok(
  !imageGenerationSource.includes("_sharpLoadAttempted"),
  "tryLoadSharp must not return early on a 'load attempted' flag while the import is still pending",
);
assert.match(imageGenerationSource, /_sharpPromise \?\?=/, "tryLoadSharp must memoise the in-flight load promise");

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// ── Fake ComfyUI backend ──
type Mode = "complete" | "running" | "pending";
let mode: Mode = "complete";
let promptCounter = 0;
let currentPromptId = "";
const queuedWorkflows: unknown[] = [];
const interrupts: unknown[] = [];
const queueDeletes: unknown[] = [];

const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const url = request.url ?? "";
    response.setHeader("Content-Type", "application/json");
    if (request.method === "POST" && url === "/prompt") {
      queuedWorkflows.push(JSON.parse(body).prompt);
      currentPromptId = `pid-${++promptCounter}`;
      response.end(JSON.stringify({ prompt_id: currentPromptId }));
      return;
    }
    if (request.method === "GET" && url.startsWith("/history/")) {
      if (mode !== "complete") {
        response.end("{}");
        return;
      }
      response.end(
        JSON.stringify({
          [currentPromptId]: {
            status: { status_str: "success", completed: true },
            outputs: { "9": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } },
          },
        }),
      );
      return;
    }
    if (request.method === "GET" && url.startsWith("/view")) {
      response.setHeader("Content-Type", "image/png");
      response.end(Buffer.from(png, "base64"));
      return;
    }
    if (request.method === "GET" && url === "/queue") {
      const running = mode === "running" ? [[0, currentPromptId, {}, {}, []]] : [];
      const pending = mode === "pending" ? [[1, currentPromptId, {}, {}, []]] : [];
      response.end(JSON.stringify({ queue_running: running, queue_pending: pending }));
      return;
    }
    if (request.method === "POST" && url === "/interrupt") {
      interrupts.push(body ? JSON.parse(body) : {});
      response.end("{}");
      return;
    }
    if (request.method === "POST" && url === "/queue") {
      queueDeletes.push(JSON.parse(body));
      response.end("{}");
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

try {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const { generateImage } = await import("../../packages/server/src/services/image/image-generation.js");
  const customWorkflow = JSON.stringify({
    "6": { class_type: "CLIPTextEncode", inputs: { text: "score_9, %prompt%, masterpiece", clip: ["4", 1] } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0] } },
  });
  const generate = (prompt: string, signal?: AbortSignal) =>
    generateImage("comfyui", base, "", "comfyui", {
      prompt,
      model: "fixture.safetensors",
      comfyWorkflow: customWorkflow,
      allowLocalUrls: true,
      signal,
    });

  // ── 2. Placeholder substitution: no "$" pattern expansion, no re-scan of inserted text ──
  mode = "complete";
  const tricky = "costs $$5 and $& then $' and %seed% literal";
  const result = await generate(tricky);
  assert.equal(result.base64, png);
  const posted = queuedWorkflows.at(-1) as Record<string, { inputs: { text?: string } }>;
  const text = posted["6"]!.inputs.text!;
  assert.ok(text.startsWith("score_9, "), `unexpected text ${text}`);
  assert.ok(text.endsWith(", masterpiece"), `unexpected text ${text}`);
  assert.ok(
    text.includes("costs $$5 and $& then $' and %seed% literal"),
    `prompt text must be inserted verbatim, got: ${text}`,
  );
  assert.ok(!text.includes("%prompt%"), "the %prompt% placeholder itself must be replaced");

  // ── 3. Aborting a running ComfyUI prompt interrupts it on the backend ──
  mode = "running";
  const runningController = new AbortController();
  const runningAttempt = generate("a running prompt", runningController.signal);
  setTimeout(() => runningController.abort(new Error("caller cancelled")), 1300);
  await assert.rejects(runningAttempt);
  assert.ok(await waitFor(() => interrupts.length > 0, 4000), "an aborted running prompt must be interrupted");
  assert.equal(queueDeletes.length, 0, "a running prompt is interrupted, not deleted from the queue");

  // ── 4. Aborting a still-pending ComfyUI prompt deletes it from the queue, without /interrupt ──
  mode = "pending";
  const interruptsBefore = interrupts.length;
  const pendingController = new AbortController();
  const pendingAttempt = generate("a pending prompt", pendingController.signal);
  setTimeout(() => pendingController.abort(new Error("caller cancelled")), 1300);
  await assert.rejects(pendingAttempt);
  assert.ok(await waitFor(() => queueDeletes.length > 0, 4000), "an aborted pending prompt must be deleted");
  assert.deepEqual(queueDeletes.at(-1), { delete: [currentPromptId] });
  assert.equal(interrupts.length, interruptsBefore, "a pending prompt must not trigger a global /interrupt");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

// ── 5. ChatGPT SSE reader still finds frames whose separator is split across chunks ──
{
  const { readChatGPTImageSse } = await import("../../packages/server/src/services/image/openai-chatgpt-image.js");
  const bigResult = "QUJD".repeat(20_000);
  const events = [
    { type: "response.created" },
    {
      type: "response.output_item.done",
      item: { type: "image_generation_call", status: "completed", result: bigResult },
    },
  ];
  for (const separator of ["\n\n", "\r\n\r\n"]) {
    const text = events.map((event) => `data: ${JSON.stringify(event)}${separator}`).join("");
    // Split the transcript into small chunks, including one boundary inside every separator.
    const pieces: string[] = [];
    for (let index = 0; index < text.length; index += 13) pieces.push(text.slice(index, index + 13));
    let pieceIndex = 0;
    let pulled = 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pieceIndex >= pieces.length) {
          // Never close: the reader must return as soon as the image frame completes.
          return new Promise(() => undefined);
        }
        pulled++;
        controller.enqueue(encoder.encode(pieces[pieceIndex++]!));
      },
    });
    const image = await readChatGPTImageSse(new Response(stream));
    assert.equal(image.base64, bigResult, `image frame must be parsed with separator ${JSON.stringify(separator)}`);
    assert.ok(pulled > 1000, "fixture must deliver the frame in many chunks");
  }

  const chatgptSource = readFileSync(
    new URL("../../packages/server/src/services/image/openai-chatgpt-image.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    !/pendingFrames\s*\+=\s*chunk;\s*const frames = pendingFrames\.split/.test(chatgptSource),
    "the SSE reader must not re-split the whole pending frame on every chunk",
  );
}

rmSync(dataDir, { recursive: true, force: true });
console.log("server-hunt-b36 regression passed");
process.exit(0);
