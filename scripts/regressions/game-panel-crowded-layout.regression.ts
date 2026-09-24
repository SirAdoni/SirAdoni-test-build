import assert from "node:assert/strict";
import {
  GAME_READING_PANEL_IDS,
  gameReadingPanelFloor,
  resolveGamePanelLayout,
  type GamePanelLayoutItem,
} from "../../packages/client/src/lib/game-panel-layout.js";

// The 11 desktop panels of a crowded HUD at 1440x900 (surface 1440x849),
// measured from the live game: natural content heights and the default anchors a
// fresh profile gives them (left-column widgets pile up at 48 + slot * 44).
const SURFACE = { width: 1440, height: 849 };
type Spec = { id: string; x: number; y: number; width: number; height: number; firm?: boolean; minHeight?: number };
const SESSION_12: Spec[] = [
  { id: "toolbar", x: 528, y: 48, width: 900, height: 34 },
  { id: "map", x: 12, y: 48, width: 320, height: 382 },
  { id: "narration", x: 272, y: 608, width: 896, height: 225 },
  { id: "widget:widget_a", x: 12, y: 400, width: 384, height: 306 },
  { id: "widget:widget_b", x: 12, y: 444, width: 336, height: 217 },
  { id: "widget:widget_c", x: 12, y: 488, width: 448, height: 161 },
  { id: "widget:widget_d", x: 12, y: 532, width: 348, height: 87 },
  { id: "widget:widget_e", x: 12, y: 576, width: 325, height: 68 },
  { id: "widget:widget_f", x: 701, y: 400, width: 727, height: 199 },
  { id: "scene-presence", x: 560, y: 746, width: 320, height: 87 },
  { id: "storyboard", x: 1060, y: 48, width: 368, height: 392 },
];

type Resolved = { id: string; x: number; y: number; width: number; height: number; natural: number };

function resolve(specs: Spec[], bounds = SURFACE): { overflow: boolean; panels: Resolved[] } {
  const panels = new Map<string, Resolved>();
  const items: GamePanelLayoutItem[] = specs.map((spec) => {
    const state: Resolved = { ...spec, natural: spec.height };
    panels.set(spec.id, state);
    return {
      id: spec.id,
      x: spec.x,
      y: spec.y,
      preferredX: spec.x,
      preferredY: spec.y,
      width: spec.width,
      height: spec.height,
      locked: true,
      priority: spec.id === "narration" ? 0 : spec.id === "map" || spec.id === "toolbar" ? 1 : 2,
      firmHeight: spec.firm,
      minHeight: spec.minHeight,
      reading: GAME_READING_PANEL_IDS.has(spec.id),
      setPosition: (x, y) => {
        state.x = x;
        state.y = y;
      },
      setHeightLimit: (height) => {
        state.height = Math.min(state.natural, height);
      },
    };
  });
  const overflow = resolveGamePanelLayout(items, bounds);
  return { overflow, panels: [...panels.values()] };
}

function overlaps(panels: Resolved[]): string[] {
  const hits: string[] = [];
  for (let i = 0; i < panels.length; i += 1)
    for (let j = i + 1; j < panels.length; j += 1) {
      const a = panels[i]!;
      const b = panels[j]!;
      if (a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y)
        hits.push(`${a.id} x ${b.id}`);
    }
  return hits;
}

function inBounds(panels: Resolved[], bounds = SURFACE): void {
  for (const panel of panels) {
    assert.ok(panel.x >= 0 && panel.x + panel.width <= bounds.width + 0.5, `${panel.id} stays inside horizontally`);
    assert.ok(panel.y >= 0 && panel.y + panel.height <= bounds.height + 0.5, `${panel.id} stays inside vertically`);
  }
}

// 1. The crowded default layout no longer crushes every panel to 64px. Before the fix one
//    wide widget that the greedy pass stranded forced every cap down to 64px.
{
  const { overflow, panels } = resolve(SESSION_12);
  assert.equal(overflow, false, "the crowded HUD fits at 1440x900");
  assert.deepEqual(overlaps(panels), [], "no panel overlaps another after reflow");
  inBounds(panels);
  const byId = new Map(panels.map((panel) => [panel.id, panel]));
  const floor = gameReadingPanelFloor(SURFACE.height);
  for (const id of ["narration", "map", "storyboard"])
    assert.ok(
      byId.get(id)!.height >= Math.min(byId.get(id)!.natural, floor),
      `${id} keeps at least the reading floor (${byId.get(id)!.height}px)`,
    );
  assert.equal(byId.get("narration")!.height, 225, "narration keeps its full natural height");
  // This HUD cannot fit at full size on a 1440x900 screen, so widgets may become scrolling
  // windows, but never below the panel minimum and never the reading panels.
  const crushed = panels.filter((panel) => panel.height < Math.min(panel.natural, 64)).map((panel) => panel.id);
  assert.deepEqual(crushed, [], "no panel is squeezed below the panel minimum");
}

