import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConnectionSchema,
  isOpenAIGptImageModel,
  resolveImageReferenceLimits,
} from "../../packages/shared/src/index.js";
import { inferImageSource } from "../../packages/shared/src/constants/model-lists.js";
import {
  resolveImageConnectionFallback,
  resolveImageFallbackReferenceLimit,
} from "../../packages/server/src/services/generation/media-connection-fallback.js";
import {
  resolveGameImageServiceHint,
  resolveGameImageGenerationConcurrency,
  resolveSceneIllustrationImageBackend,
  resolveSceneIllustrationReferenceImageLimit,
  supportsSceneIllustrationStructuredCharacterPrompts,
} from "../../packages/server/src/services/game/game-asset-generation.js";
import {
  buildStabilityV2FormData,
  buildSwarmUiGenerationBody,
  buildOpenRouterImagesRequest,
  imageAdmissionKey,
  imageGenerationPermitProfile,
  limitImageReferencesForProvider,
  nanoGPTReferenceImages,
  resolveImageBackend,
  selectNovelAiDirectorReferences,
  shouldSerializeImageGenerationRequests,
  xAIReferenceImages,
} from "../../packages/server/src/services/image/image-generation.js";
import { OPENAI_CHATGPT_IMAGE_GENERATION_CONCURRENCY } from "../../packages/server/src/services/image/image-generation-queue.js";
import {
  mergeSpatialLocationReferenceImages,
  SPATIAL_LOCATION_REFERENCE_PROMPT_LINE,
} from "../../packages/server/src/services/image/spatial-location-reference.js";
import { resolveImageGenerationSource } from "../../packages/server/src/routes/connections.routes.js";
import {
  capabilityForConnection,
  fallbackForMariImageOperation,
} from "../../packages/server/src/services/mari-db/mari-images.service.js";
import {
  buildChatGPTImageResponsesBody,
  buildChatGPTDirectImageRequest,
  isChatGPTDirectImageModel,
  parseChatGPTDirectImageResult,
  chatGPTImageOrientationHint,
  parseChatGPTImageSse,
  readChatGPTImageSse,
  resolveChatGPTImageModel,
  serializeChatGPTImageDebugBody,
} from "../../packages/server/src/services/image/openai-chatgpt-image.js";
import { OPENAI_CHATGPT_CODEX_BASE_URL } from "../../packages/server/src/services/llm/openai-chatgpt-auth.js";

// ── Request body ──

assert.equal(isChatGPTDirectImageModel("gpt-image-2.5-sunburst"), true);
assert.equal(isChatGPTDirectImageModel("gpt-5.6-sol"), false);
assert.equal(isChatGPTDirectImageModel(""), false);
const directRequest = buildChatGPTDirectImageRequest({
  model: "gpt-image-2.5-sunburst",
  prompt: "Keep the character and scene",
  negativePrompt: "extra fingers",
  width: 768,
  height: 1024,
  quality: "high",
  referenceDataUrls: ["data:image/png;base64,FIRST", "data:image/png;base64,SECOND"],
});
assert.equal(directRequest.endpoint, "images/edits");
assert.equal(directRequest.body.model, "gpt-image-2.5-sunburst");
assert.deepEqual(directRequest.body.images, [
  { image_url: "data:image/png;base64,FIRST" },
  { image_url: "data:image/png;base64,SECOND" },
]);
assert.match(String(directRequest.body.prompt), /extra fingers/);
assert.match(String(directRequest.body.prompt), /portrait orientation/);
assert.equal(directRequest.body.quality, "high");
assert.doesNotMatch(serializeChatGPTImageDebugBody(directRequest.body), /base64|FIRST|SECOND/);
const directGeneration = buildChatGPTDirectImageRequest({ model: "gpt-image-2.5-flare", prompt: "Scene" });
assert.equal(directGeneration.endpoint, "images/generations");
assert.equal(directGeneration.body.images, undefined);
assert.throws(() => parseChatGPTDirectImageResult({ data: [] }), /no image data/);
assert.deepEqual(
  parseChatGPTDirectImageResult({ data: [{ b64_json: "aW1hZ2U=" }], size: "1024x1024", output_format: "png" }),
  {
    base64: "aW1hZ2U=",
    size: "1024x1024",
    outputFormat: "png",
  },
);

const body = buildChatGPTImageResponsesBody({
  model: "gpt-5.4-mini",
  prompt: "a lighthouse at dusk",
  negativePrompt: "text, watermark",
  width: 832,
  height: 1216,
  quality: "low",
  referenceDataUrls: ["data:image/png;base64,QUJD"],
});

// The Codex backend rejects non-streaming requests and prose-only replies are
// possible unless the tool call is forced.
assert.equal(body.stream, true);
assert.equal(body.store, false);
assert.deepEqual(body.tool_choice, { type: "image_generation" });
assert.equal(body.model, "gpt-5.4-mini");

const tools = body.tools as Array<Record<string, unknown>>;
assert.equal(tools.length, 1);
assert.equal(tools[0]!.type, "image_generation");
assert.equal(tools[0]!.quality, "low");
assert.equal(tools[0]!.output_format, "png");
assert.equal("background" in tools[0]!, false);

const input = body.input as Array<{ content: Array<Record<string, unknown>> }>;
const content = input[0]!.content;
assert.equal(content[0]!.type, "input_text");
const promptText = content[0]!.text as string;
assert.match(promptText, /a lighthouse at dusk/);
assert.match(promptText, /Do not include: text, watermark\./);
// 832x1216 is portrait — the size parameter is ignored by the backend, so the
// orientation must be steered through the prompt.
assert.match(promptText, /portrait orientation/);
assert.deepEqual(content[1], { type: "input_image", image_url: "data:image/png;base64,QUJD" });

