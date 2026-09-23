import type { SidecarDownloadProgress } from "@marinara-engine/shared";
import { api } from "./api-client";

export type SidecarDownloadEvent = Partial<SidecarDownloadProgress> & {
  done?: boolean;
  status?: string;
  error?: string;
};

interface ConsumeSidecarDownloadStreamOptions {
  path: string;
  body: unknown;
  signal: AbortSignal;
  failureLabel: string;
  onEvent: (event: SidecarDownloadEvent) => boolean | Promise<boolean>;
}

function responseErrorDetail(text: string, fallback: string): string {
  let detail = text.slice(0, 300) || fallback || "unknown error";
  try {
    const parsed = JSON.parse(text) as { error?: string; message?: string };
    detail = parsed.error ?? parsed.message ?? detail;
  } catch {
    // Keep the bounded plain-text detail.
  }
  return detail;
}

/** Consume the sidecar's newline-delimited SSE response through one parser. */
export async function consumeSidecarDownloadStream({
  path,
  body,
  signal,
  failureLabel,
  onEvent,
}: ConsumeSidecarDownloadStreamOptions): Promise<void> {
  const apiPath = path.startsWith("/api/") ? path.slice(4) : path;
  const response = await api.raw(apiPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${failureLabel} (${response.status}): ${responseErrorDetail(text, response.statusText)}`);
  }
  if (!response.body) {
    throw new Error(`${failureLabel} (${response.status}): missing response body`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? "" : (lines.pop() ?? "");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trimStart();
      let event: SidecarDownloadEvent;
      try {
        event = JSON.parse(payload) as SidecarDownloadEvent;
      } catch {
        continue;
      }
      if (await onEvent(event)) return;
    }
    if (done) return;
  }
}
