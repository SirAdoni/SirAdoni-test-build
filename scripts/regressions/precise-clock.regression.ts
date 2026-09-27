import assert from "node:assert/strict";
import { addMinutes, elapsedGameMinutes } from "../../packages/server/src/services/game/time.service.js";
import { buildSceneAnalyzerUserPrompt } from "../../packages/server/src/services/sidecar/scene-analyzer.js";
import { validateSceneClockEvidence } from "../../packages/server/src/services/sidecar/scene-postprocess.js";

const before = { day: 2, hour: 23, minute: 50 };
const after = addMinutes(before, 20);
assert.deepEqual(after, { day: 3, hour: 0, minute: 10 });
assert.equal(elapsedGameMinutes(before, after), 20);

const prompt = buildSceneAnalyzerUserPrompt("After twenty minutes, the watch changes.", undefined, {
  currentState: "dialogue",
  availableBackgrounds: [],
  availableSfx: [],
  activeWidgets: [],
  trackedNpcs: [],
  characterNames: [],
  currentBackground: null,
  currentMusic: null,
  currentWeather: null,
  currentTimeOfDay: "night",
  currentGameTime: { day: 2, hour: 23, minute: 50 },
});
assert.match(prompt, /Exact server clock: Day 2, 23:50/u);
assert.match(prompt, /elapsedMinutes/iu);
assert.match(prompt, /timeEvidence/iu);
assert.match(prompt, /phase label alone never advances the exact clock/iu);

const completed = "After 20 minutes, the watch changes.";
assert.deepEqual(validateSceneClockEvidence({ elapsedMinutes: 20, timeEvidence: completed }, [completed]), {
  elapsedMinutes: 20,
  timeEvidence: completed,
});
assert.deepEqual(
  validateSceneClockEvidence({ elapsedMinutes: 20, timeEvidence: "We will meet in 20 minutes." }, [
    "We will meet in 20 minutes.",
  ]),
  {
    elapsedMinutes: 0,
    timeEvidence: null,
  },
);
assert.deepEqual(
  validateSceneClockEvidence({ elapsedMinutes: 20, timeEvidence: "Wait 20 minutes." }, ["Wait 20 minutes."]),
  {
    elapsedMinutes: 0,
    timeEvidence: null,
  },
);
assert.deepEqual(
  validateSceneClockEvidence({ elapsedMinutes: 20, timeEvidence: "After twenty minutes." }, ["After twenty minutes."]),
  {
    elapsedMinutes: 0,
    timeEvidence: null,
  },
);
assert.deepEqual(
  validateSceneClockEvidence({ elapsedMinutes: 20, timeEvidence: "After 20 minutes." }, ["After 2 minutes."]),
  {
    elapsedMinutes: 0,
    timeEvidence: null,
  },
);
assert.deepEqual(
  validateSceneClockEvidence({ elapsedMinutes: 20, timeEvidence: "After 2 hours." }, ["After 2 hours."]),
  {
    elapsedMinutes: 0,
    timeEvidence: null,
  },
);
assert.deepEqual(validateSceneClockEvidence({ elapsedMinutes: 20.5, timeEvidence: completed }, [completed]), {
  elapsedMinutes: 0,
  timeEvidence: null,
});
assert.deepEqual(
  validateSceneClockEvidence({ elapsedMinutes: 20, timeEvidence: "After 20 minutes we will leave." }, [
    "After 20 minutes we will leave.",
  ]),
  {
    elapsedMinutes: 0,
    timeEvidence: null,
  },
);
const waited = "They waited 20 minutes, then continued.";
assert.deepEqual(validateSceneClockEvidence({ elapsedMinutes: 20, timeEvidence: waited }, [waited]), {
  elapsedMinutes: 20,
  timeEvidence: waited,
});
assert.deepEqual(validateSceneClockEvidence({ elapsedMinutes: 1441, timeEvidence: completed }, [completed]), {
  elapsedMinutes: 0,
  timeEvidence: null,
});
assert.deepEqual(validateSceneClockEvidence({ elapsedMinutes: -1, timeEvidence: completed }, [completed]), {
  elapsedMinutes: 0,
  timeEvidence: null,
});
