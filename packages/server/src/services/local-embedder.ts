// ──────────────────────────────────────────────
// Service: Local Embedder
// ──────────────────────────────────────────────
// Runs a small sentence-transformer model (all-MiniLM-L6-v2, ~23MB)
// locally via ONNX Runtime for zero-cost, zero-config embeddings.
//
// Cross-platform:
//   - onnxruntime-node (native) when its platform binding is installed
//   - disabled gracefully elsewhere (incl. Termux/Android and mismatched
//     Apple Silicon/Rosetta installs)
//
// The model is downloaded once from HuggingFace Hub on first use
// and cached in data/models/.
import { existsSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";
import { DATA_DIR } from "../utils/data-dir.js";
import { logger } from "../lib/logger.js";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const CACHE_DIR = join(DATA_DIR, "models");
const isLite = process.env.MARINARA_LITE === "true" || process.env.MARINARA_LITE === "1";
const require = createRequire(import.meta.url);

// Singleton state
let pipeline: any = null;
let loadingPromise: Promise<any> | null = null;
let loadFailed = false;
let nativeBindingChecked = false;

function resolveOnnxRuntimeBindingPath(): string | null {
  try {
    const packageJsonPath = require.resolve("onnxruntime-node/package.json");
    return join(dirname(packageJsonPath), "bin", "napi-v6", process.platform, process.arch, "onnxruntime_binding.node");
  } catch {
    return null;
  }
}

function hasNativeOnnxRuntimeBinding(): boolean {
  const bindingPath = resolveOnnxRuntimeBindingPath();
  if (bindingPath && existsSync(bindingPath)) return true;

  if (!nativeBindingChecked) {
    nativeBindingChecked = true;
    logger.info(
      "[local-embedder] Local memory embeddings disabled: onnxruntime-node native binding is unavailable for %s/%s. Reinstall dependencies with the same Node architecture used to run Marinara.",
      process.platform,
      process.arch,
    );
  }

  return false;
}

/**
 * Lazy-load the feature-extraction pipeline.
 * Returns null if the library or model can't be loaded.
 */
async function getPipeline(): Promise<any> {
  if (pipeline) return pipeline;
  if (isLite) return null;
  if (loadFailed) return null;
  if (!hasNativeOnnxRuntimeBinding()) {
    loadFailed = true;
    return null;
  }
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      // Dynamic import — won't crash the server if package is missing
      const { pipeline: createPipeline, env } = await import("@huggingface/transformers");

      // Configure cache directory and disable remote model fetching checks
      env.cacheDir = CACHE_DIR;
      // Disable browser-specific features
      env.allowLocalModels = true;
      env.useBrowserCache = false;

      logger.info("[local-embedder] Loading model %s...", MODEL_ID);
      const start = Date.now();

      const p = await createPipeline("feature-extraction", MODEL_ID, {
        dtype: "q8", // quantized for speed + small size
      });

      const elapsed = Date.now() - start;
      logger.info("[local-embedder] Model loaded in %dms", elapsed);

      pipeline = p;
      return p;
    } catch (err) {
      loadFailed = true;
      logger.warn(err, "[local-embedder] Failed to load local embedding model");
      return null;
    } finally {
      loadingPromise = null;
    }
  })();

  return loadingPromise;
}

function isAborted(signal?: AbortSignal) {
  return signal?.aborted === true;
}

/**
 * Generate embeddings for one or more texts using the local model.
 * Returns an array of float vectors, or null if local embedding is unavailable.
 */
export async function localEmbed(texts: string[], signal?: AbortSignal): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  if (isAborted(signal)) return null;

  const p = await getPipeline();
  if (!p) return null;
  if (isAborted(signal)) return null;

  try {
    const results: number[][] = [];
    // Process one at a time to keep memory usage predictable
    for (const text of texts) {
      if (isAborted(signal)) return null;
      const output = await p(text, { pooling: "mean", normalize: true });
      if (isAborted(signal)) return null;
      // output.tolist() returns [[...floats]]
      const arr: number[][] = output.tolist();
      results.push(arr[0]!);
    }
    return results;
  } catch (err) {
    logger.error(err, "[local-embedder] Embedding failed");
    return null;
  }
}

/**
 * Check if the local embedder is available (model loaded or loadable).
 */
export function isLocalEmbedderAvailable(): boolean {
  if (isLite) return false;
  if (loadFailed) return false;
  return hasNativeOnnxRuntimeBinding();
}
