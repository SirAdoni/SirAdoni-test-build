import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = await mkdtemp(join(tmpdir(), "marinara-image-inspection-"));
process.env.DATA_DIR = dataDir;

const { captureImageRequestInspection } = await import(
  "../../packages/server/src/services/image/image-request-inspection.js"
);

try {
  const bytes = Buffer.from([0, 1, 2, 3, 250, 251]);
  const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
  const body = {
    model: "gpt-image-test",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "first" }, { type: "input_image", image_url: dataUrl }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "second" }] },
    ],
    headers: { Authorization: "Bearer must-not-appear" },
    customParameters: {
      "x-api-key": "nested-api-key-must-not-appear",
      nested: [{ "x-access-token": "nested-access-token-must-not-appear" }],
      tokenCount: 42,
    },
  };
  const handle = await captureImageRequestInspection({ endpointPath: "/images/edits", model: "gpt-image-test", body });
  assert(handle);
  await handle.complete(new Response(null, { status: 200, headers: { "x-request-id": "provider-test-request" } }));
  const manifestPath = join(handle.capturePath, "manifest.json");
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText) as any;
  assert.equal(manifest.status, "completed");
  assert.equal(manifest.endpointPath, "/images/edits");
  assert.equal(manifest.provider.requestId, "provider-test-request");
  assert.equal(manifest.request.input[0].content[0].text, "first");
  assert.equal(manifest.request.input[1].content[0].text, "second");
  assert.equal(manifest.request.headers, "[REDACTED]");
  assert.equal(manifest.request.customParameters["x-api-key"], "[REDACTED]");
  assert.equal(manifest.request.customParameters.nested[0]["x-access-token"], "[REDACTED]");
  assert.equal(manifest.request.customParameters.tokenCount, 42);
  const reference = manifest.request.input[0].content[1].image_url;
  assert.equal(reference.relativeFilename, "reference-01.png");
  assert.equal(reference.mime, "image/png");
  assert.equal(reference.byteCount, bytes.byteLength);
  assert.equal(reference.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert(!manifestText.includes(dataUrl));
  assert(!manifestText.includes("must-not-appear"));
  assert(!manifestText.includes("nested-api-key-must-not-appear"));
  assert(!manifestText.includes("nested-access-token-must-not-appear"));
  assert.deepEqual(await readFile(join(handle.capturePath, reference.relativeFilename)), bytes);

  const failed = await captureImageRequestInspection({ endpointPath: "/responses", model: "gpt-image-test", body: { prompt: "failure" } });
  assert(failed);
  await failed.fail(new Error("fixture provider rejection"), new Response(null, { status: 400 }));
  assert.equal(JSON.parse(await readFile(join(failed.capturePath, "manifest.json"), "utf8")).status, "failed");

  const active = await captureImageRequestInspection({ endpointPath: "/responses", body: { prompt: "active" } });
  assert(active);
  await Promise.all(
    Array.from({ length: 24 }, async (_, index) => {
      const item = await captureImageRequestInspection({ endpointPath: "/responses", body: { prompt: randomUUID() } });
      assert(item);
      if (index % 2) await item.fail(new Error("fixture failure"));
      else await item.complete();
    }),
  );
  const folders = await readdir(join(dataDir, "logs", "image-requests"));
  assert(folders.includes(active.capturePath.split(/[/\\]/).pop()!));
  const terminal = await Promise.all(
    folders.map(async (folder) =>
      JSON.parse(await readFile(join(dataDir, "logs", "image-requests", folder, "manifest.json"), "utf8")),
    ),
  );
  assert(terminal.filter((item) => item.status === "completed" || item.status === "failed").length <= 20);
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

process.stdout.write("Image request inspection regression passed: exact references, ordered body text, secret exclusion, terminal status, retention, and active capture preservation.\n");
