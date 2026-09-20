import { inferImageSource } from "../constants/model-lists.js";
import { MAX_IMAGE_REFERENCES_PER_REQUEST } from "../types/connection.js";
import { isOpenAIGptImageModel } from "./openai-image.js";

const KNOWN_IMAGE_SOURCES = new Set([
  "openai",
  "openai_chatgpt",
  "arli",
  "nanogpt",
  "openrouter",
  "pollinations",
  "stability",
  "togetherai",
  "novelai",
  "horde",
  "blockentropy",
  "xai",
  "venice",
  "zai",
  "atlas",
  "comfyui",
  "swarmui",
  "automatic1111",
  "runpod_comfyui",
  "gemini_image",
]);

export interface ImageReferenceLimitInput {
  imageGenerationSource?: string | null;
  imageService?: string | null;
  model?: string | null;
  baseUrl?: string | null;
  comfyuiWorkflow?: string | null;
  maxImageReferences?: unknown;
}

export interface ImageReferenceLimits {
  source: string;
  automaticLimit: number;
  hardLimit: number;
  configuredLimit: number | null;
  effectiveLimit: number;
}

export function normalizeMaxImageReferences(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(MAX_IMAGE_REFERENCES_PER_REQUEST, Math.max(1, Math.trunc(parsed)));
}

function resolveImageReferenceSource(input: ImageReferenceLimitInput): string {
  const explicitService = input.imageService?.trim().toLowerCase() ?? "";
  const explicitSource = input.imageGenerationSource?.trim().toLowerCase() ?? "";
  const inferred = inferImageSource(input.model || explicitSource, input.baseUrl || "");

  for (const explicit of [explicitService, explicitSource]) {
    if (explicit === "drawthings") return "automatic1111";
    if (KNOWN_IMAGE_SOURCES.has(explicit)) {
      return explicit === "openai" && inferred === "gemini_image" ? inferred : explicit;
    }
  }
  // Keep this aligned with the server's backend resolver: an unrecognized
  // service hint falls back to model/URL inference and ultimately the
  // OpenAI-compatible adapter rather than gaining imaginary custom limits.
  return inferred;
}

function comfyWorkflowReferenceLimit(source: string, workflow: string): number {
  const text = workflow.trim();
  // SwarmUI's native endpoint accepts promptimages without a custom workflow.
  // ComfyUI and RunPod need declared workflow slots before references can be
  // transported safely.
  if (!text) return source === "swarmui" ? 4 : 0;
  const supportsFilenamePlaceholders = source === "comfyui";
  let contiguousSlots = 0;
  for (let slot = 1; slot <= 4; slot += 1) {
    const suffix = String(slot).padStart(2, "0");
    const hasBaseSlot =
      slot === 1 &&
      (text.includes("%reference_image%") || (supportsFilenamePlaceholders && text.includes("%reference_image_name%")));
    const hasNumberedSlot =
      text.includes(`%reference_image_${suffix}%`) ||
      (supportsFilenamePlaceholders && text.includes(`%reference_image_name_${suffix}%`));
    if (!hasBaseSlot && !hasNumberedSlot) break;
    contiguousSlots = slot;
  }
  return contiguousSlots;
}

