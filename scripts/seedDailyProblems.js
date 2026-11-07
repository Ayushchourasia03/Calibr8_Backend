import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import prisma from "../src/config/db.js";
import { getISTDateString } from "../src/services/streakService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROBLEMS_DIR = path.resolve(__dirname, "../problems");

export async function seedDailyProblems(customPrisma = prisma, daysCount = 35) {
  let problemPool = [];

  // 1. Try to load problems from /problems directory
  if (fs.existsSync(PROBLEMS_DIR)) {
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
      } catch {}
    }
  }

  // 2. Fallback list if directory was empty
  if (problemPool.length === 0) {
    problemPool = [
      { id: "two-sum", slug: "two-sum", title: "Two Sum", difficulty: "Easy" },
      { id: "add-two-numbers", slug: "add-two-numbers", title: "Add Two Numbers", difficulty: "Medium" },
      { id: "best-time-to-buy-and-sell-stock", slug: "best-time-to-buy-and-sell-stock", title: "Best Time to Buy and Sell Stock", difficulty: "Easy" },
      { id: "backspace-string-compare", slug: "backspace-string-compare", title: "Backspace String Compare", difficulty: "Easy" },
      { id: "3sum", slug: "3sum", title: "3Sum", difficulty: "Medium" },
    ];
  }

  // Sort easy problems first to give a smooth rotation
  problemPool.sort((a, b) => {
    const rank = { Easy: 1, Medium: 2, Hard: 3 };
    return (rank[a.difficulty] || 2) - (rank[b.difficulty] || 2);
  });

  const now = new Date();
  const createdRecords = [];

  // Seed from 2 days ago up to daysCount days in advance
  for (let offset = -2; offset <= daysCount; offset++) {
    const targetDate = new Date(now.getTime() + offset * 86400000);
    const istDate = getISTDateString(targetDate);
    const problem = problemPool[Math.abs(offset + 2) % problemPool.length];

    try {
      const record = await customPrisma.dailyProblem.upsert({
        where: { istDate },
        update: { problemId: problem.id },
        create: {
          istDate,
          problemId: problem.id,
        },
      });
      createdRecords.push(record);
    } catch (e) {
      console.warn(`[Seed DailyProblem] Notice on date ${istDate}:`, e.message);
    }
  }

  return createdRecords;
}

if (process.argv[1] && process.argv[1].endsWith("seedDailyProblems.js")) {
  console.log("🌱 Seeding Daily Problems for next 35 days...");
  seedDailyProblems()
    .then((records) => {
      console.log(`✅ Successfully seeded ${records.length} DailyProblem records!`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("❌ Seeding failed:", err);
      process.exit(1);
    });
}
