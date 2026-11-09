// tests/coinReward.integration.test.js
// Calibr8: Daily Problem, Streak & Coin Reward System Integration Tests

import prisma from "../src/config/db.js";
import { grantDailyLoginReward, grantDailyProblemReward } from "../src/services/coinService.js";
import { getISTDateString, getYesterdayIST } from "../src/services/streakService.js";

function addDaysToISTDate(istDateString, days) {
  const [y, m, d] = istDateString.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

let passed = 0;
let failed = 0;
let deletedSum = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS: ${name}`);
  } else {
    failed++;
    console.log(`  FAIL: ${name} ${detail}`);
  }
}

async function getUser(id) {
  return await prisma.user.findUnique({ where: { id } });
}

async function getTx(userId) {
  return await prisma.coinTransaction.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
}

async function setStreak(userId, streak, lastStreakISTDate, coins) {
  let lastDate = null;
  if (lastStreakISTDate) {
    const [y, m, d] = lastStreakISTDate.split("-").map(Number);
    lastDate = new Date(Date.UTC(y, m - 1, d, 6, 30, 0));
  }
  const data = { streak, lastStreakDate: lastDate };
  if (coins !== undefined) data.coins = coins;
  const toDelete = await prisma.coinTransaction.findMany({ where: { userId, istDate: getISTDateString(new Date()) } });
  deletedSum += toDelete.reduce((a, t) => a + (t.amount || 0), 0);
  await prisma.coinTransaction.deleteMany({
    where: { userId, istDate: getISTDateString(new Date()) },
  });
  await prisma.user.update({ where: { id: userId }, data });
}

async function main() {
  console.log("=== Calibr8 Coin Reward - DB Integration Test ===");
  const todayIST = getISTDateString(new Date());
  const yesterdayIST = getYesterdayIST(todayIST);
  console.log(`Today IST: ${todayIST} | Yesterday IST: ${yesterdayIST}`);

  // Setup: create isolated test user
  const testEmail = `coin-test-${Date.now()}@calibr8.test`;
  console.log(`\n[Setup] Creating test user ${testEmail}`);
  const user = await prisma.user.create({
    data: { email: testEmail, passwordHash: "test-hash-not-for-login", name: "Coin Test User", coins: 100, streak: 0 },
  });
  const userId = user.id;

  try {
    // --- Test 1: Default 100 ---
    console.log("\n[Test 1] Default balance");
    let u = await getUser(userId);
    check("New user coins = 100", u.coins === 100, `got ${u.coins}`);
    check("New user streak = 0", u.streak === 0, `got ${u.streak}`);

    // --- Test 2: First login grants +1, streak remains 0 (FR-05) ---
    console.log("\n[Test 2] First login");
    let r1 = await grantDailyLoginReward(userId);
    u = await getUser(userId);
    check("First login coinsEarnedToday = 1", r1.coinsEarnedToday === 1, JSON.stringify(r1));
    check("DB coins = 101", u.coins === 101, `got ${u.coins}`);
    check("DB streak = 0 (login does not mutate Daily Problem streak)", u.streak === 0, `got ${u.streak}`);
    let tx = await getTx(userId);
    check("1 CoinTransaction created", tx.length === 1, `got ${tx.length}`);
    check("Transaction type DAILY_LOGIN", tx[0]?.type === "DAILY_LOGIN");
    check("Transaction amount 1", tx[0]?.amount === 1);
    check("balanceAfter 101", tx[0]?.balanceAfter === 101, `got ${tx[0]?.balanceAfter}`);
    check("balanceAfter equals User.coins", tx[0]?.balanceAfter === u.coins);

    // --- Test 3: Same day second login = 0 ---
    console.log("\n[Test 3] Same day second login = 0");
    let r2 = await grantDailyLoginReward(userId);
    u = await getUser(userId);
    check("Second login coinsEarnedToday = 0", r2.coinsEarnedToday === 0, JSON.stringify(r2));
    check("DB coins still 101", u.coins === 101, `got ${u.coins}`);
    tx = await getTx(userId);
    check("Still 1 transaction, no duplicate", tx.length === 1, `got ${tx.length}`);

    // --- Test 4: Next day login grants +1 coin ---
    console.log("\n[Test 4] Next day login");
    await prisma.user.update({
      where: { id: userId },
      data: { lastLoginISTDate: yesterdayIST },
    });
    // Clear today's transaction for next-day test simulation
    const toDel = await prisma.coinTransaction.findMany({ where: { userId, istDate: todayIST } });
    deletedSum += toDel.reduce((a, t) => a + (t.amount || 0), 0);
    await prisma.coinTransaction.deleteMany({ where: { userId, istDate: todayIST } });

    let r3 = await grantDailyLoginReward(userId);
    u = await getUser(userId);
    check("Next day coinsEarnedToday = 1", r3.coinsEarnedToday === 1, JSON.stringify(r3));
    check("DB coins = 102", u.coins === 102, `got ${u.coins}`);

    // --- Test 5: Daily problem solve grants +2 coins and +1 streak (FR-03, FR-04, FR-06) ---
    console.log("\n[Test 5] Daily problem +2 and streak increment");
    let todayDaily = await prisma.dailyProblem.findUnique({
      where: { istDate: todayIST },
      include: { problem: true },
    });
    if (!todayDaily) {
      let anyProblem = await prisma.problem.findFirst();
      if (!anyProblem) {
        anyProblem = await prisma.problem.create({
          data: {
            slug: "two-sum",
            title: "Two Sum",
            difficulty: "Easy",
            description: "Find two numbers",
            tags: ["Array"],
          },
        });
      }
      todayDaily = await prisma.dailyProblem.upsert({
        where: { istDate: todayIST },
        update: { problemId: anyProblem.id },
        create: { istDate: todayIST, problemId: anyProblem.id },
        include: { problem: true },
      });
    }
    const targetProblemId = todayDaily.problemId;

    const beforeCoins = (await getUser(userId)).coins;
    const d1 = await grantDailyProblemReward(userId, targetProblemId, "test-sub-1");
    u = await getUser(userId);
    check("Daily problem granted = true", d1.granted === true, JSON.stringify(d1));
    check("Daily problem coins +2", u.coins === beforeCoins + 2, `before ${beforeCoins} after ${u.coins}`);
    check("Daily problem streak = 1", u.streak === 1, `got ${u.streak}`);
    tx = await getTx(userId);
    const dailyTx = tx.filter((t) => t.type === "DAILY_PROBLEM" && t.istDate === todayIST);
    check("DAILY_PROBLEM transaction exists", dailyTx.length === 1, `got ${dailyTx.length}`);
    check("DAILY_PROBLEM amount 2", dailyTx[0]?.amount === 2);

    // --- Test 6: Second solve on same day grants 0 coins and preserves streak ---
    console.log("\n[Test 6] Daily problem duplicate solve = 0");
    const d2 = await grantDailyProblemReward(userId, targetProblemId, "test-sub-2");
    u = await getUser(userId);
    check("Second daily claim granted = false", d2.granted === false, JSON.stringify(d2));
    check("Coins unchanged on second claim", u.coins === beforeCoins + 2, `got ${u.coins}`);
    check("Streak unchanged on second claim", u.streak === 1, `got ${u.streak}`);

    // --- Test 7: Consecutive day daily problem solve increases streak (FR-04) ---
    console.log("\n[Test 7] Consecutive day streak advancement");
    // Simulate user had solved yesterday's daily problem
    await prisma.user.update({
      where: { id: userId },
      data: { streak: 3, lastStreakDate: new Date(Date.now() - 86400000) },
    });
    await prisma.dailyProblemCompletion.deleteMany({ where: { userId } });
    await prisma.coinTransaction.deleteMany({ where: { userId, type: "DAILY_PROBLEM", istDate: todayIST } });

    const dConsecutive = await grantDailyProblemReward(userId, targetProblemId, "test-sub-3");
    u = await getUser(userId);
    check("Consecutive solve granted = true", dConsecutive.granted === true);
    check("Consecutive solve streak = 4 (3 -> 4)", u.streak === 4, `got ${u.streak}`);
    check("longestStreak = 4", u.longestStreak >= 4);

    // --- Test 8: Missed day reset on next daily problem solve ---
    console.log("\n[Test 8] Missed day reset on daily problem solve");
    // Last solved 2 days ago
    await prisma.user.update({
      where: { id: userId },
      data: { streak: 4, longestStreak: 4, lastStreakDate: new Date(Date.now() - 2 * 86400000) },
    });
    await prisma.dailyProblemCompletion.deleteMany({ where: { userId } });
    await prisma.coinTransaction.deleteMany({ where: { userId, type: "DAILY_PROBLEM", istDate: todayIST } });

    const dMissed = await grantDailyProblemReward(userId, targetProblemId, "test-sub-4");
    u = await getUser(userId);
    check("After miss, streak reset to 1", u.streak === 1, `got ${u.streak}`);
    check("longestStreak stays 4", u.longestStreak === 4, `got ${u.longestStreak}`);

    // --- Test 9: Wrong problem = 0 ---
    console.log("\n[Test 9] Wrong problem = 0");
    const before9 = (await getUser(userId)).coins;
    const d3 = await grantDailyProblemReward(userId, "wrong-problem-slug", "test-sub-5");
    u = await getUser(userId);
    check("Wrong problem granted = false", d3.granted === false, JSON.stringify(d3));
    check("Coins unchanged for wrong problem", u.coins === before9, `got ${u.coins}`);

    // --- Test 10: Final audit ---
    console.log("\n[Test 10] Final audit - balanceAfter always correct");
    tx = await getTx(userId);
    u = await getUser(userId);
    const lastTx = tx[tx.length - 1];
    check("Last transaction balanceAfter equals User.coins", lastTx?.balanceAfter === u.coins, `lastTx ${lastTx?.balanceAfter} vs user ${u.coins}`);

    console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) console.log("Check the FAIL lines above.");
    else console.log("All DB checks passed. Your coin & streak features conform to FR-01 - FR-07.");

  } finally {
    console.log("\n[Cleanup] Deleting test user and its transactions...");
    await prisma.coinTransaction.deleteMany({ where: { userId } });
    await prisma.dailyProblemCompletion.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    console.log("Cleanup done. Test user removed.");
  }

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Test crashed:", e);
  process.exit(1);
});