function automaticAndHardLimit(
  source: string,
  model: string,
  baseUrl: string,
  comfyuiWorkflow: string,
): { automaticLimit: number; hardLimit: number } {
  const modelHint = model.toLowerCase();
  if (source === "openai_chatgpt") return { automaticLimit: 20, hardLimit: 20 };
  if (source === "openai") {
    // The Engine's public Images API adapter only switches to /images/edits
    // for GPT Image models. DALL-E and an empty/unknown model use generations
    // and therefore do not attach the supplied images.
    if (!isOpenAIGptImageModel(modelHint)) {
      return { automaticLimit: 0, hardLimit: 0 };
    }
    return { automaticLimit: 16, hardLimit: 16 };
  }
  if (source === "novelai") {
    const isNativeNovelAi = baseUrl.toLowerCase().includes("novelai.net");
    const supportsPreciseReferences = !modelHint || /^nai-diffusion-4-5(?:-(?:curated|full))?$/i.test(modelHint);
    if (!isNativeNovelAi) {
      return { automaticLimit: 16, hardLimit: MAX_IMAGE_REFERENCES_PER_REQUEST };
    }
    return supportsPreciseReferences ? { automaticLimit: 16, hardLimit: 16 } : { automaticLimit: 0, hardLimit: 0 };
  }
  if (source === "openrouter") {
    // Keep the blank-model case aligned with generateOpenRouter's default.
    if (!modelHint) return { automaticLimit: 3, hardLimit: 3 };
    if (modelHint.startsWith("krea/")) {
      return { automaticLimit: 1, hardLimit: 1 };
    }
    if (modelHint.startsWith("bytedance-seed/seedream-4.5") || modelHint.startsWith("bytedance-seed/seedream-5-0")) {
      return { automaticLimit: 14, hardLimit: 14 };
    }
    if (modelHint.startsWith("bytedance-seed/seedream-")) return { automaticLimit: 1, hardLimit: 1 };
    if (modelHint.includes("nano-banana") || (modelHint.includes("gemini") && modelHint.includes("image"))) {
      if (modelHint.includes("2.5")) {
        return { automaticLimit: 3, hardLimit: 3 };
      }
      return {
        automaticLimit: modelHint.includes("pro") ? 5 : 4,
        hardLimit: 14,
      };
    }
    if (/^openai\/.*image/i.test(modelHint)) return { automaticLimit: 16, hardLimit: 16 };
    if (modelHint.startsWith("x-ai/")) return { automaticLimit: 3, hardLimit: 3 };
    if (/^black-forest-labs\/flux\.2-(?:pro|flex|max)(?:$|-)/i.test(modelHint)) {
      return { automaticLimit: 4, hardLimit: 8 };
    }
    if (modelHint.startsWith("black-forest-labs/flux.2-klein")) {
      return { automaticLimit: 4, hardLimit: 4 };
    }
    if (modelHint.startsWith("sourceful/riverflow-") && modelHint.includes("pro")) {
      return { automaticLimit: 4, hardLimit: 10 };
    }
    if (modelHint.startsWith("sourceful/riverflow-") && modelHint.includes("fast")) {
      return { automaticLimit: 4, hardLimit: 4 };
    }
    if (modelHint.startsWith("recraft/recraft-v4-styles")) {
      return { automaticLimit: 4, hardLimit: 10 };
    }
    if (modelHint.startsWith("recraft/") || modelHint.startsWith("microsoft/mai-image")) {
      return { automaticLimit: 1, hardLimit: 1 };
    }
    if (modelHint.startsWith("qwen/qwen-image-3")) return { automaticLimit: 4, hardLimit: 4 };
    // OpenRouter publishes per-endpoint capabilities rather than one platform
    // maximum. Stay conservative automatically, but let an informed user raise
    // the connection to Marinara's request ceiling.
    return { automaticLimit: 4, hardLimit: MAX_IMAGE_REFERENCES_PER_REQUEST };
  }
  if (source === "gemini_image") {
    if (modelHint.includes("gemini-2.5")) {
      return { automaticLimit: 3, hardLimit: MAX_IMAGE_REFERENCES_PER_REQUEST };
    }
    return {
      automaticLimit: modelHint.includes("gemini-3-pro-image") ? 5 : 4,
      hardLimit: 14,
    };
  }
  if (source === "nanogpt") {
    return { automaticLimit: 3, hardLimit: MAX_IMAGE_REFERENCES_PER_REQUEST };
  }
  if (source === "xai") {
    return /^grok-imagine-image-2\.0(?:$|-)/i.test(modelHint)
      ? { automaticLimit: 5, hardLimit: 5 }
      : { automaticLimit: 3, hardLimit: 3 };
  }
  if (source === "comfyui" || source === "swarmui" || source === "runpod_comfyui") {
    const workflowLimit = comfyWorkflowReferenceLimit(source, comfyuiWorkflow);
    return { automaticLimit: workflowLimit, hardLimit: workflowLimit };
  }
  if (source === "stability") {
    const isV1Base = /\/v1(?:\/|$)/i.test(baseUrl) && !/\/v2beta(?:\/|$)/i.test(baseUrl);
    const isTextOnlyV2Model = /^(?:stable-image-(?:core|ultra)|core|ultra)$/i.test(modelHint);
    return isV1Base || isTextOnlyV2Model ? { automaticLimit: 0, hardLimit: 0 } : { automaticLimit: 1, hardLimit: 1 };
  }
  if (source === "atlas") {
    return /(?:kontext|image-to-image|image-edit|edit-image)/i.test(modelHint)
      ? { automaticLimit: 1, hardLimit: 1 }
      : { automaticLimit: 0, hardLimit: 0 };
  }
  if (source === "arli" || source === "automatic1111") {
    return { automaticLimit: 1, hardLimit: 1 };
  }
  if (
    source === "pollinations" ||
    source === "togetherai" ||
    source === "horde" ||
    source === "blockentropy" ||
    source === "venice" ||
    source === "zai"
  ) {
    return { automaticLimit: 0, hardLimit: 0 };
  }
  return { automaticLimit: 4, hardLimit: MAX_IMAGE_REFERENCES_PER_REQUEST };
}

/** Resolve the connection's user cap without exceeding a provider's known transport limit. */
export function resolveImageReferenceLimits(input: ImageReferenceLimitInput): ImageReferenceLimits {
  const source = resolveImageReferenceSource(input);
  const { automaticLimit, hardLimit } = automaticAndHardLimit(
    source,
    input.model || "",
    input.baseUrl || "",
    input.comfyuiWorkflow || "",
  );
  const configuredLimit = normalizeMaxImageReferences(input.maxImageReferences);
  return {
    source,
    automaticLimit,
    hardLimit,
    configuredLimit,
    effectiveLimit: Math.min(configuredLimit ?? automaticLimit, hardLimit),
  };
}
