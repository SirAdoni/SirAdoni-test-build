import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile, mkdir, writeFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
await mkdir(".tmp/portrait-style-proof", { recursive: true });
const out = resolve(".tmp/portrait-style-proof/proof.cjs");
await build({
  entryPoints: ["packages/server/src/services/game/game-asset-generation.ts"],
  bundle: true,
  platform: "node",
  define: {
    "import.meta.url": JSON.stringify(pathToFileURL(resolve("packages/server/src/config/runtime-config.ts")).href),
  },
  format: "cjs",
  packages: "external",
  outfile: out,
  plugins: [
    {
      name: "capture-image-request",
      setup(b) {
        b.onResolve({ filter: /^@marinara-engine\/shared$/ }, () => ({
          path: resolve("packages/shared/src/index.ts"),
        }));
        b.onLoad({ filter: /game-asset-generation\.ts$/ }, async (args) => ({
          loader: "ts",
          resolveDir: resolve("packages/server/src/services/game"),
          contents: (await readFile(args.path, "utf8")).replace(
            'import { generateImage, type ImageGenRequest, type ImageGenResult } from "../image/image-generation.js";',
            `import type { ImageGenRequest, ImageGenResult } from "../image/image-generation.js";
const generateImage = async (...args: any[]) => { globalThis.__portraitRequest = args[4]; if (globalThis.__portraitResult) return globalThis.__portraitResult; throw new Error('Synthetic provider capture; no image sent'); };`,
          ),
        }));
      },
    },
  ],
});
// Resolve runtime dependencies using the server's installed package scope.
const source = await readFile(out, "utf8");
await writeFile(
  out,
  `require = require('node:module').createRequire(${JSON.stringify(resolve("packages/server/package.json"))});\n` +
    source,
);
process.env.NODE_ENV = "production";
process.env.LOG_LEVEL = "silent";
process.env.DATA_DIR = resolve(".tmp/portrait-style-proof/data");
const require = createRequire(import.meta.url);
const { generateNpcPortrait, applyNpcPortraitStyleReference } = require(out);
const request = {
  chatId: "synthetic-style-proof",
  npcName: "Synthetic portrait",
  appearance: "An ordinary older man with a broad nose and dark brown skin",
  imgModel: "synthetic",
  imgBaseUrl: "http://unused.invalid",
  imgApiKey: "",
  force: true,
  styleReferenceImage: "SYNTHETIC_REFERENCE",
  dynamicPromptGenerator: async () => "An ordinary older man with a broad nose and dark brown skin.",
};
await generateNpcPortrait(request);
assert.deepEqual(globalThis.__portraitRequest.referenceImages, ["SYNTHETIC_REFERENCE"]);
assert.match(globalThis.__portraitRequest.prompt, /style sample only/);
assert.match(globalThis.__portraitRequest.prompt, /ordinary older man/);
assert.match(globalThis.__portraitRequest.prompt, /Do not copy/);
assert.doesNotMatch(globalThis.__portraitRequest.prompt, /without beautification/);
await generateNpcPortrait({
  ...request,
  appearance: "Adult woman with a softly rounded face, straight tied-back hair, moss-green gown and charcoal apron.",
  dynamicPromptGenerator: async () => "A generic fantasy protagonist in an embroidered cloak and jewelry.",
});
assert.match(
  globalThis.__portraitRequest.prompt,
  /Required canonical NPC visual profile: Adult woman with a softly rounded face/,
);
assert.match(globalThis.__portraitRequest.prompt, /moss-green gown and charcoal apron/);
await generateNpcPortrait({ ...request, promptOverride: "Keep this exact custom description." });
assert.match(globalThis.__portraitRequest.prompt, /Keep this exact custom description\.$/);
assert.match(globalThis.__portraitRequest.prompt, /style sample only/);
await generateNpcPortrait({ ...request, styleReferenceImage: undefined });
assert.equal(globalThis.__portraitRequest.referenceImages, undefined);
assert.doesNotMatch(globalThis.__portraitRequest.prompt, /style sample only/);
assert.equal(applyNpcPortraitStyleReference("Unchanged"), "Unchanged");
const isolationId = `acceptance-proof-${Date.now()}`;
const avatarDir = resolve(process.env.DATA_DIR, "avatars/npc", isolationId);
globalThis.__portraitResult = {
  base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBvQAAAAASUVORK5CYII=",
  mimeType: "image/png",
};
let reviews = 0;
assert.equal(
  await generateNpcPortrait({
    ...request,
    chatId: isolationId,
    reviewPortrait: async () => {
      reviews++;
      assert.deepEqual(
        await readdir(avatarDir).catch(() => []),
        [],
        "Rejected bytes must not be published before acceptance",
      );
      return { accepted: false, feedback: "Wrong face and clothes" };
    },
  }),
  null,
);
assert.equal(reviews, 2);
assert.match(globalThis.__portraitRequest.prompt, /Required correction.*Wrong face/);
assert.deepEqual(await readdir(avatarDir).catch(() => []), []);
const acceptedUrl = await generateNpcPortrait({
  ...request,
  chatId: isolationId,
  reviewPortrait: async () => ({ accepted: true, feedback: "Matches canonical appearance" }),
});
assert.ok(acceptedUrl);
const files = await readdir(avatarDir);
assert.equal(files.length, 1);
const saved = await readFile(resolve(avatarDir, files[0]));
await generateNpcPortrait({
  ...request,
  chatId: isolationId,
  reviewPortrait: async () => ({ accepted: false, feedback: "Replacement rejected" }),
});
assert.deepEqual(
  await readFile(resolve(avatarDir, files[0])),
  saved,
  "Rejected replacement must preserve the old portrait",
);
process.stdout.write(
  "Portrait provider handoff: reference attachment, dynamic prompt, manual prompt, and no-reference compatibility passed.\n",
);
