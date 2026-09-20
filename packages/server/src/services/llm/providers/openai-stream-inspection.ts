import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getDataDir } from "../../../config/runtime-config.js";

export const OPENAI_EMPTY_STREAM_CAPTURE_MAX_BYTES = 2 * 1024 * 1024;
const OPENAI_EMPTY_STREAM_CAPTURE_KEEP = 10;

export type OpenAIEmptyStreamCapture = {
  requestBody: string;
  requestBodyBytes: number;
  requestBodyTruncated: boolean;
  rawStream: string;
  rawStreamBytes: number;
  truncated: boolean;
  status: number;
  model: string;
  contentType: string | null;
  requestId: string | null;
};

const captureDirectory = () => join(getDataDir(), "logs", "llm-empty");

/** Keep the diagnostic bounded even when a provider never terminates its stream. */
export function appendOpenAIStreamCaptureChunk(
  current: string,
  chunk: string,
  maxBytes = OPENAI_EMPTY_STREAM_CAPTURE_MAX_BYTES,
): { value: string; bytes: number; truncated: boolean } {
  const currentBytes = Buffer.byteLength(current, "utf8");
  const chunkBytes = Buffer.byteLength(chunk, "utf8");
  const remaining = Math.max(0, maxBytes - currentBytes);
  if (chunkBytes <= remaining) return { value: current + chunk, bytes: currentBytes + chunkBytes, truncated: false };
  if (remaining === 0) return { value: current, bytes: currentBytes, truncated: true };
  const bytes = Buffer.from(chunk, "utf8").subarray(0, remaining);
  // Do not let a split UTF-8 code point make the persisted value exceed the cap.
  let prefix = bytes.toString("utf8");
  while (Buffer.byteLength(prefix, "utf8") > remaining) prefix = prefix.slice(0, -1);
  return { value: current + prefix, bytes: currentBytes + Buffer.byteLength(prefix, "utf8"), truncated: true };
}

export async function persistOpenAIEmptyStreamCapture(capture: OpenAIEmptyStreamCapture): Promise<string> {
  const directory = captureDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = `openai-empty-stream-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json`;
  const path = join(directory, filename);
  await writeFile(path, `${JSON.stringify(capture, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const entries = await readdir(directory, { withFileTypes: true });
  const captures = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith("openai-empty-stream-") && entry.name.endsWith(".json"))
    .map((entry) => join(directory, entry.name))
    .sort((left, right) => right.localeCompare(left));
  await Promise.all(
    captures.slice(OPENAI_EMPTY_STREAM_CAPTURE_KEEP).map(async (entry) => {
      try {
        await unlink(entry);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }),
  );
  return path;
}
