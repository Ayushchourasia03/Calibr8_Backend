// scripts/checkDailyProblems.js
// Diagnostic script: Prints TODAY IST, total rows, first/last rows, TODAY FOUND or MISSING.

import prisma from "../src/config/db.js";
import { getISTDateString } from "../src/services/streakService.js";

async function checkDailyProblems() {
  const todayIST = getISTDateString(new Date());
  console.log(`=== Daily Problems Diagnostic ===`);
  console.log(`TODAY IST: ${todayIST}`);

  try {
    const allRecords = await prisma.dailyProblem.findMany({
      orderBy: { istDate: "asc" },
      include: {
        problem: {
          select: { id: true, slug: true, title: true },
        },
      },
    });

    const totalRows = allRecords.length;
    console.log(`Total rows in daily_problems: ${totalRows}`);

    if (totalRows > 0) {
      const first = allRecords[0];
      const last = allRecords[totalRows - 1];
      console.log(`First row: istDate=${first.istDate}, problemId=${first.problemId} (${first.problem?.title || first.problem?.slug || "N/A"})`);
      console.log(`Last row:  istDate=${last.istDate}, problemId=${last.problemId} (${last.problem?.title || last.problem?.slug || "N/A"})`);
    }

    const todayRecord = allRecords.find((r) => r.istDate === todayIST);
    if (todayRecord) {
      console.log(`✅ TODAY FOUND: istDate=${todayRecord.istDate}, problemId=${todayRecord.problemId} (${todayRecord.problem?.title || todayRecord.problem?.slug || "N/A"})`);
    } else {
      console.log(`❌ TODAY MISSING: No record found for ${todayIST}`);
    }
  } catch (err) {
    console.error("Diagnostic error:", err.message);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

checkDailyProblems();
