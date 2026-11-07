// tests/coinReward.integration.test.js
// REAL DB TEST - This DOES write to your Neon DB, then cleans up.
// Run from backend folder:
//   node tests/coinReward.integration.test.js
//
// What it checks:
//  1. New user starts at 100 coins
//  2. Daily login +1, streak 1, CoinTransaction created, balanceAfter correct
//  3. Same day login = 0, no duplicate transaction
//  4. Next day login = +1, streak +1
//  5. 7-day bonus = +6 total (1+5), streak 7
//  6. 30-day bonus = +26 total (1+25), streak 30
//  7. Missed day = streak reset to 1, coins kept
//  8. Daily problem +2 once, second time 0
//  9. Wrong problem = 0
// 10. CoinTransaction.balanceAfter always equals User.coins

import prisma from "../src/config/db.js";
import { grantDailyLoginReward, grantDailyProblemReward } from "../src/services/coinService.js";
import { getISTDateString } from "../src/services/streakService.js";

// Local helper - does not depend on streakService export name
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
let deletedSum = 0; // coins value of transactions deleted by setStreak simulation
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
  // lastStreakISTDate is YYYY-MM-DD string, convert to Date at IST noon to avoid shift
  let lastDate = null;
  if (lastStreakISTDate) {
    const [y, m, d] = lastStreakISTDate.split("-").map(Number);
    lastDate = new Date(Date.UTC(y, m - 1, d, 6, 30, 0)); // 12:00 IST = 06:30 UTC
  }
  const data = { streak, lastStreakDate: lastDate };
  if (coins !== undefined) data.coins = coins;
  // Also clear today's transactions if we want a clean day? No, keep them for history check.
  // For bonus tests we need to clear today's DAILY_LOGIN so the next grant is not blocked as duplicate.
  // So delete today's DAILY_LOGIN / bonus rows before setting up next-day scenario.
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
  const yesterdayIST = addDaysToISTDate(todayIST, -1);
  const twoDaysAgoIST = addDaysToISTDate(todayIST, -2);
  console.log(`Today IST: ${todayIST} | Yesterday IST: ${yesterdayIST}`);

  // --- Setup: create isolated test user ---
  const testEmail = `coin-test-${Date.now()}@calibr8.test`;
  console.log(`\n[Setup] Creating test user ${testEmail}`);
  const user = await prisma.user.create({
    data: { email: testEmail, passwordHash: "test-hash-not-for-login", name: "Coin Test User" },
  });
  const userId = user.id;

  try {
    // --- Test 1: Default 100 ---
    console.log("\n[Test 1] Default balance");
    let u = await getUser(userId);
    check("New user coins = 100", u.coins === 100, `got ${u.coins}`);
    check("New user streak = 0", u.streak === 0, `got ${u.streak}`);

    // --- Test 2: First login ---
    console.log("\n[Test 2] First login");
    let r1 = await grantDailyLoginReward(userId);
    u = await getUser(userId);
    check("First login coinsEarnedToday = 1", r1.coinsEarnedToday === 1, JSON.stringify(r1));
    check("DB coins = 101", u.coins === 101, `got ${u.coins}`);
    check("DB streak = 1", u.streak === 1, `got ${u.streak}`);
    check("DB longestStreak = 1", u.longestStreak === 1, `got ${u.longestStreak}`);
    let tx = await getTx(userId);
    check("1 CoinTransaction created", tx.length === 1, `got ${tx.length}`);
    check("Transaction type DAILY_LOGIN", tx[0]?.type === "DAILY_LOGIN");
    check("Transaction amount 1", tx[0]?.amount === 1);
    check("balanceAfter 101", tx[0]?.balanceAfter === 101, `got ${tx[0]?.balanceAfter}`);
    check("balanceAfter equals User.coins", tx[0]?.balanceAfter === u.coins);

    // --- Test 3: Same day second login ---
    console.log("\n[Test 3] Same day second login = 0");
    let r2 = await grantDailyLoginReward(userId);
    u = await getUser(userId);
    check("Second login coinsEarnedToday = 0", r2.coinsEarnedToday === 0, JSON.stringify(r2));
    check("DB coins still 101", u.coins === 101, `got ${u.coins}`);
    tx = await getTx(userId);
    check("Still 1 transaction, no duplicate", tx.length === 1, `got ${tx.length}`);

    // --- Test 4: Next day login ---
    console.log("\n[Test 4] Next day login");
    // Simulate: set lastStreakDate to yesterday, streak 1, coins 101, and clear today's tx so grant is allowed
    await setStreak(userId, 1, yesterdayIST, 101);
    let r3 = await grantDailyLoginReward(userId);
    u = await getUser(userId);
    check("Next day coinsEarnedToday = 1", r3.coinsEarnedToday === 1, JSON.stringify(r3));
    check("DB coins = 102", u.coins === 102, `got ${u.coins}`);
    check("DB streak = 2", u.streak === 2, `got ${u.streak}`);

    // --- Test 5: 7-day bonus ---
    console.log("\n[Test 5] 7-day bonus");
    await setStreak(userId, 6, yesterdayIST, 102);
    let r4 = await grantDailyLoginReward(userId);
    u = await getUser(userId);
    check("Day 7 coinsEarnedToday = 6 (1+5)", r4.coinsEarnedToday === 6, JSON.stringify(r4));
    check("Day 7 bonusCoins = 5", r4.bonusCoins === 5);
    check("Day 7 bonusType STREAK_7_BONUS", r4.bonusType === "STREAK_7_BONUS");
    check("DB coins = 108", u.coins === 108, `got ${u.coins}`);
    check("DB streak = 7", u.streak === 7);
    tx = await getTx(userId);
    const bonus7 = tx.filter((t) => t.type === "STREAK_7_BONUS");
    check("STREAK_7_BONUS transaction exists", bonus7.length === 1, `got ${bonus7.length}`);
    check("Bonus transaction amount 5", bonus7[0]?.amount === 5);
    check("Bonus balanceAfter equals User.coins", bonus7[0]?.balanceAfter === u.coins);

    // --- Test 6: 30-day bonus ---
    console.log("\n[Test 6] 30-day bonus");
    await setStreak(userId, 29, yesterdayIST, 108);
    let r5 = await grantDailyLoginReward(userId);
    u = await getUser(userId);
    check("Day 30 coinsEarnedToday = 26 (1+25)", r5.coinsEarnedToday === 26, JSON.stringify(r5));
    check("Day 30 bonusCoins = 25", r5.bonusCoins === 25);
    check("Day 30 bonusType STREAK_30_BONUS", r5.bonusType === "STREAK_30_BONUS");
    check("DB coins = 134 (108+26)", u.coins === 134, `got ${u.coins}`);
    check("DB streak = 30", u.streak === 30);
    tx = await getTx(userId);
    const bonus30 = tx.filter((t) => t.type === "STREAK_30_BONUS");
    check("STREAK_30_BONUS transaction exists", bonus30.length === 1);

    // --- Test 7: Missed day reset ---
    console.log("\n[Test 7] Missed day reset");
    // Set streak 5, last date 2 days ago, coins 134. Next grant should reset to 1 and give +1 only.
    await setStreak(userId, 5, twoDaysAgoIST, 134);
    let r6 = await grantDailyLoginReward(userId);
    u = await getUser(userId);
    check("After miss, streak reset to 1", u.streak === 1, `got ${u.streak}`);
    check("After miss, coins +1 = 135", u.coins === 135, `got ${u.coins}`);
    check("longestStreak stays 30", u.longestStreak === 30, `got ${u.longestStreak}`);
    check("After miss, no bonus", r6.bonusCoins === 0);

    // --- Test 8: Daily problem ---
    console.log("\n[Test 8] Daily problem +2");
    const daily = await prisma.dailyProblem.findUnique({ where: { istDate: todayIST } });
    if (!daily) {
      check("DailyProblem exists for today", false, "Run node scripts/seedDailyProblems.js first");
    } else {
      console.log(`  Daily problem for today: ${daily.problemId}`);
      const beforeCoins = (await getUser(userId)).coins;
      const d1 = await grantDailyProblemReward(userId, daily.problemId, "test-submission-1");
      u = await getUser(userId);
      check("Daily problem granted = true", d1.granted === true, JSON.stringify(d1));
      check("Daily problem coins +2", u.coins === beforeCoins + 2, `before ${beforeCoins} after ${u.coins}`);
      tx = await getTx(userId);
      const dailyTx = tx.filter((t) => t.type === "DAILY_PROBLEM" && t.istDate === todayIST);
      check("DAILY_PROBLEM transaction exists", dailyTx.length === 1, `got ${dailyTx.length}`);
      check("DAILY_PROBLEM amount 2", dailyTx[0]?.amount === 2);

      // Second claim same day = 0
      console.log("\n[Test 8b] Daily problem second claim = 0");
      const d2 = await grantDailyProblemReward(userId, daily.problemId, "test-submission-2");
      u = await getUser(userId);
      check("Second daily claim granted = false", d2.granted === false, JSON.stringify(d2));
      check("Coins unchanged on second claim", u.coins === beforeCoins + 2, `got ${u.coins}`);
    }

    // --- Test 9: Wrong problem = 0 ---
    console.log("\n[Test 9] Wrong problem = 0");
    if (!daily) {
      console.log("  SKIP Test 9: no DailyProblem for today, cannot test wrong problem");
    } else {
    const before9 = (await getUser(userId)).coins;
    const otherProblem = await prisma.problem.findFirst({ where: { NOT: { id: daily.problemId } }, select: { id: true } });
    if (otherProblem) {
      const d3 = await grantDailyProblemReward(userId, otherProblem.id, "test-submission-3");
      u = await getUser(userId);
      check("Wrong problem granted = false", d3.granted === false, JSON.stringify(d3));
      check("Coins unchanged for wrong problem", u.coins === before9, `got ${u.coins}`);
    } else {
      console.log("  SKIP: No other problem to test with");
    }
    } // end if (daily) for Test 9

    // --- Test 10: Final audit ---
    console.log("\n[Test 10] Final audit - balanceAfter always correct");
    tx = await getTx(userId);
    u = await getUser(userId);
    const lastTx = tx[tx.length - 1];
    check("Last transaction balanceAfter equals User.coins", lastTx?.balanceAfter === u.coins, `lastTx ${lastTx?.balanceAfter} vs user ${u.coins}`);
    // Sum of all transactions + 100 should equal current coins
    const sum = tx.reduce((acc, t) => acc + t.amount, 0);
    check("100 + sum(remaining) + deletedSum = User.coins", 100 + sum + deletedSum === u.coins, `100 + ${sum} + deleted ${deletedSum} = ${100 + sum + deletedSum} vs ${u.coins}`);

    console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) console.log("Check the FAIL lines above. DB was updated but some rule is wrong.");
    else console.log("All DB checks passed. Your coin feature is writing correctly to Neon.");

  } finally {
    // --- Cleanup ---
    console.log("\n[Cleanup] Deleting test user and its transactions...");
    await prisma.coinTransaction.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    console.log("Cleanup done. Test user removed.");
    await prisma.$disconnect();
  }

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Test crashed:", e);
  process.exit(1);
});
