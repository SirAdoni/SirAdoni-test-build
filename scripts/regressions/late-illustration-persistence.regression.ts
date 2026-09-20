import assert from "node:assert/strict";
import { generateIllustratorImageVariants } from "../../packages/server/src/services/image/illustrator-image-variants.js";
const events: string[] = [];
const gallery: string[] = [];
const results = await generateIllustratorImageVariants({
  count: 3,
  generate: async (index) => {
    events.push(`generate:${index}`);
    if (index === 1) throw new Error("Later image failed after the browser left");
    if (index > 0) assert.equal(gallery[0], "image:0", "First image must already be saved");
    return `image:${index}`;
  },
  onVariantReady: async (result) => {
    gallery.push(result);
    events.push(`saved:${result}`);
  },
});
assert.deepEqual(results, ["image:0", "image:2"]);
assert.deepEqual(gallery, results);
assert.deepEqual(events.slice(0, 3), ["generate:0", "saved:image:0", "generate:1"]);
