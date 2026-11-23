// scripts/verifyCoinSetup.js
// One-command check: imports prisma, streakService, coinService and
// dailyProblemService, checks today's daily problem, counts coinTransactions.

import prisma from "../src/config/db.js";
import { getISTDateString } from "../src/services/streakService.js";
import { grantDailyLoginReward, getBalance } from "../src/services/coinService.js";
import { recordDailyProblemCompletion } from "../src/services/dailyProblemService.js";

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
      console.warn(`⚠️ DailyProblem for today (${todayIST}) not found. The server creates it at startup; or run: node scripts/dailyProblem.js ensure`);
    }

    // 2. Count CoinTransaction records
    const txCount = await prisma.coinTransaction.count();
    console.log(`✅ CoinTransaction total rows: ${txCount}`);

    // 3. Check reward functions are exported
    if ([grantDailyLoginReward, getBalance, recordDailyProblemCompletion].every((fn) => typeof fn === "function")) {
      console.log(`✅ Reward functions verified (grantDailyLoginReward, getBalance, recordDailyProblemCompletion)`);
    } else {
      console.error(`❌ Reward functions missing!`);
    }

    console.log("=== Coin Rewards Setup Verification Complete ===");
  } catch (err) {
    console.error("Verification error:", err);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

verifyCoinSetup();
