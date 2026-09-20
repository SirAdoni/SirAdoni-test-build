// ──────────────────────────────────────────────
// Service: OpenAI ChatGPT (Codex sign-in) image generation
// ──────────────────────────────────────────────
// Generates images through the ChatGPT Codex backend using the Responses API's
// `image_generation` tool. Authentication rides the same local `codex login`
// credentials as the openai_chatgpt text provider — no API key or base URL.
//
// Backend quirks (confirmed against chatgpt.com/backend-api/codex):
//   - Requests must set `stream: true`; non-streaming requests are rejected
//     with "Stream must be set to true".
//   - The tool-level `size` parameter is accepted but ignored, so orientation
//     is steered through prompt wording. When optional image resizing support
//     is available, the caller contains the result in the requested canvas.
//   - `tool_choice: { type: "image_generation" }` is required for reliability;
//     with "auto" the model sometimes answers in prose instead of generating.

import { fetchOpenAIChatGPTModels } from "../llm/openai-chatgpt-auth.js";
import { logger } from "../../lib/logger.js";

/** Fallback when no model is configured and the live catalog is unreachable. */
export const DEFAULT_CHATGPT_IMAGE_MODEL = "gpt-5.4-mini";
export const MAX_CHATGPT_IMAGE_REFERENCES = 20;
export const MAX_CHATGPT_DIRECT_IMAGE_PROMPT_CHARS = 32_000;

export async function fitChatGPTDirectImagePrompt(
  options: ChatGPTImageRequestOptions,
  compact: (prompt: string, targetChars: number) => Promise<string>,
): Promise<ChatGPTImageRequestOptions> {
  if (!isChatGPTDirectImageModel(options.model)) return options;
  const original = chatGPTImagePromptText(options);
  if (original.length <= MAX_CHATGPT_DIRECT_IMAGE_PROMPT_CHARS) return options;
  // Compact the complete request so suffix constraints are retained too. The
  // result becomes the sole prompt; image options/references remain unchanged.
  const suffix = options.transparentBackground ? 64 : 0;
  for (const target of [28_000, 24_000]) {
    const prompt = (await compact(original, target)).trim();
    if (!prompt) continue;
    const fitted = { ...options, prompt, negativePrompt: undefined, width: undefined, height: undefined };
    if (chatGPTImagePromptText(fitted).length <= MAX_CHATGPT_DIRECT_IMAGE_PROMPT_CHARS - suffix) return fitted;
  }
  throw new Error(
    "Image prompt could not be condensed below 32,000 characters. No image request was sent; shorten the image instructions and retry.",
  );
}

const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;
const MODEL_FALLBACK_CACHE_TTL_MS = 60 * 1000;
const CHATGPT_IMAGE_QUALITIES = new Set(["low", "medium", "high"]);
let cachedAutoModel: { cacheKey: string; model: string; expiresAt: number } | null = null;
const autoModelResolutionInFlight = new Map<string, Promise<string>>();

type ChatGPTImageModelCatalogLoader = () => Promise<Array<{ id: string; name: string }>>;

export interface ChatGPTImageModelResolutionOptions {
  /** Keeps the short-lived catalog choice scoped to the active ChatGPT account. */
  cacheKey?: string;
  /** Injectable only so concurrency and failure behavior can be proven offline. */
  fetchModels?: ChatGPTImageModelCatalogLoader;
}

/**
 * Resolve the text model that drives the image_generation tool. An explicit
 * model wins; otherwise pick a cheap non-Codex slug from the account's live
 * catalog (cached, since the catalog changes rarely and every generation would
 * otherwise pay an extra round-trip).
 */
