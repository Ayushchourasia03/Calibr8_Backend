import assert from "node:assert/strict";
import { applyAcceptedSubmissionReward } from "../src/utils/acceptedSubmissionReward.js";

const user = {
  id: "user-1",
  rating: 800,
  score: 0,
  coins: 100,
  streak: 0,
  longestStreak: 0,
  lastStreakDate: null,
};
const users = new Map([[user.id, user]]);
const progress = new Map();
const tx = {
  user: {
    findUnique: async ({ where }) => {
      const found = users.get(where.id);
      return found ? { ...found } : null;
    },
    update: async ({ where, data }) => {
      const found = users.get(where.id);
      for (const [key, value] of Object.entries(data)) {
        found[key] =
          value && typeof value === "object" && "increment" in value
            ? found[key] + value.increment
            : value;
      }
      return { ...found };
    },
  },
  userProblemProgress: {
    createMany: async ({ data, skipDuplicates }) => {
      let count = 0;
      for (const record of data) {
        const key = `${record.userId}_${record.problemId}`;
        if (skipDuplicates && progress.has(key)) continue;
        progress.set(key, record);
        count += 1;
      }
      return { count };
    },
    count: async ({ where }) =>
      [...progress.values()].filter((item) => item.userId === where.userId)
        .length,
  },
};

const dayOne = new Date("2026-10-29T23:59:00.000Z");
const firstReward = await applyAcceptedSubmissionReward(tx, {
  userId: user.id,
  problem: { id: "problem-1", difficulty: "Easy" },
  now: dayOne,
});
assert.equal(firstReward.awarded, true);
assert.equal(firstReward.points, 10);
assert.equal(firstReward.scoreDelta, 100);
assert.equal(firstReward.coinsEarned, 30);
assert.equal(firstReward.stats.streak, 1);
assert.equal(firstReward.stats.coins, 130);
assert.equal(firstReward.stats.scoreUnits, 100);

const duplicateReward = await applyAcceptedSubmissionReward(tx, {
  userId: user.id,
  problem: { id: "problem-1", difficulty: "Easy" },
  now: new Date("2026-10-30T12:00:00.000Z"),
});
assert.deepEqual(duplicateReward, {
  awarded: false,
  points: 0,
  scoreDelta: 0,
  coinsEarned: 0,
  stats: firstReward.stats,
});

const nextDayReward = await applyAcceptedSubmissionReward(tx, {
  userId: user.id,
  problem: { id: "problem-2", difficulty: "Hard" },
  now: new Date("2026-10-30T00:01:00.000Z"),
});
assert.equal(nextDayReward.awarded, true);
assert.equal(nextDayReward.points, 50);
assert.equal(nextDayReward.stats.streak, 2);
assert.equal(nextDayReward.stats.longestStreak, 2);
assert.equal(nextDayReward.stats.scoreUnits, 600);
assert.equal(nextDayReward.stats.coins, 240);
assert.equal(progress.size, 2);

console.log("Accepted submission reward tests passed.");
