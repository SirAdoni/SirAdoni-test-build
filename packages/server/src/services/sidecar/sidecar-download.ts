import { createHash } from "crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "fs";
import { dirname } from "path";
import { Readable } from "stream";
import { pipeline as streamPipeline } from "stream/promises";
import type { SidecarDownloadProgress } from "@marinara-engine/shared";
import { sanitizeApiError } from "../llm/base-provider.js";
import { createDiagnostic } from "../../lib/diagnostics.js";
import { logEvent } from "../../lib/log-events.js";

const USER_AGENT = "MarinaraEngine";

export function isAbortError(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /abort/i.test(message);
}

export type DownloadErrorCode = "ME_DOWNLOAD_HTTP" | "ME_DOWNLOAD_SIZE" | "ME_DOWNLOAD_SHA";

/** Tags a download failure with its errorCode so the log line and the rethrown error agree. */
function downloadError(message: string, errorCode: DownloadErrorCode): Error {
  return Object.assign(new Error(message), { errorCode });
}

function errorCodeOf(error: unknown): string {
  const tagged = (error as { errorCode?: unknown } | null)?.errorCode;
  return typeof tagged === "string" ? tagged : createDiagnostic(error).code;
}

/** Host only: a download URL can carry a signed path or query, so it is never logged whole. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

export interface DownloadFileOptions {
  url: string;
  destPath: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  expectedBytes?: number | null;
  expectedSha256?: string | null;
  progress: Omit<SidecarDownloadProgress, "downloaded" | "total" | "speed" | "status">;
  onProgress?: (progress: SidecarDownloadProgress) => void;
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${sanitizeApiError(raw || response.statusText)}`);
  }

  return (await response.json()) as T;
}

export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    retries: number;
    baseDelayMs: number;
    shouldRetry?: (error: unknown) => boolean;
    /** Names the download in the retry log line. */
    label?: string;
  },
): Promise<T> {
  const shouldRetry = options.shouldRetry ?? (() => true);
  let attempt = 0;
  let lastError: unknown;

  while (attempt < options.retries) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (attempt >= options.retries || !shouldRetry(error)) {
        throw error;
      }
      const delayMs = options.baseDelayMs * 2 ** (attempt - 1);
      logEvent("warn", "sidecar.download.retry", {
        label: options.label,
        attempt,
        maxAttempts: options.retries,
        delayMs,
        errorCode: errorCodeOf(error),
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Retry failed");
}

export async function downloadFileWithProgress(options: DownloadFileOptions): Promise<void> {
  const expectedSha256 = options.expectedSha256?.trim().toLowerCase() || null;
  if (expectedSha256 && !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw new Error("Expected download SHA-256 must contain exactly 64 hexadecimal characters.");
  }
  mkdirSync(dirname(options.destPath), { recursive: true });

  const tempPath = `${options.destPath}.download`;
  try {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  } catch {
    // Best-effort cleanup for stale temp files.
  }
  // Leave any existing destination in place until the new file has been verified:
  // renameSync below replaces it atomically, so a failed or aborted download keeps it.

  const startedAt = Date.now();
  const host = hostOf(options.url);
  const label = options.progress.label;
  let downloaded = 0;
  logEvent("info", "sidecar.download.file", {
    state: "running",
    host,
    label,
    expectedBytes: options.expectedBytes ?? undefined,
    shaExpected: !!expectedSha256,
  });

  try {
    const response = await fetch(options.url, {
      signal: options.signal,
      headers: {
        "User-Agent": USER_AGENT,
        ...(options.headers ?? {}),
      },
    });

    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      throw downloadError(
        `HTTP ${response.status}: ${sanitizeApiError(raw || response.statusText)}`,
        "ME_DOWNLOAD_HTTP",
      );
    }

    if (!response.body) {
      throw downloadError("Download response had no body", "ME_DOWNLOAD_HTTP");
    }

    const total = Number.parseInt(response.headers.get("content-length") || "0", 10) || 0;
    const contentEncoding = response.headers.get("content-encoding")?.trim().toLowerCase() ?? "";
    const expectedBytes =
      typeof options.expectedBytes === "number" && options.expectedBytes > 0 ? options.expectedBytes : total;
    const canValidateSize = expectedBytes > 0 && (!contentEncoding || contentEncoding === "identity");
    const sha256 = expectedSha256 ? createHash("sha256") : null;
    let lastReportTime = Date.now();
    let lastReportBytes = 0;

    const reader = response.body.getReader();
    const writable = createWriteStream(tempPath);

    const readable = new Readable({
      async read() {
        try {
          const { done, value } = await reader.read();
          if (done) {
            this.push(null);
            return;
          }

          downloaded += value.byteLength;
          sha256?.update(value);
          const now = Date.now();
          if (now - lastReportTime >= 250) {
            const elapsedSeconds = (now - lastReportTime) / 1000;
            const speed = elapsedSeconds > 0 ? (downloaded - lastReportBytes) / elapsedSeconds : 0;
            options.onProgress?.({
              ...options.progress,
              status: "downloading",
              downloaded,
              total: total || expectedBytes,
              speed,
            });
            lastReportTime = now;
            lastReportBytes = downloaded;
          }

          this.push(value);
        } catch (error) {
          this.destroy(error as Error);
        }
      },
    });

    await streamPipeline(readable, writable);
    const writtenBytes = statSync(tempPath).size;
    if (canValidateSize && writtenBytes !== expectedBytes) {
      throw downloadError(
        `Downloaded file size mismatch: expected ${expectedBytes} bytes, received ${writtenBytes} bytes.`,
        "ME_DOWNLOAD_SIZE",
      );
    }
    if (expectedSha256) {
      const actualSha256 = sha256!.digest("hex");
      if (actualSha256 !== expectedSha256) {
        throw downloadError(
          `Downloaded file SHA-256 mismatch: expected ${expectedSha256}, received ${actualSha256}.`,
          "ME_DOWNLOAD_SHA",
        );
      }
    }
    renameSync(tempPath, options.destPath);
    options.onProgress?.({
      ...options.progress,
      status: "complete",
      downloaded: expectedBytes || writtenBytes || downloaded,
      total: expectedBytes || writtenBytes || downloaded,
      speed: 0,
    });
    logEvent("info", "sidecar.download.file", {
      outcome: "ok",
      host,
      label,
      bytes: writtenBytes,
      elapsedMs: Date.now() - startedAt,
      shaVerified: !!expectedSha256,
    });
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup on failure.
    }
    const cancelled = isAbortError(error) || options.signal?.aborted === true;
    const errorCode = cancelled ? "ME_CANCELLED" : errorCodeOf(error);
    logEvent("warn", "sidecar.download.file", {
      err: cancelled ? undefined : error,
      outcome: cancelled ? "cancelled" : "failed",
      host,
      label,
      downloadedBytes: downloaded,
      elapsedMs: Date.now() - startedAt,
      errorCode,
    });
    // Abort errors pass through untouched so callers can still recognise them.
    if (cancelled) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw Object.assign(new Error(message, { cause: error }), { errorCode });
  }
}