export async function resolveChatGPTImageModel(
  requested?: string,
  options: ChatGPTImageModelResolutionOptions = {},
): Promise<string> {
  const explicit = requested?.trim();
  if (explicit) return explicit;
  const cacheKey = options.cacheKey?.trim() || "default";
  if (cachedAutoModel?.cacheKey === cacheKey && Date.now() < cachedAutoModel.expiresAt) {
    return cachedAutoModel.model;
  }

  const existing = autoModelResolutionInFlight.get(cacheKey);
  if (existing) return existing;

  const resolution = (async () => {
    try {
      const models = await (options.fetchModels ?? fetchOpenAIChatGPTModels)();
      const slugs = models.map((model) => model.id.trim()).filter(Boolean);
      const pick =
        slugs.find((slug) => {
          const normalized = slug.toLowerCase();
          return normalized.includes("mini") && !normalized.includes("codex");
        }) ??
        slugs.find((slug) => !slug.toLowerCase().includes("codex")) ??
        slugs[0];
      if (pick) {
        cachedAutoModel = { cacheKey, model: pick, expiresAt: Date.now() + MODEL_CACHE_TTL_MS };
        return pick;
      }
    } catch (err) {
      logger.warn(err, "[image-gen/openai-chatgpt] Could not fetch the ChatGPT model catalog; using the default model");
    }
    // Avoid making every frame in a sequential batch repeat the same failed
    // catalog round-trip. Retry soon so a newly restored login recovers.
    cachedAutoModel = {
      cacheKey,
      model: DEFAULT_CHATGPT_IMAGE_MODEL,
      expiresAt: Date.now() + MODEL_FALLBACK_CACHE_TTL_MS,
    };
    return DEFAULT_CHATGPT_IMAGE_MODEL;
  })();
  autoModelResolutionInFlight.set(cacheKey, resolution);
  try {
    return await resolution;
  } finally {
    if (autoModelResolutionInFlight.get(cacheKey) === resolution) {
      autoModelResolutionInFlight.delete(cacheKey);
    }
  }
}

export interface ChatGPTImageRequestOptions {
  model: string;
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  /** "low" | "medium" | "high" pass through; "auto"/empty lets the backend pick. */
  quality?: string;
  transparentBackground?: boolean;
  /** data: URLs attached as input_image parts for img2img / character consistency. */
  referenceDataUrls?: string[];
}

/**
 * The backend ignores the tool-level `size`, but honors broad orientation cues
 * in the prompt. The returned canvas can still vary, so the caller treats this
 * only as composition guidance.
 */
export function chatGPTImageOrientationHint(width?: number, height?: number): string {
  if (!width || !height) return "";
  const ratio = width / Math.max(1, height);
  if (ratio < 0.9) {
    return "The image must be in tall vertical portrait orientation (2:3 aspect ratio, taller than wide).";
  }
  if (ratio > 1.1) {
    return "The image must be in wide horizontal landscape orientation (3:2 aspect ratio, wider than tall).";
  }
  return "The image must be exactly square (1:1 aspect ratio).";
}

export function chatGPTImagePromptText(options: ChatGPTImageRequestOptions): string {
  const parts = [options.prompt.trim()];
  const negativePrompt = options.negativePrompt?.trim();
  if (negativePrompt) parts.push(`Do not include: ${negativePrompt}.`);
  const orientation = chatGPTImageOrientationHint(options.width, options.height);
  if (orientation) parts.push(orientation);
  if (options.transparentBackground) parts.push("The image background must be fully transparent.");
  return parts.filter(Boolean).join("\n\n");
}

export function buildChatGPTImageResponsesBody(options: ChatGPTImageRequestOptions): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [{ type: "input_text", text: chatGPTImagePromptText(options) }];
  for (const dataUrl of (options.referenceDataUrls ?? [])
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, MAX_CHATGPT_IMAGE_REFERENCES)) {
    content.push({ type: "input_image", image_url: dataUrl });
  }

  const tool: Record<string, unknown> = { type: "image_generation", output_format: "png" };
  const quality = options.quality?.trim().toLowerCase();
  if (quality && CHATGPT_IMAGE_QUALITIES.has(quality)) tool.quality = quality;
  if (options.transparentBackground) tool.background = "transparent";

  return {
    model: options.model,
    instructions:
      "You are an image generation assistant. Always call the image_generation tool to produce the requested image. Never reply with text only.",
    input: [{ type: "message", role: "user", content }],
    tools: [tool],
    tool_choice: { type: "image_generation" },
    store: false,
    stream: true,
  };
}

