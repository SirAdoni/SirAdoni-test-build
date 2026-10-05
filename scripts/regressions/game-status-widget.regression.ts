import assert from "node:assert/strict";
import { projectGameStatusStats } from "../../packages/client/src/components/game/game-status-widget";

const configured = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  bars: [],
  rpgStats: { enabled: true, pools: [], attributes: [], ...overrides },
});
const bar = (projection: ReturnType<typeof projectGameStatusStats>, label: string) =>
  projection.bars.find((item) => item.label === label);

assert.equal(
  bar(
    projectGameStatusStats({
      rpgStats: { stats: [{ name: "HP", value: 60, max: 100 }] },
      config: { ...configured(), bars: [{ name: "HP", value: 100, max: 100 }] },
    }),
    "HP",
  )?.value,
  60,
);
assert.equal(bar(projectGameStatusStats({ rpgStats: { hp: { current: 60, max: 80 } } }), "HP")?.value, 60);
assert.equal(
  bar(
    projectGameStatusStats({
      rpgStats: { stats: [{ name: "HP", value: 100, max: 100 }] },
      config: { ...configured(), bars: [{ name: "HP", value: 40, max: 120 }] },
    }),
    "HP",
  )?.max,
  120,
);
assert.equal(
  bar(
    projectGameStatusStats({
      rpgStats: { stats: [{ name: "HP", value: 60, max: 100, color: "live" }] },
      config: { ...configured(), bars: [{ name: "HP", value: 40, max: 100, color: "configured" }] },
    }),
    "HP",
  )?.color,
  "configured",
);

const attrs = projectGameStatusStats({
  rpgStats: { attributes: { STR: 31 } },
  config: { ...configured(), rpgStats: { enabled: true, attributes: [{ name: "STR", value: 26 }] } },
});
assert.deepEqual(
  attrs.attributes.map(({ label, value }) => ({ label, value })),
  [{ label: "STR", value: 31 }],
);
const newAndRemoved = projectGameStatusStats({
  rpgStats: { stats: [{ name: "Old", value: 2, max: 3 }] },
  config: { ...configured(), bars: [{ name: "New", value: 2, max: 4 }] },
});
assert.deepEqual(
  newAndRemoved.bars.map(({ label }) => label),
  ["New"],
);
const noDuplicate = projectGameStatusStats({
  rpgStats: { hp: { current: 60, max: 80 }, pools: [{ name: "HP", value: 60, max: 80 }] },
});
assert.equal(noDuplicate.bars.filter(({ label }) => label === "HP").length, 1);
const unicode = projectGameStatusStats({
  rpgStats: {
    stats: [
      { name: "Å", value: 1, max: 2 },
      { name: "A", value: 2, max: 3 },
    ],
  },
});
assert.equal(new Set(unicode.bars.map(({ id }) => id)).size, 2);
const legacyConfig = projectGameStatusStats({
  config: JSON.stringify({ enabled: true, bars: [], rpgStats: { enabled: true, hp: { value: 100, max: 100 } } }),
  rpgStats: { hp: { current: 42, max: 100 } },
});
assert.equal(
  bar(legacyConfig, "HP")?.value,
  42,
  "legacy configured HP remains visible when pools were never configured",
);
console.info("game-status-widget regression passed");
