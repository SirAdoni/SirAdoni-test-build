import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { DATA_DIR } from "../../utils/data-dir.js";
import { getDiagnosticContext, sanitizeDiagnosticText } from "../../lib/diagnostics.js";
import { logger } from "../../lib/logger.js";

const CAPTURE_ROOT = resolve(DATA_DIR, "logs", "image-requests");
const MAX_COMPLETED_CAPTURES = 20;
const MAX_REFERENCE_IMAGES = 20;
const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i;
const SECRET_KEY_RE =
  /(?:authorization|cookie|setcookie|password|passwd|secret|apikey|accesskey|accesstoken|privatekey|credential|jwt|bearer|token|headers?)$/i;
let retentionTail: Promise<void> = Promise.resolve();

export interface ImageRequestInspectionHandle {
  capturePath: string;
  complete(response?: Response): Promise<void>;
  fail(error: unknown, response?: Response): Promise<void>;
}

type CaptureManifest = {
  version: 1;
  status: "started" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  endpointPath: string;
  model?: string;
  diagnostic?: Record<string, string | number>;
  request: unknown;
  provider?: { status?: number; requestId?: string; error?: string };
};

function insideRoot(path: string): string {
  const root = resolve(CAPTURE_ROOT);
  const candidate = resolve(path);
  const rel = relative(root, candidate);
  if (candidate !== root && (!rel || rel.startsWith("..") || isAbsolute(rel))) {
    throw new Error("Image request inspection path escaped its fixed root");
  }
  return candidate;
}

function extensionForMime(mime: string): string {
  const subtype = mime.split("/", 2)[1]?.toLowerCase() ?? "bin";
  return subtype === "jpeg" ? "jpg" : subtype.replace(/[^a-z0-9]+/g, "") || "bin";
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key.replace(/[^a-z0-9]/gi, ""));
}

function providerRequestId(response?: Response): string | undefined {
  const value = response?.headers.get("x-request-id") ?? response?.headers.get("request-id");
  return value?.trim() || undefined;
}

function providerStatus(error: unknown, response?: Response): number | undefined {
  const value =
    response?.status ?? (error as { status?: unknown })?.status ?? (error as { statusCode?: unknown })?.statusCode;
  return Number.isInteger(value) ? Number(value) : undefined;
}

function diagnosticIdentifiers(): Record<string, string | number> | undefined {
  const context = getDiagnosticContext();
  const allowed = [
    "requestId",
    "operationId",
    "operation",
    "stage",
    "chatId",
    "messageId",
    "jobId",
    "provider",
    "model",
    "connectionId",
    "attempt",
  ] as const;
  const result: Record<string, string | number> = {};
  for (const key of allowed) {
    const value = context[key];
    if (typeof value === "string" || typeof value === "number") result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const target = insideRoot(path);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(insideRoot(temporary), content, "utf8");
  await rename(temporary, target);
}

async function replaceDataUrls(value: unknown, folder: string, references: [number]): Promise<unknown> {
  if (typeof value === "string") {
    const match = value.match(DATA_URL_RE);
    if (!match) return value;
    if (++references[0] > MAX_REFERENCE_IMAGES) throw new Error("Image request contains too many reference images");
    const mime = match[1]!.toLowerCase();
    const bytes = Buffer.from(match[2]!.replace(/\s+/g, ""), "base64");
    const filename = `reference-${String(references[0]).padStart(2, "0")}.${extensionForMime(mime)}`;
    const path = insideRoot(join(folder, filename));
    await writeFile(path, bytes);
    return {
      relativeFilename: relative(folder, path).replace(/\\/g, "/"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mime,
      byteCount: bytes.byteLength,
    };
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) result.push(await replaceDataUrls(item, folder, references));
    return result;
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = isSecretKey(key) ? "[REDACTED]" : await replaceDataUrls(item, folder, references);
    }
    return result;
  }
  return value;
}

async function pruneCompletedCaptures(): Promise<void> {
  const entries = await readdir(CAPTURE_ROOT, { withFileTypes: true }).catch(() => []);
  const completed: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = insideRoot(join(CAPTURE_ROOT, entry.name));
    try {
      const manifest = JSON.parse(await readFile(join(folder, "manifest.json"), "utf8")) as CaptureManifest;
      if (manifest.status !== "completed" && manifest.status !== "failed") continue;
      completed.push({ path: folder, mtimeMs: (await stat(folder)).mtimeMs });
    } catch {
      // Incomplete or damaged folders remain available for diagnosis.
    }
  }
  completed.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const item of completed.slice(MAX_COMPLETED_CAPTURES)) {
    // Retention only removes terminal capture folders; active captures survive.
    const manifest = JSON.parse(await readFile(join(item.path, "manifest.json"), "utf8")) as CaptureManifest;
    if (
      (manifest.status === "completed" || manifest.status === "failed") &&
      /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(basename(item.path))
    )
      await rm(item.path, { recursive: true, force: true });
  }
}

function scheduleRetention(): Promise<void> {
  retentionTail = retentionTail.then(pruneCompletedCaptures, pruneCompletedCaptures);
  return retentionTail;
}

export async function captureImageRequestInspection(args: {
  endpointPath: string;
  model?: string;
  body: unknown;
}): Promise<ImageRequestInspectionHandle | null> {
  const createdAt = new Date().toISOString();
  const folder = insideRoot(join(CAPTURE_ROOT, `${Date.now()}-${randomUUID()}`));
  try {
    await mkdir(folder, { recursive: true });
    const manifest: CaptureManifest = {
      version: 1,
      status: "started",
      createdAt,
      updatedAt: createdAt,
      endpointPath: args.endpointPath,
      ...(args.model ? { model: args.model } : {}),
      ...(diagnosticIdentifiers() ? { diagnostic: diagnosticIdentifiers() } : {}),
      request: await replaceDataUrls(args.body, folder, [0]),
    };
    const manifestPath = join(folder, "manifest.json");
    await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const update = async (status: "completed" | "failed", response?: Response, error?: unknown) => {
      try {
        const current = JSON.parse(await readFile(manifestPath, "utf8")) as CaptureManifest;
        current.status = status;
        current.updatedAt = new Date().toISOString();
        const requestId = providerRequestId(response);
        const statusCode = providerStatus(error, response);
        if (requestId || statusCode !== undefined || error !== undefined) {
          current.provider = {
            ...(statusCode !== undefined ? { status: statusCode } : {}),
            ...(requestId ? { requestId } : {}),
            ...(error !== undefined
              ? { error: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)) }
              : {}),
          };
        }
        await atomicWrite(manifestPath, `${JSON.stringify(current, null, 2)}\n`);
        await scheduleRetention();
      } catch (captureError) {
        // Inspection must never change the provider failure boundary.
        throw captureError;
      }
    };
    const safeUpdate = async (status: "completed" | "failed", response?: Response, error?: unknown) => {
      try {
        await update(status, response, error);
      } catch (updateError) {
        logger.warn(
          updateError,
          "[image-gen/inspection] Could not update capture %s; provider result remains authoritative",
          folder,
        );
      }
    };
    return {
      capturePath: folder,
      complete: async (response) => safeUpdate("completed", response),
      fail: async (error, response) => safeUpdate("failed", response, error),
    };
  } catch (error) {
    logger.warn(error, "[image-gen/inspection] Could not capture image request inspection at %s", folder);
    return null;
  }
}