/** Explicit image-model selections use the dedicated subscription Images route. */
export function isChatGPTDirectImageModel(model?: string): boolean {
  return /^gpt-image-/i.test(model?.trim() ?? "");
}

export function buildChatGPTDirectImageRequest(options: ChatGPTImageRequestOptions): {
  endpoint: "images/generations" | "images/edits";
  body: Record<string, unknown>;
} {
  const references = (options.referenceDataUrls ?? []).map((value) => value.trim()).filter(Boolean);
  if (references.length > MAX_CHATGPT_IMAGE_REFERENCES) {
    throw new Error(`ChatGPT supports at most ${MAX_CHATGPT_IMAGE_REFERENCES} reference images per request`);
  }
  const quality = options.quality?.trim().toLowerCase();
  const prompt = chatGPTImagePromptText(options);
  if (prompt.length > MAX_CHATGPT_DIRECT_IMAGE_PROMPT_CHARS) {
    throw new Error(`Image prompt exceeds the 32,000-character limit (${prompt.length}); compact it before sending.`);
  }
  return {
    endpoint: references.length ? "images/edits" : "images/generations",
    body: {
      model: options.model.trim(),
      prompt,
      quality: quality && CHATGPT_IMAGE_QUALITIES.has(quality) ? quality : "auto",
      background: options.transparentBackground ? "transparent" : "opaque",
      size: "auto",
      ...(references.length ? { images: references.map((image_url) => ({ image_url })) } : {}),
    },
  };
}

export function parseChatGPTDirectImageResult(value: unknown): ChatGPTImageSseResult {
  const response = asRecord(value);
  const data = response?.data;
  const first = Array.isArray(data) ? asRecord(data[0]) : null;
  const base64 = stringField(first, "b64_json");
  if (!base64) throw new Error("ChatGPT image generation returned no image data");
  return { base64, outputFormat: stringField(response, "output_format"), size: stringField(response, "size") };
}

/** Serialize a request for debug logs without ever exposing attached image data. */
export function serializeChatGPTImageDebugBody(body: Record<string, unknown>): string {
  return JSON.stringify(
    body,
    (key, value) => (key === "image_url" && typeof value === "string" ? "<image>" : value),
    2,
  );
}

export interface ChatGPTImageSseResult {
  base64: string;
  outputFormat: string | null;
  /** "WIDTHxHEIGHT" as reported by the backend, when present. */
  size: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value ? value : null;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("ChatGPT image generation aborted");
}

function imageFromOutputItem(value: unknown): ChatGPTImageSseResult | null {
  const item = asRecord(value);
  if (item?.type !== "image_generation_call" || item.status !== "completed") return null;
  const result = stringField(item, "result");
  if (!result) return null;
  return {
    base64: result,
    outputFormat: stringField(item, "output_format"),
    size: stringField(item, "size"),
  };
}

function textFromOutputItem(value: unknown): string {
  const item = asRecord(value);
  if (item?.type !== "message" || !Array.isArray(item.content)) return "";
  return item.content
    .map((part) => {
      const record = asRecord(part);
      if (record?.type === "output_text") return stringField(record, "text") ?? "";
      if (record?.type === "refusal") return stringField(record, "refusal") ?? "";
      return "";
    })
    .join("");
}

/**
 * Extract the generated image from a complete Codex Responses SSE transcript.
 * Throws with the backend's failure message — or the assistant's textual
 * refusal — when no image was produced.
 */
