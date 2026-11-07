// scripts/seedDailyProblems.js
// Run: node scripts/seedDailyProblems.js
// Seeds DailyProblem for next 30 days. Run BEFORE you test daily problem reward.

import prisma from "../src/config/db.js";
import { getISTDateString, addDaysToISTDate } from "../src/services/streakService.js";

async function main() {
  const problems = await prisma.problem.findMany({ select: { id: true }, orderBy: { problemNumber: "asc" } });
  if (!problems.length) {
    console.log("No problems found. Seed problems first.");
    return;
  }
  const today = getISTDateString(new Date());
  let created = 0;
  for (let i = 0; i < 30; i++) {
    const istDate = addDaysToISTDate(today, i);
    const problem = problems[i % problems.length];
    const result = await prisma.dailyProblem.upsert({
      where: { istDate },
      update: {},
      create: { istDate, problemId: problem.id },
    });
    if (result) created++;
  }
  console.log(`Seeded ${created} daily problems from ${today}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
