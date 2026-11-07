import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getISTDateString, getYesterdayIST } from "../src/services/streakService.js";

process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/calibr8_daily_problem_test";

const { default: prisma } = await import("../src/config/db.js");
const { grantDailyProblemReward, grantDailyLoginReward } = await import("../src/services/coinService.js");

console.log("Running Daily Problem Reward Integration Tests (D1 - D8)...");

async function createUser(initialCoins = 100) {
  const id = `usr-${randomUUID()}`;
  const user = await prisma.user.create({
    data: {
      id,
      email: `${id}@example.test`,
      name: "Daily Problem Tester",
      passwordHash: "hash123",
      coins: initialCoins,
      streak: 0,
      longestStreak: 0,
    },
  });
  return user;
}

try {
  const todayIST = getISTDateString();
  const yesterdayIST = getYesterdayIST(todayIST);

  // Seed daily problem for today: 'two-sum'
  await prisma.dailyProblem.upsert({
    where: { istDate: todayIST },
    update: { problemId: "two-sum" },
    create: { istDate: todayIST, problemId: "two-sum" },
  });

  // D1: Solve daily problem for today -> +2 coins
  const user1 = await createUser(100);
  const d1 = await grantDailyProblemReward(user1.id, "two-sum");
  assert.equal(d1.awarded, true, "D1: Daily problem solve should award coins");
  assert.equal(d1.coinsEarned, 2, "D1: Daily problem solve should give exactly +2 coins");
  assert.equal(d1.balanceAfter, 102);

  const tx1 = await prisma.coinTransaction.findMany({
    where: { userId: user1.id, type: "DAILY_PROBLEM" },
  });
  assert.equal(tx1.length, 1);
  assert.equal(tx1[0].amount, 2);
  assert.equal(tx1[0].balanceAfter, 102);
  assert.equal(tx1[0].referenceId, "two-sum");
  console.log("✔ D1: Solving today's daily problem awards +2 coins and creates audit row");

  // D2: Re-solve daily problem -> 0 extra coins
  const d2 = await grantDailyProblemReward(user1.id, "two-sum");
  assert.equal(d2.awarded, false, "D2: Re-solving same daily problem must not reward again");
  assert.equal(d2.coinsEarned, 0);

  const tx2 = await prisma.coinTransaction.findMany({
    where: { userId: user1.id, type: "DAILY_PROBLEM" },
  });
  assert.equal(tx2.length, 1, "D2: Still only 1 transaction row");
  const storedUser1 = await prisma.user.findUnique({ where: { id: user1.id } });
  assert.equal(storedUser1.coins, 102, "D2: User balance remains 102");
  console.log("✔ D2: Re-solving daily problem gives 0 extra coins, idempotent");

  // D3: Solve non-daily problem -> 0 daily coins
  const user3 = await createUser(100);
  const d3 = await grantDailyProblemReward(user3.id, "best-time-to-buy-and-sell-stock");
  assert.equal(d3.awarded, false);
  assert.equal(d3.coinsEarned, 0);
  assert.equal(d3.reason, "NOT_DAILY_PROBLEM");

  const tx3 = await prisma.coinTransaction.findMany({
    where: { userId: user3.id, type: "DAILY_PROBLEM" },
  });
  assert.equal(tx3.length, 0);
  console.log("✔ D3: Solving non-daily problem yields 0 daily bonus coins");

  // D4: Solve daily problem next day (date mismatch)
  // Daily problem set for yesterday: 'add-two-numbers'
  await prisma.dailyProblem.upsert({
    where: { istDate: yesterdayIST },
    update: { problemId: "add-two-numbers" },
    create: { istDate: yesterdayIST, problemId: "add-two-numbers" },
  });
  const user4 = await createUser(100);
  // Solving yesterday's problem today (todayISTDate)
  const d4 = await grantDailyProblemReward(user4.id, "add-two-numbers");
  assert.equal(d4.awarded, false);
  assert.equal(d4.coinsEarned, 0);
  console.log("✔ D4: Solving yesterday's daily problem today gives 0 daily coins");

  // D5: Wrong status (simulation: only call when status === ACCEPTED)
  // Calling with non-matching problem or missing params gives 0
  const d5 = await grantDailyProblemReward(user4.id, "");
  assert.equal(d5.awarded, false);
  assert.equal(d5.coinsEarned, 0);
  console.log("✔ D5: Invalid or non-matching submission gives 0 daily coins");

  // D6: Daily problem missing for a specific future date
  const futureIST = "2029-12-31";
  const futureDate = new Date("2029-12-31T10:00:00Z");
  const user6 = await createUser(100);
  const d6 = await grantDailyProblemReward(user6.id, "two-sum", futureDate);
  assert.equal(d6.awarded, false);
  assert.equal(d6.coinsEarned, 0);
  assert.equal(d6.reason, "NO_DAILY_PROBLEM_TODAY");
  console.log("✔ D6: Missing daily problem row fails safely without crash");

  // D7: Daily problem + login + streak bonus on same day (Day 7)
  const user7 = await createUser(100);
  // Setup user with 6-day streak ending yesterday
  await prisma.user.update({
    where: { id: user7.id },
    data: {
      coins: 106,
      streak: 6,
      longestStreak: 6,
      lastStreakDate: new Date(Date.now() - 86400000),
      lastLoginISTDate: yesterdayIST,
    },
  });

  // 1. Day 7 login (+1 login + 5 bonus = +6)
  const loginReward = await grantDailyLoginReward(user7.id);
  assert.equal(loginReward.coinsEarnedToday, 6);

  // 2. Day 7 solve daily problem (+2)
  const problemReward = await grantDailyProblemReward(user7.id, "two-sum");
  assert.equal(problemReward.awarded, true);
  assert.equal(problemReward.coinsEarned, 2);

  // Total coins added today: +1 + 5 + 2 = +8 (106 + 8 = 114)
  const storedUser7 = await prisma.user.findUnique({ where: { id: user7.id } });
  assert.equal(storedUser7.coins, 114);

  const user7Txs = await prisma.coinTransaction.findMany({
    where: { userId: user7.id },
  });
  assert.equal(user7Txs.length, 3, "Should have 3 transactions: DAILY_LOGIN, STREAK_7_BONUS, DAILY_PROBLEM");
  console.log("✔ D7: Stacking login (+1) + streak 7 (+5) + daily problem (+2) = +8 coins total");

  // D8: Daily problem concurrent submissions
  const user8 = await createUser(100);
  const [res8a, res8b] = await Promise.all([
    grantDailyProblemReward(user8.id, "two-sum"),
    grantDailyProblemReward(user8.id, "two-sum"),
  ]);

  const totalProblemCoins = (res8a.coinsEarned || 0) + (res8b.coinsEarned || 0);
  assert.equal(totalProblemCoins, 2, "Only one +2 should be awarded across parallel requests");

  const storedUser8 = await prisma.user.findUnique({ where: { id: user8.id } });
  assert.equal(storedUser8.coins, 102);

  const user8Txs = await prisma.coinTransaction.findMany({
    where: { userId: user8.id, type: "DAILY_PROBLEM" },
  });
  assert.equal(user8Txs.length, 1);
  console.log("✔ D8: Concurrent submissions safely award daily problem coins exactly once");

  console.log("ALL DAILY PROBLEM REWARD TESTS PASSED! 🎉");
} catch (err) {
  console.error("Test failure:", err);
  process.exit(1);
}