// 2. Crushed-era anchors: positions saved while every panel was 64px tall pile the
//    panels 72px apart. With real heights back they must reflow apart, not stay stuck.
{
  const crushedEra = SESSION_12.map((spec) => {
    const pile: Record<string, [number, number]> = {
      map: [12, 29],
      "widget:widget_a": [12, 316],
      "widget:widget_b": [12, 388],
      "widget:widget_c": [12, 460],
      "widget:widget_d": [12, 532],
      "widget:widget_e": [12, 680],
      "widget:widget_f": [701, 483],
      "scene-presence": [560, 694],
      narration: [272, 766],
      storyboard: [1060, 70],
    };
    const [x, y] = pile[spec.id] ?? [spec.x, spec.y];
    return { ...spec, x, y };
  });
  const { panels } = resolve(crushedEra);
  assert.deepEqual(overlaps(panels), [], "crushed-era anchors recover to a non-overlapping layout");
  inBounds(panels);
  const floor = gameReadingPanelFloor(SURFACE.height);
  for (const panel of panels.filter((candidate) => GAME_READING_PANEL_IDS.has(candidate.id)))
    assert.ok(
      panel.height >= Math.min(panel.natural, floor),
      `${panel.id} is not crushed after recovering (${panel.height}px)`,
    );
}

// 3. A layout saved before the rebuild (map fixed at 420px by hand) keeps its sizes.
{
  const saved = SESSION_12.map((spec) => (spec.id === "map" ? { ...spec, height: 420, firm: true } : spec));
  const { panels } = resolve(saved);
  const byId = new Map(panels.map((panel) => [panel.id, panel]));
  assert.equal(byId.get("map")!.height, 420, "the saved manual map height survives");
  assert.equal(byId.get("narration")!.height, 225, "narration keeps its natural height");
  assert.deepEqual(overlaps(panels), [], "the saved layout still resolves without overlaps");
}

// 4. A screen too small for everything: reading panels keep the reading floor and the
//    fallback keeps the least crowded attempt instead of crushing every panel.
{
  const small = { width: 1024, height: 600 };
  const specs: Spec[] = [
    ...SESSION_12,
    { id: "widget:extra_a", x: 12, y: 48, width: 700, height: 400 },
    { id: "widget:extra_b", x: 12, y: 48, width: 700, height: 400 },
  ].map((spec) => ({ ...spec, width: Math.min(spec.width, small.width) }));
  const { panels } = resolve(specs, small);
  const floor = gameReadingPanelFloor(small.height);
  for (const id of ["narration", "map", "storyboard"]) {
    const panel = panels.find((candidate) => candidate.id === id)!;
    assert.ok(panel.height >= Math.min(panel.natural, floor), `${id} keeps the reading floor on a tiny screen`);
  }
  inBounds(panels, small);
}

// 5. Reflow is deterministic: the same input (a ResizeObserver pass repeating, served from
//    the variant cache the second time) gives the same layout.
{
  const first = resolve(SESSION_12).panels;
  const again = resolve(SESSION_12).panels;
  for (const panel of first) {
    const next = again.find((candidate) => candidate.id === panel.id)!;
    assert.ok(
      Math.abs(next.x - panel.x) < 0.5 && Math.abs(next.y - panel.y) < 0.5 && next.height === panel.height,
      `${panel.id} resolves the same way on a repeated pass`,
    );
  }
}

// 6. A landscape tablet (1024x768, surface 1024x717): the crowded ladder used to squeeze narration to the
//    reading floor (a third of the surface), scrolling its composer out of view. A panel's own minHeight
//    (the narration composer plus some context) is a floor the widgets give way to instead.
{
  const tablet = { width: 1024, height: 717 };
  const specs: Spec[] = [
    { id: "toolbar", x: 100, y: 0, width: 520, height: 44 },
    { id: "map", x: 12, y: 48, width: 320, height: 300 },
    { id: "storyboard", x: 644, y: 48, width: 368, height: 280 },
    { id: "scene-presence", x: 352, y: 350, width: 320, height: 110 },
    { id: "widget:widget_a", x: 12, y: 360, width: 300, height: 260 },
    { id: "widget:widget_b", x: 700, y: 340, width: 300, height: 240 },
    { id: "narration", x: 64, y: 330, width: 896, height: 389, minHeight: 389 },
  ];
  const before = resolve(specs.map(({ minHeight: _floor, ...spec }) => spec), tablet);
  assert.ok(
    before.panels.find((panel) => panel.id === "narration")!.height < 389,
    "without a floor the crowded tablet squeezes narration",
  );
  const { panels } = resolve(specs, tablet);
  const narration = panels.find((panel) => panel.id === "narration")!;
  assert.equal(narration.height, 389, "narration keeps its composer floor on a crowded tablet");
  inBounds([narration], tablet);
}

console.info("Game panel crowded layout regression passed");
