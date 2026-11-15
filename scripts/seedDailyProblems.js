// scripts/seedDailyProblems.js
// Seeds DailyProblem table for today + next 34 days = 35 rows.
// Loop starts at i = 0 (today).

import prisma from "../src/config/db.js";
import { getISTDateString, addDaysToISTDate } from "../src/services/streakService.js";

export async function seedDailyProblems(customPrisma = prisma) {
  const todayIST = getISTDateString(new Date());
  console.log(`[Seed DailyProblems] Today IST: ${todayIST}`);

  const problemPool = await customPrisma.problem.findMany({
    select: { id: true, slug: true, title: true, difficulty: true },
    orderBy: { problemNumber: "asc" },
  });

  if (!problemPool || problemPool.length === 0) {
    throw new Error(
      "No problems found in database. Seed problems first using 'npm run problems:seed' or 'node scripts/upload-problem.js ./problems'.",
    );
  }

  console.log(`[Seed DailyProblems] Rotating across ${problemPool.length} problems for 35 days`);

  let seededCount = 0;
  // Loop MUST start at i=0 (today) up to i < 35 (today + next 34 days = 35 rows)
  for (let i = 0; i < 35; i++) {
    const istDate = addDaysToISTDate(todayIST, i);
    const problem = problemPool[i % problemPool.length];

    try {
      await customPrisma.dailyProblem.upsert({
        where: { istDate },
        update: { problemId: problem.id },
        create: {
          istDate,
          problemId: problem.id,
        },
      });
      seededCount++;
    } catch (err) {
      console.warn(`[Seed DailyProblems] Upsert failed for ${istDate}:`, err.message);
    }
  }

  // Verify today row exists
  const todayRow = await customPrisma.dailyProblem.findUnique({
    where: { istDate: todayIST },
  });

  if (todayRow) {
    console.log(`✅ TODAY FOUND: istDate=${todayRow.istDate}, problemId=${todayRow.problemId}`);
  } else {
    console.error(`❌ TODAY MISSING: No record found for ${todayIST}`);
  }

  console.log(`✅ Seeded ${seededCount} daily problems starting from ${todayIST}`);
  return seededCount;
}

if (process.argv[1] && process.argv[1].endsWith("seedDailyProblems.js")) {
  seedDailyProblems()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("❌ Seed daily problems failed:", err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect().catch(() => {});
    });
}
