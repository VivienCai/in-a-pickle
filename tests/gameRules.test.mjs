import assert from "node:assert/strict";
import test from "node:test";

import {
  hitsCeilingSpikes,
  isQteSuccess,
  isQteVolumeInTarget,
  QTE_DURATION_TICKS,
  QTE_FIRST_TICK,
  QTE_INTERVAL_TICKS,
  TICK_MS,
} from "../src/gameRules.ts";

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

test("ceiling collision includes the pickle height", () => {
  assert.equal(hitsCeilingSpikes(259), false);
  assert.equal(hitsCeilingSpikes(260), true);
});
