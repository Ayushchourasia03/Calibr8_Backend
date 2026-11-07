// scripts/verifyCoinSetup.js
// One-command check: imports prisma, streakService, coinService,
// checks dailyProblem for today, counts coinTransactions, disconnects.

import prisma from "../src/config/db.js";
import { getISTDateString } from "../src/services/streakService.js";
import { grantDailyLoginReward, grantDailyProblemReward, getBalance } from "../src/services/coinService.js";

async function verifyCoinSetup() {
  console.log("=== Verifying Calibr8 Coin Rewards Setup ===");
  const todayIST = getISTDateString(new Date());
  console.log(`Current IST Date: ${todayIST}`);

  try {
    // 1. Check dailyProblem for today
    const daily = await prisma.dailyProblem.findUnique({
      where: { istDate: todayIST },
      include: { problem: true },
    });

    if (daily) {
      console.log(`✅ DailyProblem for today exists: [${daily.istDate}] problemId: ${daily.problemId} (${daily.problem?.title || daily.problem?.slug || "N/A"})`);
    } else {
      console.warn(`⚠️ DailyProblem for today (${todayIST}) not found. Run: node scripts/seedDailyProblems.js`);
    }

    // 2. Count CoinTransaction records
    const txCount = await prisma.coinTransaction.count();
    console.log(`✅ CoinTransaction total rows: ${txCount}`);

    // 3. Check coinService exports
    if (typeof grantDailyLoginReward === "function" && typeof grantDailyProblemReward === "function" && typeof getBalance === "function") {
      console.log(`✅ coinService functions verified (grantDailyLoginReward, grantDailyProblemReward, getBalance)`);
    } else {
      console.error(`❌ coinService functions missing!`);
    }

    console.log("=== Coin Rewards Setup Verification Complete ===");
  } catch (err) {
    console.error("Verification error:", err);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

verifyCoinSetup();