// "auto" quality is the backend default and must not be sent explicitly.
const autoBody = buildChatGPTImageResponsesBody({
  model: "gpt-5.5",
  prompt: "a red circle",
  quality: "auto",
  transparentBackground: true,
});
const autoTools = autoBody.tools as Array<Record<string, unknown>>;
assert.equal("quality" in autoTools[0]!, false);
assert.equal(autoTools[0]!.background, "transparent");
const autoText = (autoBody.input as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content[0]!.text as string;
assert.match(autoText, /transparent/);

// The ChatGPT transport accepts at most 20 input images. Enforce the boundary in the
// provider body builder too, rather than relying only on today's caller.
const referenceLimitBody = buildChatGPTImageResponsesBody({
  model: "gpt-5.5",
  prompt: "keep these characters consistent",
  referenceDataUrls: Array.from(
    { length: 21 },
    (_, index) => `data:image/png;base64,${Buffer.from(`reference-${index}`).toString("base64")}`,
  ),
});
const limitedContent = (referenceLimitBody.input as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content;
assert.equal(
  limitedContent.filter((part) => part.type === "input_image").length,
  20,
  "ChatGPT request construction must cap references at 20",
);

const invalidQualityBody = buildChatGPTImageResponsesBody({
  model: "gpt-5.5",
  prompt: "a red circle",
  quality: "ultra",
});
assert.equal(
  "quality" in (invalidQualityBody.tools as Array<Record<string, unknown>>)[0]!,
  false,
  "unknown persisted quality values must fall back to provider auto",
);

const debugPayload = serializeChatGPTImageDebugBody(body);
assert.match(debugPayload, /a lighthouse at dusk/u, "ordinary prompt text remains available in debug mode");
assert.match(debugPayload, /"image_url": "<image>"/u);
assert.doesNotMatch(debugPayload, /QUJD/u, "even short reference payloads must be redacted from debug logs");

// ── Orientation hints ──

assert.match(chatGPTImageOrientationHint(832, 1216), /portrait/);
assert.match(chatGPTImageOrientationHint(1216, 832), /landscape/);
assert.match(chatGPTImageOrientationHint(1024, 1024), /square/);
assert.equal(chatGPTImageOrientationHint(undefined, 1024), "");
assert.equal(chatGPTImageOrientationHint(1024, undefined), "");

// ── SSE parsing ──

function sse(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
}

const imageResult = parseChatGPTImageSse(
  sse([
    { type: "response.created" },
    { type: "response.output_item.added", item: { type: "image_generation_call" } },
    {
      type: "response.output_item.done",
      item: {
        type: "image_generation_call",
        status: "completed",
        result: "QUJDRA==",
        output_format: "png",
        size: "1024x1536",
      },
    },
    { type: "response.completed", response: { status: "completed" } },
  ]),
);
assert.equal(imageResult.base64, "QUJDRA==");
for (const status of ["in_progress", "incomplete", undefined]) {
  assert.throws(
    () =>
      parseChatGPTImageSse(
        sse([
          { type: "response.output_item.done", item: { type: "image_generation_call", status, result: "PREVIEW" } },
        ]),
      ),
    /No image data/,
  );
}
assert.throws(
  () =>
    parseChatGPTImageSse(sse([{ type: "response.image_generation_call.partial_image", partial_image_b64: "PREVIEW" }])),
  /No image data/,
);
assert.equal(imageResult.outputFormat, "png");
assert.equal(imageResult.size, "1024x1536");

const completedPayloadImage = parseChatGPTImageSse(
  sse([
    {
      type: "response.completed",
      response: {
        status: "completed",
        output: [
          {
            type: "image_generation_call",
            status: "completed",
            result: "Q09NUExFVEVEX1BBWUxPQUQ=",
            output_format: "png",
            size: "1536x1024",
          },
        ],
      },
    },
  ]),
);
assert.equal(
  completedPayloadImage.base64,
  "Q09NUExFVEVEX1BBWUxPQUQ=",
  "the final response payload must recover an image when an output-item event is absent",
);

assert.throws(
  () =>
    parseChatGPTImageSse(sse([{ type: "response.failed", response: { error: { message: "Usage limit reached" } } }])),
  /Usage limit reached/,
);

assert.throws(
  () => parseChatGPTImageSse(sse([{ type: "response.output_text.done", text: "I cannot generate that image." }])),
  /replied with text instead of an image.*cannot generate/,
);

assert.throws(
  () => parseChatGPTImageSse(sse([{ type: "response.refusal.done", refusal: "That request is not allowed." }])),
  /replied with text instead of an image.*not allowed/,
);

assert.throws(
  () =>
    parseChatGPTImageSse(
      sse([
        {
          type: "response.incomplete",
          response: { status: "incomplete", incomplete_details: { reason: "content_filter" } },
        },
      ]),
    ),
  /response was incomplete: content_filter/,
);

assert.throws(() => parseChatGPTImageSse(""), /No image data in ChatGPT response/);

const alreadyAborted = new AbortController();
const alreadyAbortedReason = new Error("cancelled before response read");
alreadyAborted.abort(alreadyAbortedReason);
await assert.rejects(
  readChatGPTImageSse(
    new Response(
      sse([
        {
          type: "response.output_item.done",
          item: { type: "image_generation_call", status: "completed", result: "U0hPVUxEX05PVF9SRVRVUk4=" },
        },
      ]),
    ),
    alreadyAborted.signal,
  ),
  (error) => {
    assert.equal(error, alreadyAbortedReason);
    return true;
  },
);

let deliveredCompletedImage = false;
const terminatedAfterImage = new ReadableStream<Uint8Array>({
  pull(controller) {
    if (deliveredCompletedImage) {
      controller.error(new Error("terminated"));
      return;
    }
    deliveredCompletedImage = true;
    controller.enqueue(
      new TextEncoder().encode(
        sse([
          {
            type: "response.output_item.done",
            item: { type: "image_generation_call", status: "completed", result: "U0FMVkFHRUQ=", output_format: "png" },
          },
        ]),
      ),
    );
  },
});
const salvagedImage = await readChatGPTImageSse(new Response(terminatedAfterImage));
assert.equal(salvagedImage.base64, "U0FMVkFHRUQ=");

const abortController = new AbortController();
const abortReason = new Error("caller cancelled");
let deliveredBeforeAbort = false;
const abortedAfterImage = new ReadableStream<Uint8Array>({
  pull(controller) {
    if (!deliveredBeforeAbort) {
      deliveredBeforeAbort = true;
      // Cancellation already requested at delivery must win. Once the completed
      // image is returned, trailing stream events no longer delay its use.
      abortController.abort(abortReason);
      controller.enqueue(
        new TextEncoder().encode(
          sse([
            {
              type: "response.output_item.done",
              item: { type: "image_generation_call", status: "completed", result: "Tk9UX1NBTFZBR0VE" },
            },
          ]),
        ),
      );
      return;
    }
    abortController.abort(abortReason);
    controller.error(new Error("transport terminated after cancellation"));
  },
});
await assert.rejects(readChatGPTImageSse(new Response(abortedAfterImage), abortController.signal), (error) => {
  assert.equal(error, abortReason);
  return true;
});

let deliveredFailure = false;
const terminatedAfterFailure = new ReadableStream<Uint8Array>({
  pull(controller) {
    if (deliveredFailure) {
      controller.error(new Error("terminated"));
      return;
    }
    deliveredFailure = true;
    controller.enqueue(
      new TextEncoder().encode(
        sse([{ type: "response.failed", response: { error: { message: "Image tool is unavailable" } } }]),
      ),
    );
  },
});
await assert.rejects(readChatGPTImageSse(new Response(terminatedAfterFailure)), /Image tool is unavailable/);

let deliveredRefusalDelta = false;
const terminatedAfterRefusalDelta = new ReadableStream<Uint8Array>({
  pull(controller) {
    if (deliveredRefusalDelta) {
      controller.error(new Error("terminated"));
      return;
    }
    deliveredRefusalDelta = true;
    controller.enqueue(
      new TextEncoder().encode(sse([{ type: "response.refusal.delta", delta: "The image request was refused." }])),
    );
  },
});
await assert.rejects(
  readChatGPTImageSse(new Response(terminatedAfterRefusalDelta)),
  /replied with text instead of an image.*was refused/,
);

// ── Model resolution ──

// An explicitly configured model must short-circuit without touching the
// network (no local Codex login exists in CI).
assert.equal(await resolveChatGPTImageModel("  gpt-5.5  "), "gpt-5.5");

let catalogCalls = 0;
let releaseCatalog!: () => void;
const catalogGate = new Promise<void>((resolve) => {
  releaseCatalog = resolve;
});
const fetchCatalog = async () => {
  catalogCalls += 1;
  await catalogGate;
  return [
    { id: "gpt-5.3-codex-mini", name: "Codex Mini" },
    { id: "GPT-5.4-MINI", name: "GPT-5.4 Mini" },
    { id: "gpt-5.5", name: "GPT-5.5" },
  ];
};
const concurrentAutoModels = Array.from({ length: 3 }, () =>
  resolveChatGPTImageModel(undefined, {
    cacheKey: "regression-account-a",
    fetchModels: fetchCatalog,
  }),
);
assert.equal(catalogCalls, 1, "concurrent automatic image jobs must share one catalog request");
releaseCatalog();
assert.deepEqual(await Promise.all(concurrentAutoModels), ["GPT-5.4-MINI", "GPT-5.4-MINI", "GPT-5.4-MINI"]);
assert.equal(
  await resolveChatGPTImageModel(undefined, {
    cacheKey: "regression-account-a",
    fetchModels: async () => {
      throw new Error("cached account should not refetch");
    },
  }),
  "GPT-5.4-MINI",
);
assert.equal(
  await resolveChatGPTImageModel(undefined, {
    cacheKey: "regression-account-b",
    fetchModels: async () => [{ id: "gpt-5.5", name: "GPT-5.5" }],
  }),
  "gpt-5.5",
  "automatic model caches must not bleed across ChatGPT accounts",
);

let emptyCatalogCalls = 0;
assert.equal(
  await resolveChatGPTImageModel(undefined, {
    cacheKey: "regression-account-empty",
    fetchModels: async () => {
      emptyCatalogCalls += 1;
      return [];
    },
  }),
  "gpt-5.4-mini",
);
assert.equal(
  await resolveChatGPTImageModel(undefined, {
    cacheKey: "regression-account-empty",
    fetchModels: async () => {
      emptyCatalogCalls += 1;
      throw new Error("the short fallback cache should prevent this retry");
    },
  }),
  "gpt-5.4-mini",
);
assert.equal(emptyCatalogCalls, 1, "a sequential batch must not repeat a failed/empty catalog lookup per frame");

// ── Engine integration ──

assert.equal(inferImageSource("openai_chatgpt", ""), "openai_chatgpt");
assert.equal(inferImageSource("", OPENAI_CHATGPT_CODEX_BASE_URL), "openai_chatgpt");
assert.notEqual(inferImageSource("", "https://attacker-chatgpt.com.example/v1"), "openai_chatgpt");
assert.equal(imageAdmissionKey("", "openai_chatgpt"), OPENAI_CHATGPT_CODEX_BASE_URL);
assert.equal(imageGenerationPermitProfile(resolveImageBackend("openai_chatgpt", "", "", "")), "openai_chatgpt_image");
assert.equal(
  shouldSerializeImageGenerationRequests("openai_chatgpt", "", "openai_chatgpt", "", true),
  false,
  "the generic compatibility FIFO must not serialize ChatGPT Subscription image batches",
);
assert.equal(
  shouldSerializeImageGenerationRequests("openai", "https://api.openai.com/v1", "openai", "gpt-image-2", true),
  true,
  "the queue preference must remain effective for every non-ChatGPT image provider",
);
assert.equal(
  shouldSerializeImageGenerationRequests("openai", "https://api.openai.com/v1", "openai", "gpt-image-2", false),
  false,
);
assert.deepEqual(
  [
    shouldSerializeImageGenerationRequests("openai_chatgpt", "", "openai_chatgpt", "", true),
    shouldSerializeImageGenerationRequests("automatic1111", "http://127.0.0.1:7861", "automatic1111", "sdxl", true),
  ],
  [false, true],
  "a ChatGPT primary must bypass the FIFO without lending that bypass to its local fallback leg",
);
assert.equal(
  resolveGameImageGenerationConcurrency(
    {
      imgSource: "openai_chatgpt",
      imgService: "openai_chatgpt",
      imgModel: "",
      imgBaseUrl: "https://image.pollinations.ai",
    },
    1,
  ),
  OPENAI_CHATGPT_IMAGE_GENERATION_CONCURRENCY,
  "ChatGPT Subscription must override the generic queue-on width with its provider ceiling",
);
assert.equal(
  resolveGameImageGenerationConcurrency(
    { imgSource: "", imgService: "", imgModel: "", imgBaseUrl: OPENAI_CHATGPT_CODEX_BASE_URL },
    2,
  ),
  OPENAI_CHATGPT_IMAGE_GENERATION_CONCURRENCY,
  "the ChatGPT backend inferred from its sentinel URL must receive the same burst",
);
assert.equal(
  resolveGameImageGenerationConcurrency(
    { imgSource: "openai", imgService: "openai", imgModel: "gpt-image-2", imgBaseUrl: "https://api.openai.com/v1" },
    1,
  ),
  1,
  "public OpenAI and every other provider must retain the requested queue width",
);
assert.equal(
  resolveGameImageGenerationConcurrency(
    {
      imgSource: "openai_chatgpt",
      imgService: "openai_chatgpt",
      imgModel: "",
      imgBaseUrl: OPENAI_CHATGPT_CODEX_BASE_URL,
    },
    2,
    false,
  ),
  2,
  "image-to-video storyboard workers must not lend ChatGPT's image burst to video generation",
);
assert.equal(isOpenAIGptImageModel("chatgpt-image-latest"), true);
assert.equal(isOpenAIGptImageModel("dall-e-3"), false);
assert.equal(
  resolveImageBackend("gpt-image-1", "https://api.blockentropy.ai", "blockentropy", "gpt-image-1"),
  "blockentropy",
  "an explicit Block Entropy connection must not be reclassified as OpenAI from its model",
);
assert.equal(
  resolveImageBackend("automatic1111", "http://127.0.0.1:7861", "private-image-driver", "gpt-image-1"),
  "automatic1111",
  "an unrecognized service label must not erase a recognized image-generation source",
);
assert.equal(
  resolveImageGenerationSource(
    {
      imageGenerationSource: "openai_chatgpt",
      imageService: "automatic1111",
      model: "gpt-image-1",
    },
    "http://127.0.0.1:7861",
  ),
  "automatic1111",
  "connection tests and model catalogs must prefer the current image service over a stale source",
);
assert.equal(
  resolveImageGenerationSource(
    {
      imageGenerationSource: "openrouter",
      imageService: "private-image-driver",
      model: "vendor/custom-image-model",
    },
    "https://images.example.test/v1",
  ),
  "openrouter",
  "an unrecognized legacy service label must not erase a recognized image-generation source",
);
const mariImageConnection = {
  id: "image-connection",
  name: "Image connection",
  provider: "image_generation",
  baseUrl: "https://example.test/v1",
  model: "",
};
assert.equal(
  capabilityForConnection({ ...mariImageConnection, imageService: "xai", model: "grok-imagine-image-2.0" }).canEdit,
  true,
  "Mari image editing must follow the xAI adapter's real reference support",
);
assert.equal(
  capabilityForConnection({ ...mariImageConnection, imageService: "stability", model: "stable-image-core" }).canEdit,
  false,
  "Mari must not advertise editing for Stability Core",
);
assert.equal(
  capabilityForConnection({ ...mariImageConnection, imageService: "arli" }).canEdit,
  true,
  "Mari must expose the Arli adapter's img2img path",
);
assert.equal(
  capabilityForConnection({
    ...mariImageConnection,
    imageService: "swarmui",
    comfyuiWorkflow: '{"image":"%reference_image%"}',
  }).canEdit,
  true,
  "Mari must detect SwarmUI workflow reference inputs through the shared resolver",
);

assert.equal(
  resolveImageReferenceLimits({ imageService: "openai_chatgpt" }).effectiveLimit,
  20,
  "ChatGPT automatic mode must expose all 20 supported references",
);
assert.equal(
  resolveImageReferenceLimits({ imageService: "openai", model: "gpt-image-1" }).effectiveLimit,
  16,
  "the public OpenAI Images API must retain its 16-reference boundary",
);
assert.equal(
  resolveImageReferenceLimits({ imageService: "openai", model: "chatgpt-image-latest" }).effectiveLimit,
  16,
  "the public ChatGPT Image alias supports the Images API edit transport",
);
assert.equal(
  resolveImageReferenceLimits({ imageService: "openai", model: "dall-e-3" }).effectiveLimit,
  0,
  "DALL-E generation requests cannot attach reference images",
);
assert.deepEqual(
  resolveImageReferenceLimits({
    imageService: "novelai",
    model: "nai-diffusion-4-5-full",
    baseUrl: "https://image.novelai.net",
  }),
  {
    source: "novelai",
    automaticLimit: 16,
    hardLimit: 16,
    configuredLimit: null,
    effectiveLimit: 16,
  },
  "native NovelAI V4.5 supports precise reference images",
);
assert.equal(
  resolveImageReferenceLimits({ imageService: "novelai", model: "", baseUrl: "https://image.novelai.net" })
    .effectiveLimit,
  16,
  "native NovelAI's blank model must match the adapter's V4.5 default",
);
assert.equal(
  supportsSceneIllustrationStructuredCharacterPrompts({
    imgSource: "novelai",
    imgService: "novelai",
    imgModel: "",
    imgBaseUrl: "https://image.novelai.net",
  }),
  true,
  "blank native NovelAI scenes must retain the default V4.5 structured captions",
);
assert.equal(
  resolveImageReferenceLimits({
    imageService: "novelai",
    model: "nai-diffusion-5-full",
    baseUrl: "https://image.novelai.net",
  }).effectiveLimit,
  0,
  "native NovelAI models without precise-reference transport must reject attachments",
);
assert.equal(
  resolveImageReferenceLimits({ imageService: "automatic1111", maxImageReferences: 20 }).effectiveLimit,
  1,
  "a connection override must never exceed a known single-reference adapter",
);
assert.equal(
  resolveImageReferenceLimits({ imageService: "comfyui", maxImageReferences: 20 }).effectiveLimit,
  0,
  "ComfyUI without reference placeholders must not promise attachment slots",
);
assert.equal(
  resolveImageReferenceLimits({ imageService: "swarmui", maxImageReferences: 20 }).effectiveLimit,
  4,
  "SwarmUI native generation keeps its four prompt-image capacity without a custom workflow",
);
assert.equal(
  resolveImageReferenceLimits({ imageService: "swarmui", maxImageReferences: 1 }).effectiveLimit,
  1,
  "SwarmUI native generation still honors a lower connection cap",
);
assert.equal(
  resolveImageReferenceLimits({
    imageService: "comfyui",
    comfyuiWorkflow:
      '{"one":"%reference_image%","two":"%reference_image_02%","three":"%reference_image_03%","four":"%reference_image_04%"}',
    maxImageReferences: 20,
  }).effectiveLimit,
  4,
  "ComfyUI must retain its four-workflow-slot boundary",
);
assert.equal(
  resolveImageReferenceLimits({
    imageService: "comfyui",
    comfyuiWorkflow: '{"image":"%reference_image_04%"}',
    maxImageReferences: 20,
  }).effectiveLimit,
  0,
  "a lone fourth ComfyUI placeholder is unusable without the preceding slots",
);
assert.equal(
  resolveImageReferenceLimits({
    imageService: "comfyui",
    comfyuiWorkflow: '{"one":"%reference_image%","three":"%reference_image_03%"}',
    maxImageReferences: 20,
  }).effectiveLimit,
  1,
  "a sparse ComfyUI workflow must expose only its contiguous prefix",
);
assert.equal(
  resolveImageReferenceLimits({ imageService: "private-image-driver", maxImageReferences: 20 }).effectiveLimit,
  0,
  "an unknown service without a reference-capable inferred model must not promise attachments",
);
assert.deepEqual(
  resolveImageReferenceLimits({ imageService: "openrouter", model: "vendor/custom-image-model" }),
  {
    source: "openrouter",
    automaticLimit: 4,
    hardLimit: 20,
    configuredLimit: null,
    effectiveLimit: 4,
  },
  "an unknown OpenRouter endpoint must stay conservative in Automatic",
);
assert.equal(
  resolveImageReferenceLimits({ imageService: "openrouter", model: "" }).effectiveLimit,
  3,
  "OpenRouter's blank model must match its Gemini 2.5 default",
);
assert.equal(
  resolveImageReferenceLimits({
    imageService: "openrouter",
    model: "vendor/custom-image-model",
    maxImageReferences: 20,
  }).effectiveLimit,
  20,
  "an informed OpenRouter override may use Marinara's transport ceiling",
);
assert.deepEqual(
  resolveImageReferenceLimits({ imageService: "openrouter", model: "google/gemini-2.5-flash-image" }),
  {
    source: "openrouter",
    automaticLimit: 3,
    hardLimit: 3,
    configuredLimit: null,
    effectiveLimit: 3,
  },
  "OpenRouter Gemini 2.5 must retain the catalog's three-image hard cap",
);
assert.deepEqual(
  resolveImageReferenceLimits({ imageService: "gemini_image", model: "gemini-3-pro-image-preview" }),
  {
    source: "gemini_image",
    automaticLimit: 5,
    hardLimit: 14,
    configuredLimit: null,
    effectiveLimit: 5,
  },
  "Gemini 3 Pro should stay conservative in Automatic while exposing its documented hard limit",
);
assert.equal(
  resolveImageReferenceLimits({
    imageService: "gemini_image",
    model: "gemini-3-pro-image-preview",
    maxImageReferences: 14,
  }).effectiveLimit,
  14,
);
assert.deepEqual(
  resolveImageReferenceLimits({ imageService: "gemini_image", model: "gemini-2.5-flash-image" }),
  {
    source: "gemini_image",
    automaticLimit: 3,
    hardLimit: 20,
    configuredLimit: null,
    effectiveLimit: 3,
  },
  "direct Gemini 2.5 should default to three while permitting a documented model-specific override",
);
assert.equal(
  resolveImageReferenceLimits({
    imageService: "gemini_image",
    model: "gemini-2.5-flash-image",
    maxImageReferences: 20,
  }).effectiveLimit,
  20,
);
assert.equal(
  resolveImageReferenceLimits({ imageService: "pollinations", maxImageReferences: 20 }).effectiveLimit,
  0,
  "providers without reference-image transport must not receive attachments",
);
assert.equal(
  resolveImageReferenceLimits({ imageService: "xai", model: "grok-imagine-image-2.0" }).effectiveLimit,
  5,
  "Grok Imagine Image 2.0 supports five reference images",
);
assert.equal(
  resolveImageReferenceLimits({ imageService: "xai", model: "grok-imagine-image-2.0-2026-09-01" }).effectiveLimit,
  5,
  "dated Grok Imagine Image 2.0 aliases must keep the same five-image allowance",
);
assert.equal(
  resolveImageReferenceLimits({ imageService: "xai", model: "grok-2-image-1212" }).effectiveLimit,
  3,
  "older xAI image models must retain their three-reference boundary",
);
assert.deepEqual(resolveImageReferenceLimits({ imageService: "nanogpt" }), {
  source: "nanogpt",
  automaticLimit: 3,
  hardLimit: 20,
  configuredLimit: null,
  effectiveLimit: 3,
});
assert.equal(
  resolveImageReferenceLimits({ imageService: "nanogpt", maxImageReferences: 6 }).effectiveLimit,
  6,
  "NanoGPT connections may opt into a model's larger documented reference allowance",
);
assert.deepEqual(
  resolveImageReferenceLimits({
    imageService: "novelai",
    model: "proxy-model",
    baseUrl: "https://novelai-compatible.example/v1",
  }),
  {
    source: "novelai",
    automaticLimit: 16,
    hardLimit: 20,
    configuredLimit: null,
    effectiveLimit: 16,
  },
  "NovelAI-compatible proxies use the plural chat reference transport",
);
assert.equal(
  resolveImageReferenceLimits({
    imageService: "novelai",
    model: "proxy-model",
    baseUrl: "https://novelai-compatible.example/v1",
    maxImageReferences: 20,
  }).effectiveLimit,
  20,
);
assert.equal(
  resolveImageReferenceLimits({
    imageService: "stability",
    model: "sd3.5-large",
    baseUrl: "https://api.stability.ai/v1",
  }).effectiveLimit,
  0,
  "the Stability v1 adapter does not attach references",
);
assert.equal(
  resolveImageReferenceLimits({ imageService: "stability", model: "stable-image-core" }).effectiveLimit,
  0,
  "Stability Core is text-only",
);
assert.equal(
  resolveImageReferenceLimits({ imageService: "stability", model: "sd3.5-large" }).effectiveLimit,
  1,
  "the Stability v2 SD3 edit route accepts one input image",
);
assert.equal(
  resolveImageReferenceLimits({ imageService: "atlas", model: "black-forest-labs/flux-kontext-pro" }).effectiveLimit,
  1,
);
assert.equal(
  resolveImageReferenceLimits({ imageService: "atlas", model: "google/imagen-4" }).effectiveLimit,
  0,
  "Atlas models without a matching edit transport must not receive attachments",
);

const rawReferences = Array.from({ length: 21 }, (_, index) => `reference-${index}`);
const referenceCount = (request: { referenceImage?: string; referenceImages?: string[] }) =>
  request.referenceImages?.length ?? (request.referenceImage ? 1 : 0);
assert.deepEqual(selectNovelAiDirectorReferences(["location", "character"], "style", 2), {
  referenceImages: ["location", "character"],
  styleReferenceIndex: -1,
});
assert.deepEqual(selectNovelAiDirectorReferences(["location", "character"], "style", 3), {
  referenceImages: ["location", "character", "style"],
  styleReferenceIndex: 2,
});
assert.deepEqual(
  mergeSpatialLocationReferenceImages("QUJD", ["data:image/png;base64,QUJD", "REVG"], 2),
  ["QUJD", "REVG"],
  "equivalent data-URL and raw-base64 duplicates must not consume the location-first reference quota",
);
const stabilityJpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const oneComfyReference = Buffer.from("one comfy reference image payload").toString("base64");
const swarmLowerCapBody = buildSwarmUiGenerationBody(
  {
    prompt: "scene",
    maxImageReferences: 1,
    referenceImage: oneComfyReference,
    comfyWorkflow:
      '{"one":"%reference_image%","two":"%reference_image_02%","three":"%reference_image_03%","four":"%reference_image_04%"}',
  },
  "session",
);
assert.doesNotMatch(
  String(swarmLowerCapBody.comfyworkflowraw),
  /%reference_image(?:_0[1-4])?%/u,
  "a lower connection cap must not leave declared SwarmUI reference placeholders unresolved",
);
assert.throws(
  () =>
    buildSwarmUiGenerationBody(
      {
        prompt: "scene",
        comfyWorkflow: '{"one":"%reference_image%"}',
      },
      "session",
    ),
  /requires a reference image/u,
);
const stabilityFormData = buildStabilityV2FormData(
  {
    prompt: "scene",
    referenceImage: `data:image/jpeg;base64,${stabilityJpegBytes.toString("base64")}`,
  },
  "sd3.5-large",
);
const stabilityImagePart = stabilityFormData.get("image");
assert.ok(stabilityImagePart instanceof Blob);
assert.equal(stabilityImagePart.type, "image/jpeg");
assert.equal((stabilityImagePart as File).name, "reference.jpg");
assert.deepEqual(Buffer.from(await stabilityImagePart.arrayBuffer()), stabilityJpegBytes);
assert.deepEqual(
  limitImageReferencesForProvider("openai_chatgpt", OPENAI_CHATGPT_CODEX_BASE_URL, {
    prompt: "scene",
    maxImageReferences: 2,
    referenceImages: ["QUJD", "data:image/png;base64,QUJD", "REVG"],
  }).referenceImages,
  ["QUJD", "REVG"],
  "provider-boundary deduplication must happen before slicing so later unique references fill the quota",
);
assert.equal(
  referenceCount(
    limitImageReferencesForProvider("openai_chatgpt", OPENAI_CHATGPT_CODEX_BASE_URL, {
      prompt: "scene",
      referenceImages: rawReferences,
    }),
  ),
  20,
  "the final ChatGPT provider boundary must retain 20 references",
);
assert.equal(
  referenceCount(
    limitImageReferencesForProvider("openai", "https://api.openai.com/v1", {
      prompt: "scene",
      model: "gpt-image-1",
      referenceImages: rawReferences,
    }),
  ),
  16,
  "the final OpenAI provider boundary must stop at 16 references",
);
assert.equal(
  referenceCount(
    limitImageReferencesForProvider("openai", "https://api.openai.com/v1", {
      prompt: "scene",
      model: "chatgpt-image-latest",
      referenceImages: rawReferences,
    }),
  ),
  16,
  "the final OpenAI boundary must retain edits for chatgpt-image-latest",
);
assert.equal(
  referenceCount(
    limitImageReferencesForProvider("openai", "https://api.openai.com/v1", {
      prompt: "scene",
      model: "dall-e-3",
      referenceImages: rawReferences,
    }),
  ),
  0,
  "the final OpenAI boundary must remove references from DALL-E generations",
);
assert.equal(
  referenceCount(
    limitImageReferencesForProvider("automatic1111", "http://127.0.0.1:7861", {
      prompt: "scene",
      maxImageReferences: 20,
      referenceImages: rawReferences,
    }),
  ),
  1,
  "the final single-reference provider boundary must stop at one image",
);
assert.equal(
  referenceCount(
    limitImageReferencesForProvider("comfyui", "http://127.0.0.1:8188", {
      prompt: "scene",
      comfyWorkflow:
        '{"one":"%reference_image%","two":"%reference_image_02%","three":"%reference_image_03%","four":"%reference_image_04%"}',
      maxImageReferences: 20,
      referenceImages: rawReferences,
    }),
  ),
  4,
  "the final ComfyUI provider boundary must stop at four images",
);
assert.equal(
  referenceCount(
    limitImageReferencesForProvider("pollinations", "https://image.pollinations.ai", {
      prompt: "scene",
      maxImageReferences: 20,
      referenceImages: rawReferences,
    }),
  ),
  0,
  "the final provider boundary must remove references for an unsupported adapter",
);
assert.equal(
  xAIReferenceImages({
    prompt: "scene",
    model: "grok-imagine-image-2.0",
    referenceImages: rawReferences,
  }).length,
  5,
  "the xAI 2.0 adapter must preserve all five supported references",
);
assert.equal(
  xAIReferenceImages({
    prompt: "scene",
    model: "grok-imagine-image-2.0-2026-09-01",
    referenceImages: rawReferences,
  }).length,
  5,
  "the xAI adapter must align with suffixed 2.0 model aliases",
);
assert.equal(
  xAIReferenceImages({
    prompt: "scene",
    model: "grok-2-image-1212",
    referenceImages: rawReferences,
  }).length,
  3,
  "the xAI adapter must retain the older three-reference limit",
);
assert.equal(
  nanoGPTReferenceImages({
    prompt: "scene",
    model: "model-with-six-reference-slots",
    maxImageReferences: 6,
    referenceImages: rawReferences.slice(0, 6),
  }).length,
  6,
  "the NanoGPT adapter must not reapply the old global three-reference slice",
);
assert.equal(
  nanoGPTReferenceImages({
    prompt: "scene",
    model: "model-with-twenty-reference-slots",
    maxImageReferences: 20,
    referenceImages: rawReferences,
  }).length,
  20,
  "the NanoGPT adapter must honor Marinara's full configured request ceiling",
);

const seedreamRequest = buildOpenRouterImagesRequest({
  prompt: "scene",
  model: "bytedance-seed/seedream-4.5",
  maxImageReferences: 20,
  referenceImages: rawReferences,
});
assert.equal(
  (seedreamRequest.input_references as unknown[]).length,
  14,
  "OpenRouter Seedream 4.5 must retain all 14 supported references",
);
const seedreamFiveRequest = buildOpenRouterImagesRequest({
  prompt: "scene",
  model: "bytedance-seed/seedream-5-0-lite",
  maxImageReferences: 20,
  referenceImages: rawReferences,
});
assert.equal(
  (seedreamFiveRequest.input_references as unknown[]).length,
  14,
  "OpenRouter Seedream 5.0 must retain all 14 catalog-supported references",
);
const kreaRequest = buildOpenRouterImagesRequest({
  prompt: "scene",
  model: "krea/krea-2-medium",
  maxImageReferences: 20,
  referenceImages: rawReferences,
});
assert.equal(
  (kreaRequest.input_references as unknown[]).length,
  1,
  "OpenRouter Krea must retain its single-reference boundary",
);

const fallback = await resolveImageConnectionFallback(
  {
    getFallbackForImageGeneration: async () => ({
      id: "chatgpt-image-fallback",
      name: "ChatGPT image fallback",
      provider: "image_generation",
      model: "",
      baseUrl: "",
      apiKey: "",
      imageGenerationSource: "openai_chatgpt",
      imageService: "openai_chatgpt",
      maxImageReferences: 7,
    }),
  },
  "primary-image-connection",
);
assert.equal(fallback?.baseUrl, OPENAI_CHATGPT_CODEX_BASE_URL);
assert.equal(fallback?.serviceHint, "openai_chatgpt");
assert.equal(fallback?.imageGenerationSource, "openai_chatgpt");
assert.equal(fallback?.maxImageReferences, 7, "fallback requests must carry their own connection ceiling");
assert.equal(resolveImageFallbackReferenceLimit(fallback), 7);
assert.equal(
  fallbackForMariImageOperation("edit", fallback),
  fallback,
  "Mari edits may retry through a fallback that can carry the source image",
);
const generationOnlyFallback = {
  connectionId: "generation-only-fallback",
  connectionName: "Generation only",
  provider: "image_generation",
  source: "pollinations",
  baseUrl: "https://image.pollinations.ai",
  apiKey: "",
  serviceHint: "pollinations",
  model: "pollinations",
  maxImageReferences: 20,
};
assert.equal(
  fallbackForMariImageOperation("edit", generationOnlyFallback),
  undefined,
  "Mari edits must not silently become text-to-image on a fallback with no reference transport",
);
assert.equal(
  fallbackForMariImageOperation("generate", generationOnlyFallback),
  generationOnlyFallback,
  "ordinary Mari generation may still use a generation-only fallback",
);
assert.equal(
  Math.max(1, resolveImageFallbackReferenceLimit(fallback)),
  7,
  "reference selection must collect enough images for a more-capable fallback",
);
const fallbackWithLegacyServiceLabel = await resolveImageConnectionFallback(
  {
    getFallbackForImageGeneration: async () => ({
      id: "openrouter-image-fallback",
      name: "OpenRouter image fallback",
      provider: "image_generation",
      model: "vendor/custom-image-model",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "",
      imageGenerationSource: "openrouter",
      imageService: "private-image-driver",
    }),
  },
  "primary-image-connection",
);
assert.equal(
  fallbackWithLegacyServiceLabel?.source,
  "openrouter",
  "an unrecognized legacy fallback service must not erase its recognized source",
);

assert.equal(
  resolveGameImageServiceHint({ imgSource: "openai_chatgpt", imgService: "automatic1111" }),
  "automatic1111",
  "the current image service must win over a stale imported source during routing",
);
assert.equal(
  resolveSceneIllustrationImageBackend({
    imgSource: "openai",
    imgModel: "gpt-image-1",
    imgBaseUrl: "https://api.blockentropy.ai",
    imgService: "blockentropy",
  }),
  "blockentropy",
  "scene illustration orchestration must retain every explicit Engine image service",
);
assert.equal(
  resolveSceneIllustrationReferenceImageLimit({
    imgSource: "openai_chatgpt",
    imgModel: "",
    imgBaseUrl: "http://127.0.0.1:7861",
    imgService: "automatic1111",
    imgMaxImageReferences: 20,
  }),
  1,
  "storyboard reference caps must use the same service precedence as provider routing",
);

assert.equal(
  resolveSceneIllustrationReferenceImageLimit({
    imgSource: "openai_chatgpt",
    imgModel: "",
    imgBaseUrl: "https://image.pollinations.ai",
    imgService: "openai_chatgpt",
  }),
  20,
  "Storyboard must retain ChatGPT's 20-reference allowance when its driver model is Automatic",
);
assert.equal(
  resolveSceneIllustrationReferenceImageLimit({
    imgSource: "openai_chatgpt",
    imgModel: "",
    imgBaseUrl: "https://image.pollinations.ai",
    imgService: "openai_chatgpt",
    imgMaxImageReferences: 3,
  }),
  3,
  "Storyboard collection must honor a lower per-connection ceiling",
);
assert.equal(
  resolveSceneIllustrationReferenceImageLimit({
    imgSource: "pollinations",
    imgModel: "pollinations",
    imgBaseUrl: "https://image.pollinations.ai",
    imgService: "pollinations",
    imgMaxImageReferences: 20,
  }),
  0,
  "Storyboard attachment collection must disable references for an unsupported provider",
);
assert.equal(
  resolveSceneIllustrationReferenceImageLimit({
    imgSource: "comfyui",
    imgModel: "",
    imgBaseUrl: "http://127.0.0.1:8188",
    imgService: "comfyui",
    imgComfyWorkflow: '{"first":"%reference_image%","third":"%reference_image_03%"}',
    imgMaxImageReferences: 20,
  }),
  1,
  "Storyboard collection must reject sparse ComfyUI slots after the contiguous prefix",
);
assert.equal(
  resolveSceneIllustrationReferenceImageLimit({
    imgSource: "comfyui",
    imgModel: "",
    imgBaseUrl: "http://127.0.0.1:8188",
    imgService: "comfyui",
    imgComfyWorkflow:
      '{"one":"%reference_image%","two":"%reference_image_02%","three":"%reference_image_03%","four":"%reference_image_04%"}',
    imgMaxImageReferences: 20,
  }),
  4,
  "Storyboard collection must follow all four contiguous ComfyUI workflow slots",
);
assert.match(SPATIAL_LOCATION_REFERENCE_PROMPT_LINE, /Reference image 1 is the established LOCATION/iu);

// ChatGPT returns fixed provider canvases that may not match Marinara's requested
// aspect ratio. Preserve the whole generated composition at both normalization
// and display time instead of cropping twice.
const imageGenerationSource = readFileSync(
  new URL("../../packages/server/src/services/image/image-generation.ts", import.meta.url),
  "utf8",
);
const gameRoutesSource = readFileSync(
  new URL("../../packages/server/src/routes/game.routes.ts", import.meta.url),
  "utf8",
);
const illustratorReferencesSource = readFileSync(
  new URL("../../packages/server/src/services/image/illustrator-references.ts", import.meta.url),
  "utf8",
);
const gameAssetGenerationSource = readFileSync(
  new URL("../../packages/server/src/services/game/game-asset-generation.ts", import.meta.url),
  "utf8",
);
const generateRoutesSource = readFileSync(
  new URL("../../packages/server/src/routes/generate.routes.ts", import.meta.url),
  "utf8",
);
const retryAgentsRouteSource = readFileSync(
  new URL("../../packages/server/src/routes/generate/retry-agents-route.ts", import.meta.url),
  "utf8",
);
const charactersRoutesSource = readFileSync(
  new URL("../../packages/server/src/routes/characters.routes.ts", import.meta.url),
  "utf8",
);
const spritesRoutesSource = readFileSync(
  new URL("../../packages/server/src/routes/sprites.routes.ts", import.meta.url),
  "utf8",
);
const galleryRoutesSource = readFileSync(
  new URL("../../packages/server/src/routes/gallery.routes.ts", import.meta.url),
  "utf8",
);
const selfieRuntimeSource = readFileSync(
  new URL("../../packages/server/src/services/generation/conversation-selfie-command-runtime.ts", import.meta.url),
  "utf8",
);
const mariImagesSource = readFileSync(
  new URL("../../packages/server/src/services/mari-db/mari-images.service.ts", import.meta.url),
  "utf8",
);
const storyboardViewerSource = readFileSync(
  new URL("../../packages/client/src/components/game/GameStoryboardViewer.tsx", import.meta.url),
  "utf8",
);
const gameSessionReplaySource = readFileSync(
  new URL("../../packages/client/src/components/game/GameSessionReplay.tsx", import.meta.url),
  "utf8",
);
assert.match(
  imageGenerationSource,
  /resizeBase64ToExactSize\(parsed\.base64, request\.width, request\.height, "contain"\)/u,
  "ChatGPT image normalization must preserve the full provider canvas",
);
assert.match(
  imageGenerationSource,
  /allowLoopback: false, bufferResponse: false/u,
  "ChatGPT SSE responses must remain streaming so a completed image can survive a trailing transport failure",
);
assert.ok(
  (imageGenerationSource.match(/throwIfAborted\(request\.signal\)/gu) ?? []).length >= 5,
  "cancellation must be rechecked around auth, catalog, stream, and canvas-normalization boundaries",
);
assert.match(
  gameRoutesSource,
  /const storyboardMaxVisibleCharacters = MAX_STORYBOARD_VISIBLE_CHARACTERS;/u,
  "one-reference and no-reference transports must not reduce the storyboard's narrative character cap",
);
assert.match(
  illustratorReferencesSource,
  /Reference images, when attached, show one or more of these characters:/u,
  "a shared primary/fallback prompt must not claim that every collected character reference was attached",
);
assert.doesNotMatch(
  illustratorReferencesSource,
  /orderedSources\.slice\(0, maxReferences\)/u,
  "missing early Illustrator images must not prevent later valid candidates from filling the quota",
);
assert.match(
  illustratorReferencesSource,
  /referenceImages\.length >= maxReferences/u,
  "Illustrator reference loading must stop only after the usable-image quota is full",
);
assert.doesNotMatch(
  charactersRoutesSource,
  /body\.referenceImages[\s\S]{0,250}\.slice\(0, 4\)/u,
  "avatar generation must not truncate references before applying the active primary/fallback allowance",
);
assert.match(
  charactersRoutesSource,
  /resolveImageReferenceCollectionLimit\([\s\S]{0,600}imageFallback/u,
  "avatar generation must collect enough references for a more-capable fallback",
);
assert.doesNotMatch(
  `${generateRoutesSource}\n${retryAgentsRouteSource}`,
  /maxReferences:\s*Math\.max\(0, imageReferenceLimit - \(spatialLocationReferenceImage \? 1 : 0\)\)/u,
  "roleplay reference loading must fill the whole quota before location-first deduplication",
);
assert.doesNotMatch(
  gameRoutesSource,
  /maxReferenceImages:\s*Math\.max\(0, (?:storyboard)?[Rr]eferenceImageLimit - \(spatialLocationReferenceImage \? 1 : 0\)\)/u,
  "game and storyboard reference loading must fill the whole quota before location-first deduplication",
);
assert.match(
  gameRoutesSource,
  /seenReferencePayloads[\s\S]{0,800}imageReferencePayloadKey\(preferredReference\)[\s\S]{0,1200}imageReferencePayloadKey\(base64\)/u,
  "game character reference collection must deduplicate decoded payloads before consuming the quota",
);
assert.doesNotMatch(
  spritesRoutesSource,
  /images: images\.slice\(0, 16\)/u,
  "full-body sprite references must not retain the old hard-coded 16-image ceiling",
);
assert.match(
  spritesRoutesSource,
  /If reference image \$\{imageNumber\} is attached/u,
  "sprite prompts shared across primary and fallback providers must describe attachments conditionally",
);
assert.ok(
  (galleryRoutesSource.match(/\.effectivePrompt \?\?/gu) ?? []).length >= 2,
  "both Gallery image paths must persist the prompt actually rendered by a fallback",
);
assert.match(
  selfieRuntimeSource,
  /const renderedPrompt = imageResult\.effectivePrompt \?\? compiledSelfiePrompt\.prompt/u,
  "conversation selfies must emit and persist the fallback-rendered prompt",
);
assert.match(
  mariImagesSource,
  /prompt: args\.result\.effectivePrompt \?\? args\.prompt/u,
  "Mari preview assets must persist the prompt actually rendered by a fallback",
);
assert.doesNotMatch(
  gameAssetGenerationSource,
  /Reference images attached: \$\{referenceImages\.length\}/u,
  "fallback-shared scene prompts must not state an attachment count that provider clamping can change",
);
assert.match(
  storyboardViewerSource,
  /src=\{frame\.image\.url\}[\s\S]{0,300}object-contain/u,
  "the live storyboard viewer must show the full image",
);
assert.match(
  gameSessionReplaySource,
  /src=\{frame\.image!\.url\}[\s\S]{0,400}aspect-video w-full bg-black object-contain/u,
  "storyboard replay must show the full image",
);

const connectionEditorSource = readFileSync(
  new URL("../../packages/client/src/components/connections/ConnectionEditor.tsx", import.meta.url),
  "utf8",
);
assert.match(
  connectionEditorSource,
  /isLocalAuthConnectionProvider\(localProvider\) \|\| isChatGPTImageService\s*\? \{ value: "", error: null \}/u,
  "hidden ChatGPT Base URL fields must not keep blocking save through stale URL validation",
);

// ── Connection storage persistence ──

const referenceStorageDir = mkdtempSync(join(tmpdir(), "marinara-image-reference-limit-"));
const previousFileStorageDir = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = referenceStorageDir;
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { createConnectionsStorage } =
    await import("../../packages/server/src/services/storage/connections.storage.js");
  const storageDb = await createFileNativeDB();
  try {
    const storage = createConnectionsStorage(storageDb);
    const configured = await storage.create(
      createConnectionSchema.parse({
        name: "Twenty references",
        provider: "image_generation",
        baseUrl: "https://example.invalid/v1",
        imageGenerationSource: "openai_chatgpt",
        imageService: "openai_chatgpt",
        maxImageReferences: 20,
      }),
    );
    assert.equal((await storage.getById(configured.id))?.maxImageReferences, 20);
    assert.equal((await storage.duplicate(configured.id))?.maxImageReferences, 20);
    assert.equal((await storage.update(configured.id, { maxImageReferences: 3 }))?.maxImageReferences, 3);

    const automatic = await storage.create(
      createConnectionSchema.parse({
        name: "Automatic references",
        provider: "image_generation",
        baseUrl: "https://example.invalid/v1",
      }),
    );
    assert.equal(
      (await storage.getById(automatic.id))?.maxImageReferences,
      null,
      "old or omitted connection input must persist Automatic as null",
    );
  } finally {
    await storageDb._fileStore.close();
  }
} finally {
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
  rmSync(referenceStorageDir, { recursive: true, force: true });
}

console.log("openai-chatgpt-image regression passed");
