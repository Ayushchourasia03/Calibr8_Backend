// scripts/seedDailyProblems.js
// Seeds DailyProblem table for today + next 34 days = 35 rows.
// Loop starts at i = 0 (today).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import prisma from "../src/config/db.js";
import { getISTDateString, addDaysToISTDate } from "../src/services/streakService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROBLEMS_DIR = path.resolve(__dirname, "../problems");

export async function seedDailyProblems(customPrisma = prisma) {
  const todayIST = getISTDateString(new Date());
  console.log(`[Seed DailyProblems] Today IST: ${todayIST}`);

  // 1. Get problems from database first, or fallback to json files
  let problemPool = [];
  try {
    const dbProblems = await customPrisma.problem.findMany({
      select: { id: true, slug: true, title: true, difficulty: true },
      orderBy: { problemNumber: "asc" },
    });
    if (dbProblems && dbProblems.length > 0) {
      problemPool = dbProblems;
    }
  } catch (err) {
    console.warn("[Seed DailyProblems] DB query notice:", err.message);
  }

  // Fallback to local files if DB was empty
  if (problemPool.length === 0 && fs.existsSync(PROBLEMS_DIR)) {
    try {
      const files = fs.readdirSync(PROBLEMS_DIR).filter((f) => f.endsWith(".json"));
      for (const f of files) {
        try {
          const raw = fs.readFileSync(path.join(PROBLEMS_DIR, f), "utf-8");
          const json = JSON.parse(raw);
          problemPool.push({
            id: json.id || json.slug || f.replace(".json", ""),
            slug: json.slug || f.replace(".json", ""),
            title: json.title,
            difficulty: json.difficulty || "Easy",
          });
        } catch (_) {}
      }
    } catch (_) {}
  }

  // Hardcoded fallback if no problems could be found
  if (problemPool.length === 0) {
    problemPool = [
      { id: "two-sum", slug: "two-sum", title: "Two Sum", difficulty: "Easy" },
      { id: "add-two-numbers", slug: "add-two-numbers", title: "Add Two Numbers", difficulty: "Medium" },
      { id: "best-time-to-buy-and-sell-stock", slug: "best-time-to-buy-and-sell-stock", title: "Best Time to Buy and Sell Stock", difficulty: "Easy" },
      { id: "backspace-string-compare", slug: "backspace-string-compare", title: "Backspace String Compare", difficulty: "Easy" },
      { id: "3sum", slug: "3sum", title: "3Sum", difficulty: "Medium" },
    ];
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