export function parseChatGPTImageSse(sseText: string): ChatGPTImageSseResult {
  let image: ChatGPTImageSseResult | null = null;
  let failureMessage: string | null = null;
  let assistantTextDeltas = "";
  let assistantTextDone = "";

  for (const frame of sseText.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (!data || data === "[DONE]") continue;

    let event: Record<string, unknown> | null;
    try {
      event = asRecord(JSON.parse(data));
    } catch {
      continue;
    }
    if (!event) continue;

    const type = event.type;
    if (type === "response.output_item.done") {
      image = imageFromOutputItem(event.item) ?? image;
      assistantTextDone += textFromOutputItem(event.item);
    } else if (type === "response.output_text.delta" || type === "response.refusal.delta") {
      const delta = stringField(event, "delta");
      if (delta) assistantTextDeltas += delta;
    } else if (type === "response.output_text.done") {
      const text = stringField(event, "text");
      if (text) assistantTextDone += text;
    } else if (type === "response.refusal.done") {
      const refusal = stringField(event, "refusal") ?? stringField(event, "text");
      if (refusal) assistantTextDone += refusal;
    } else if (type === "response.failed" || type === "error") {
      const response = asRecord(event.response);
      const error = asRecord(response?.error) ?? asRecord(event.error);
      failureMessage = stringField(error, "message") ?? stringField(event, "message") ?? failureMessage;
    } else if (type === "response.completed" || type === "response.incomplete") {
      const response = asRecord(event.response);
      const output = Array.isArray(response?.output) ? response.output : [];
      for (const item of output) {
        image = imageFromOutputItem(item) ?? image;
        assistantTextDone += textFromOutputItem(item);
      }
      if (type === "response.incomplete" || response?.status === "incomplete") {
        const reason = stringField(asRecord(response?.incomplete_details), "reason") ?? "unknown reason";
        failureMessage = `ChatGPT response was incomplete: ${reason}`;
      }
    }
  }

  if (image) return image;
  if (failureMessage) throw new Error(`ChatGPT image generation failed: ${failureMessage.slice(0, 300)}`);
  const assistantText = assistantTextDone || assistantTextDeltas;
  if (assistantText.trim()) {
    throw new Error(`ChatGPT replied with text instead of an image: ${assistantText.trim().slice(0, 300)}`);
  }
  throw new Error("No image data in ChatGPT response");
}

/**
 * Read the ChatGPT image SSE body without discarding an already completed
 * image when the transport closes after its output item was delivered.
 */
export async function readChatGPTImageSse(response: Response, signal?: AbortSignal): Promise<ChatGPTImageSseResult> {
  throwIfAborted(signal);
  const reader = response.body?.getReader();
  if (!reader) {
    const transcript = await response.text();
    throwIfAborted(signal);
    return parseChatGPTImageSse(transcript);
  }

  const decoder = new TextDecoder();
  let transcript = "";
  let pendingFrames = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      transcript += chunk;
      pendingFrames += chunk;
      const frames = pendingFrames.split(/\r?\n\r?\n/);
      pendingFrames = frames.pop() ?? "";
      for (const frame of frames) {
        // A completed tool image is already usable. Do not occupy a generation slot
        // waiting for trailing assistant prose or a stream that never closes.
        if (!frame.includes("image_generation_call")) continue;
        try {
          const completedImage = parseChatGPTImageSse(frame);
          void reader.cancel().catch(() => undefined);
          return completedImage;
        } catch {
          // Partial image events are not final results; preserve normal error handling below.
        }
      }
    }
    transcript += decoder.decode();
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : error;
    }
    try {
      return parseChatGPTImageSse(transcript);
    } catch (parseError) {
      if (parseError instanceof Error && parseError.message !== "No image data in ChatGPT response") {
        throw parseError;
      }
      throw error;
    }
  }

  throwIfAborted(signal);
  return parseChatGPTImageSse(transcript);
}
