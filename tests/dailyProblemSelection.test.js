// Unit tests for the daily-problem selection policy and IST day helpers.
// No database: the URL below is never connected to (nothing here queries).
process.env.DATABASE_URL = "postgresql://unit-test@127.0.0.1:1/no-database";

import test from "node:test";
import assert from "node:assert/strict";

const { pickDailyProblem, COOLDOWN_DAYS } = await import("../src/services/dailyProblemService.js");
const {
  getISTDateString,
  isISTDateString,
  addDaysToISTDate,
  startOfISTDay,
  nextISTMidnight,
} = await import("../src/services/streakService.js");

// Deterministic PRNG (mulberry32) so simulations are reproducible.
function seeded(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Runs the selector for `days` consecutive days, as the scheduler would. */
function simulate(candidates, days, random) {
  const picks = [];
  const counts = new Map();
  for (let d = 0; d < days; d++) {
    const recent = [picks[d - 1] ?? null, null];
    for (let back = 2; back <= COOLDOWN_DAYS; back++) recent.push(picks[d - back] ?? null);
    const pick = pickDailyProblem({ candidates, featureCounts: counts, recent, random });
    picks.push(pick);
    counts.set(pick, (counts.get(pick) ?? 0) + 1);
  }
  return picks;
}

const ids = (n) => Array.from({ length: n }, (_, i) => `p${i + 1}`);

test("no candidates gives null", () => {
  assert.equal(pickDailyProblem({ candidates: [] }), null);
});

test("a single candidate is always picked, even if featured yesterday", () => {
  assert.equal(pickDailyProblem({ candidates: ["only"], recent: ["only", "only"] }), "only");
});

test("two candidates alternate (yesterday is never repeated)", () => {
  const picks = simulate(ids(2), 30, seeded(1));
  for (let i = 1; i < picks.length; i++) assert.notEqual(picks[i], picks[i - 1], `day ${i}`);
});

test("nothing repeats within the cooldown when the pool is large enough", () => {
  const picks = simulate(ids(12), 200, seeded(2));
  for (let i = 0; i < picks.length; i++) {
    for (let back = 1; back <= COOLDOWN_DAYS && i - back >= 0; back++) {
      assert.notEqual(picks[i], picks[i - back], `day ${i} repeats day ${i - back}`);
    }
  }
});

test("small pools shrink the cooldown but still avoid yesterday", () => {
  const picks = simulate(ids(3), 60, seeded(3));
  for (let i = 1; i < picks.length; i++) assert.notEqual(picks[i], picks[i - 1], `day ${i}`);
  // With 3 problems and a 7-day window, the only valid schedule is a strict rotation.
  for (let i = 3; i < picks.length; i++) assert.equal(picks[i], picks[i - 3], `day ${i}`);
});

test("every problem is featured once before any is featured twice", () => {
  const pool = ids(10);
  const picks = simulate(pool, 30, seeded(4));
  for (let cycle = 0; cycle < 3; cycle++) {
    const slice = picks.slice(cycle * 10, cycle * 10 + 10);
    assert.equal(new Set(slice).size, 10, `cycle ${cycle} has a repeat: ${slice.join(",")}`);
  }
});

test("cycles are shuffled, not a fixed rotation", () => {
  const picks = simulate(ids(10), 40, seeded(5));
  const cycles = [0, 1, 2, 3].map((c) => picks.slice(c * 10, c * 10 + 10).join(","));
  assert.ok(new Set(cycles).size > 1, "all cycles came out in the same order");
});

test("newly added problems are preferred over already-featured ones", () => {
  const featureCounts = new Map([["old1", 3], ["old2", 3], ["old3", 2]]);
  const pick = pickDailyProblem({
    candidates: ["old1", "old2", "old3", "new1"],
    featureCounts,
    recent: [],
    random: () => 0.99,
  });
  assert.equal(pick, "new1");
});

test("tomorrow's problem (when already assigned) is avoided too", () => {
  for (let r = 0; r < 1; r += 0.1) {
    const pick = pickDailyProblem({ candidates: ["a", "b", "c"], recent: ["a", "b"], random: () => r });
    assert.equal(pick, "c");
  }
});

test("IST date helpers", () => {
  assert.equal(getISTDateString(new Date("2026-11-06T18:29:59.999Z")), "2026-11-06");
  assert.equal(getISTDateString(new Date("2026-11-06T18:30:00.000Z")), "2026-11-07");
  assert.equal(getISTDateString("not a date").length, 10, "invalid input falls back to now");

  assert.equal(isISTDateString("2026-02-28"), true);
  assert.equal(isISTDateString("2026-02-30"), false);
  assert.equal(isISTDateString("2026-2-3"), false);
  assert.equal(isISTDateString(null), false);

  assert.equal(addDaysToISTDate("2026-12-31", 1), "2027-01-01");
  assert.equal(addDaysToISTDate("2028-03-01", -1), "2028-02-29");

  assert.equal(startOfISTDay("2026-11-07").toISOString(), "2026-11-06T18:30:00.000Z");
  assert.equal(nextISTMidnight(new Date("2026-11-06T18:29:59.999Z")).toISOString(), "2026-11-06T18:30:00.000Z");
  assert.equal(nextISTMidnight(new Date("2026-11-06T18:30:00.000Z")).toISOString(), "2026-11-07T18:30:00.000Z");
});
