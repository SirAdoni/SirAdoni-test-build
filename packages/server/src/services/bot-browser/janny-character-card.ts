import { MAX_FILE_SIZES } from "@marinara-engine/shared";
import { isAllowedImageBuffer, safeFetch, type SafeFetchOptions } from "../../utils/security.js";

const JANNY_DOWNLOAD_API = "https://api.jannyai.com/api/v1/download";
const JANNY_DOWNLOAD_RESPONSE_MAX_BYTES = 128 * 1024;

type JannyFetch = (url: string | URL, options?: SafeFetchOptions) => Promise<Response>;

interface JannyDownloadResponse {
  status?: unknown;
  downloadUrl?: unknown;
  error?: unknown;
}

export interface JannyCharacterCardDownload {
  buffer: Buffer;
  mimeType: "image/png";
}

function readDownloadUrl(payload: unknown): URL {
  const result =
    payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as JannyDownloadResponse) : null;
  if (result?.status !== "ok" || typeof result.downloadUrl !== "string" || !result.downloadUrl.trim()) {
    const upstreamError = typeof result?.error === "string" ? result.error.trim() : "";
    throw new Error(upstreamError || "JannyAI did not return a character-card download");
  }

  let downloadUrl: URL;
  try {
    downloadUrl = new URL(result.downloadUrl);
  } catch {
    throw new Error("JannyAI returned an invalid character-card download URL");
  }
  if (downloadUrl.protocol !== "https:") {
    throw new Error("JannyAI returned an insecure character-card download URL");
  }
  return downloadUrl;
}

export async function fetchJannyCharacterCard(
  characterId: string,
  options: { fetchImpl?: JannyFetch; signal?: AbortSignal } = {},
): Promise<JannyCharacterCardDownload> {
  const normalizedId = characterId.trim();
  if (!normalizedId || normalizedId.length > 256) {
    throw new Error("Invalid JannyAI character ID");
  }

  const fetchImpl = options.fetchImpl ?? safeFetch;
  const downloadResponse = await fetchImpl(JANNY_DOWNLOAD_API, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ characterId: normalizedId }),
    signal: options.signal,
    policy: {
      allowedProtocols: ["https:"],
      allowedHostnames: ["api.jannyai.com"],
      maxRedirects: 0,
    },
    maxResponseBytes: JANNY_DOWNLOAD_RESPONSE_MAX_BYTES,
    decodeCompressedResponse: true,
  });
  if (!downloadResponse.ok) {
    throw new Error(`JannyAI character-card request failed (${downloadResponse.status})`);
  }

  let payload: unknown;
  try {
    payload = await downloadResponse.json();
  } catch {
    throw new Error("JannyAI returned an invalid character-card response");
  }

  const downloadUrl = readDownloadUrl(payload);
  const cardResponse = await fetchImpl(downloadUrl, {
    headers: { Accept: "image/png,application/octet-stream;q=0.9" },
    signal: options.signal,
    policy: { allowedProtocols: ["https:"], maxRedirects: 3 },
    maxResponseBytes: MAX_FILE_SIZES.CHARACTER_CARD,
  });
  if (!cardResponse.ok) {
    throw new Error(`JannyAI character-card download failed (${cardResponse.status})`);
  }

  const buffer = Buffer.from(await cardResponse.arrayBuffer());
  const image = isAllowedImageBuffer(buffer);
  if (image?.mimeType !== "image/png") {
    throw new Error("JannyAI returned an invalid PNG character card");
  }
  return { buffer, mimeType: "image/png" };
}
