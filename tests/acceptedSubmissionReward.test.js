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
  stats: {
    ...firstReward.stats,
    streak: 2,
    longestStreak: 2,
  },
});

const nextDayReward = await applyAcceptedSubmissionReward(tx, {
  userId: user.id,
  problem: { id: "problem-2", difficulty: "Hard" },
  now: new Date("2026-10-31T00:01:00.000Z"),
});
assert.equal(nextDayReward.awarded, true);
assert.equal(nextDayReward.points, 50);
assert.equal(nextDayReward.stats.streak, 3);
assert.equal(nextDayReward.stats.longestStreak, 3);
assert.equal(nextDayReward.stats.scoreUnits, 600);
assert.equal(nextDayReward.stats.coins, 240);
assert.equal(progress.size, 2);

process.env.DATABASE_URL =
  "postgresql://test:test@localhost:5432/calibr8_fallback_test";
const { default: fallbackPrisma } = await import("../src/config/db.js");
const fallbackUser = await fallbackPrisma.user.create({
  data: {
    id: "fallback-reward-user",
    email: "fallback-reward@example.test",
    name: "Fallback Reward Test",
    rating: 950,
    coins: 120,
    score: 25,
    streak: 4,
    longestStreak: 6,
    lastStreakDate: new Date("2026-10-28T23:59:00.000Z"),
  },
});
const persistedFallbackUser = await fallbackPrisma.user.findUnique({
  where: { id: fallbackUser.id },
});
assert.equal(persistedFallbackUser.rating, 950);
assert.equal(persistedFallbackUser.coins, 120);
assert.equal(persistedFallbackUser.score, 25);
assert.equal(persistedFallbackUser.streak, 4);
assert.equal(persistedFallbackUser.longestStreak, 6);
const fallbackFirstReward = await fallbackPrisma.$transaction((fallbackTx) =>
  applyAcceptedSubmissionReward(fallbackTx, {
    userId: fallbackUser.id,
    problem: { id: "fallback-problem", difficulty: "Medium" },
    now: dayOne,
  }),
);
const fallbackDuplicateReward = await fallbackPrisma.$transaction((fallbackTx) =>
  applyAcceptedSubmissionReward(fallbackTx, {
    userId: fallbackUser.id,
    problem: { id: "fallback-problem", difficulty: "Medium" },
    now: dayOne,
  }),
);
assert.equal(fallbackFirstReward.awarded, true);
assert.equal(fallbackFirstReward.stats.streak, 5);
assert.equal(fallbackFirstReward.stats.longestStreak, 6);
assert.equal(fallbackDuplicateReward.awarded, false);
assert.equal(fallbackDuplicateReward.stats.scoreUnits, 275);
assert.equal(fallbackDuplicateReward.stats.coins, 180);

console.log("Accepted submission reward tests passed.");
