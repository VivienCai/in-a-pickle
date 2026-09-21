import assert from "node:assert/strict";
import test from "node:test";

import {
  BASE_RUN_SPEED,
  getQteControlPlayerIds,
  getQteSafetyEndX,
  getRunSpeed,
  hitsCeilingSpikes,
  hitsObstacle,
  isQteSuccess,
  isQtePathClear,
  isQteVolumeInTarget,
  QTE_DURATION_TICKS,
  QTE_FIRST_TICK,
  QTE_INTERVAL_TICKS,
  TICK_MS,
} from "../src/gameRules.ts";

test("run speed increases very gradually and stays capped", () => {
  assert.equal(getRunSpeed(0), BASE_RUN_SPEED);
  assert.equal(getRunSpeed(60_000 / TICK_MS), BASE_RUN_SPEED + 6);
  assert.equal(getRunSpeed(10 * 60_000 / TICK_MS), 170);
});

test("QTE safety window covers the full challenge plus a buffer", () => {
  assert.equal(getQteSafetyEndX(1_000, 150), 1_490);
});

test("QTEs wait for a clear path without removing obstacles", () => {
  const passedObstacle = { id: 1, kind: "floor", x: 900, y: 0, width: 60, height: 50 };
  const upcomingObstacle = { id: 2, kind: "utensil", x: 1_300, y: 160, width: 125, height: 35 };
  const obstacles = [passedObstacle, upcomingObstacle];

  assert.equal(isQtePathClear(obstacles, 1_000, 1_490), false);
  assert.equal(isQtePathClear(obstacles, 1_000, 1_250), true);
  assert.equal(obstacles.length, 2);
});

test("QTE timing matches the playtest cadence", () => {
  assert.equal(QTE_FIRST_TICK * TICK_MS, 8_000);
  assert.equal(QTE_INTERVAL_TICKS * TICK_MS, 12_000);
  assert.equal(QTE_DURATION_TICKS * TICK_MS, 3_000);
});

test("QTE target ranges include their documented boundaries", () => {
  assert.equal(isQteVolumeInTarget("quiet", 0.18), true);
  assert.equal(isQteVolumeInTarget("quiet", 0.181), false);
  assert.equal(isQteVolumeInTarget("steady", 0.3), true);
  assert.equal(isQteVolumeInTarget("steady", 0.58), true);
  assert.equal(isQteVolumeInTarget("steady", 0.59), false);
});

test("QTE success requires at least 65 percent of its ticks", () => {
  assert.equal(isQteSuccess(38, 60), false);
  assert.equal(isQteSuccess(39, 60), true);
});

test("solo QTEs mute every player except the selected driver", () => {
  const soloQte = {
    type: "solo",
    prompt: "Viv, take the wheel!",
    targetPlayerId: "player-2",
    targetPlayerName: "Viv",
    remainingTicks: 60,
    totalTicks: 60,
    successfulTicks: 0,
  };

  assert.deepEqual(getQteControlPlayerIds(soloQte, ["player-1", "player-2", "player-3"]), ["player-2"]);
  assert.deepEqual(getQteControlPlayerIds(soloQte, ["player-1", "player-3"]), []);
  assert.deepEqual(getQteControlPlayerIds(null, ["player-1", "player-2"]), ["player-1", "player-2"]);
});

test("ceiling collision includes the pickle height", () => {
  assert.equal(hitsCeilingSpikes(259), false);
  assert.equal(hitsCeilingSpikes(260), true);
});

test("flying utensils leave a quiet route underneath", () => {
  const utensil = { id: 2, kind: "utensil", x: 650, y: 160, width: 125, height: 35 };
  assert.equal(hitsObstacle(111, utensil), false);
  assert.equal(hitsObstacle(113, utensil), true);
});

test("floor obstacles still require the pickle to rise", () => {
  const floorObstacle = { id: 1, kind: "floor", x: 650, y: 0, width: 40, height: 35 };
  assert.equal(hitsObstacle(34, floorObstacle), true);
  assert.equal(hitsObstacle(35, floorObstacle), false);
});
