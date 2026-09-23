import {
  inferVideoSource,
  normalizeVideoGenerationProfile,
  resolveImageReferenceLimits,
  VIDEO_DEFAULTS_STORAGE_KEY,
} from "@marinara-engine/shared";
import type { ImageGenRequest } from "../image/image-generation.js";
import { resolveConnectionImageDefaults, resolveConnectionImageQuality } from "../image/image-generation-defaults.js";
import { OPENAI_CHATGPT_CODEX_BASE_URL } from "../llm/openai-chatgpt-auth.js";
import type { VideoGenerationRequest } from "../video/video-generation.js";
import { resolveBaseUrl } from "./connection-base-url.js";

const DEFAULT_ATLAS_CLOUD_VIDEO_MODEL = "google/veo3.1/text-to-video";

type ImageFallbackStore = {
  getFallbackForImageGeneration(): Promise<any | null>;
};

type VideoFallbackStore = {
  getFallbackForVideoGeneration(): Promise<any | null>;
};

export function resolveImageFallbackReferenceLimit(fallback: ImageGenRequest["fallback"] | null | undefined): number {
  if (!fallback) return 0;
  return resolveImageReferenceLimits({
    imageGenerationSource: fallback.imageGenerationSource || fallback.source,
    imageService: fallback.imageService || fallback.serviceHint,
    model: fallback.model,
    baseUrl: fallback.baseUrl,
    comfyuiWorkflow: fallback.comfyWorkflow,
    maxImageReferences: fallback.maxImageReferences,
  }).effectiveLimit;
}

export function resolveImageReferenceCollectionLimit(
  primaryLimit: number,
  fallback: ImageGenRequest["fallback"] | null | undefined,
): number {
  const normalizedPrimary = Number.isFinite(primaryLimit) ? Math.max(0, Math.trunc(primaryLimit)) : 0;
  return Math.max(normalizedPrimary, resolveImageFallbackReferenceLimit(fallback));
}

function resolveConnectionVideoDefaults(connection: { defaultParameters?: unknown }) {
  let root = connection.defaultParameters;
  if (typeof root === "string") {
    try {
      root = JSON.parse(root) as unknown;
    } catch {
      return null;
    }
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;
  return normalizeVideoGenerationProfile((root as Record<string, unknown>)[VIDEO_DEFAULTS_STORAGE_KEY]).profile;
}

export async function resolveImageConnectionFallback(
  connections: ImageFallbackStore,
  primaryConnectionId: string | null | undefined,
): Promise<NonNullable<ImageGenRequest["fallback"]> | undefined> {
  const connection = await connections.getFallbackForImageGeneration();
  if (!connection || connection.id === primaryConnectionId) return undefined;
  const model = String(connection.model ?? "").trim();
  const imageGenerationSource = String(connection.imageGenerationSource ?? "").trim();
  const imageService = String(connection.imageService ?? "").trim();
  const configuredBaseUrl = resolveBaseUrl(connection);
  const source = resolveImageReferenceLimits({
    imageGenerationSource,
    imageService,
    model,
    baseUrl: configuredBaseUrl,
    comfyuiWorkflow: connection.comfyuiWorkflow,
    maxImageReferences: connection.maxImageReferences,
  }).source;
  const baseUrl = configuredBaseUrl || (source === "openai_chatgpt" ? OPENAI_CHATGPT_CODEX_BASE_URL : "");
  if (!baseUrl) return undefined;
  return {
    connectionId: connection.id,
    connectionName: String(connection.name ?? "").trim() || connection.id,
    provider: String(connection.provider ?? "image_generation"),
    source,
    baseUrl,
    apiKey: connection.apiKey || "",
    serviceHint: String(connection.imageService ?? connection.imageGenerationSource ?? source),
    model,
    imageEndpointId: connection.imageEndpointId || undefined,
    comfyWorkflow: connection.comfyuiWorkflow || undefined,
    imageDefaults: resolveConnectionImageDefaults(connection),
    quality: resolveConnectionImageQuality(connection),
    maxImageReferences: connection.maxImageReferences ?? null,
    ...(imageGenerationSource ? { imageGenerationSource } : {}),
    ...(imageService ? { imageService } : {}),
  };
}

export async function resolveVideoConnectionFallback(
  connections: VideoFallbackStore,
  primaryConnectionId: string | null | undefined,
): Promise<NonNullable<VideoGenerationRequest["fallback"]> | undefined> {
  const connection = await connections.getFallbackForVideoGeneration();
  if (!connection || connection.id === primaryConnectionId) return undefined;
  const baseUrl = resolveBaseUrl(connection);
  if (!baseUrl) return undefined;
  const model = String(connection.model ?? "").trim();
  const explicitSource = String(connection.videoGenerationSource ?? connection.videoService ?? "").trim();
  const source = explicitSource || inferVideoSource(model, baseUrl);
  const videoDefaults = resolveConnectionVideoDefaults(connection);
  const comfyDefaults = videoDefaults?.comfyui;
  return {
    connectionId: connection.id,
    connectionName: String(connection.name ?? "").trim() || connection.id,
    source,
    baseUrl,
    apiKey: connection.apiKey || "",
    serviceHint:
      source === "swarmui" ? "swarmui" : String(connection.videoService ?? connection.videoGenerationSource ?? source),
    model,
    comfyWorkflow: connection.comfyuiWorkflow || undefined,
    comfyLoras: comfyDefaults?.loras ?? [],
    fps: comfyDefaults?.fps,
    // An Atlas Cloud request with no model runs the default model, so its saved options apply.
    atlasModelOptions: videoDefaults?.atlas.modelOptions[model || DEFAULT_ATLAS_CLOUD_VIDEO_MODEL],
  };
}
