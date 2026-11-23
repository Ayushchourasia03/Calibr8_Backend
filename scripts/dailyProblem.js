// scripts/dailyProblem.js
// Operations for the daily problem.
//
//   node scripts/dailyProblem.js status
//       Today's and tomorrow's problem, the last 14 days, rows scheduled
//       further ahead, and back-to-back repeats.
//   node scripts/dailyProblem.js ensure
//       Creates today's and tomorrow's rows if missing (the server does this
//       at startup and hourly).
//   node scripts/dailyProblem.js prune-future [--apply]
//       Lists rows dated after tomorrow that nobody has completed (for
//       example, an old pre-seeded schedule) and, with --apply, deletes them
//       so the selector assigns those days instead. Dry run by default.

import prisma from "../src/config/db.js";
import { ensureUpcomingDailyProblems } from "../src/services/dailyProblemService.js";
import { getISTDateString, addDaysToISTDate } from "../src/services/streakService.js";

const today = getISTDateString();
const tomorrow = addDaysToISTDate(today, 1);

function line(row) {
  const p = row.problem;
  return `${row.istDate}  ${p.slug} (${p.difficulty})  completions=${row._count.completions}`;
}

async function status() {
  const rows = await prisma.dailyProblem.findMany({
    where: { istDate: { gte: addDaysToISTDate(today, -13) } },
    orderBy: { istDate: "asc" },
    select: {
      istDate: true,
      problemId: true,
      problem: { select: { slug: true, difficulty: true } },
      _count: { select: { completions: true } },
    },
  });
  const eligible = await prisma.problem.count({ where: { testcases: { some: {} } } });

  console.log(`Today (IST): ${today}   eligible problems: ${eligible}`);
  for (const date of [today, tomorrow]) {
    const row = rows.find((r) => r.istDate === date);
    console.log(`${date === today ? "Today   " : "Tomorrow"}: ${row ? line(row) : "MISSING"}`);
  }

  console.log("\nLast 14 days:");
  for (const row of rows.filter((r) => r.istDate <= today)) console.log(`  ${line(row)}`);

  const ahead = rows.filter((r) => r.istDate > tomorrow);
  if (ahead.length > 0) {
    console.log(`\nScheduled after tomorrow (${ahead.length}); see prune-future:`);
    for (const row of ahead) console.log(`  ${line(row)}`);
  }

  const repeats = rows.filter((r, i) => i > 0 && r.problemId === rows[i - 1].problemId
    && rows[i - 1].istDate === addDaysToISTDate(r.istDate, -1));
  if (repeats.length > 0) {
    console.log(`\nBack-to-back repeats: ${repeats.map((r) => r.istDate).join(", ")}`);
  }
}

async function ensure() {
  const { today: t, tomorrow: n } = await ensureUpcomingDailyProblems();
  console.log(`Today    ${t.istDate}: ${t.problem.slug}`);
  console.log(`Tomorrow ${n.istDate}: ${n.problem.slug}`);
}

async function pruneFuture(apply) {
  const where = { istDate: { gt: tomorrow }, completions: { none: {} } };
  const rows = await prisma.dailyProblem.findMany({
    where,
    orderBy: { istDate: "asc" },
    select: { istDate: true, problem: { select: { slug: true } } },
  });
  if (rows.length === 0) {
    console.log("No rows scheduled after tomorrow.");
    return;
  }
  for (const row of rows) console.log(`  ${row.istDate}  ${row.problem.slug}`);
  if (!apply) {
    console.log(`\n${rows.length} row(s) would be deleted. Re-run with --apply to delete them.`);
    return;
  }
  const { count } = await prisma.dailyProblem.deleteMany({ where });
  console.log(`\nDeleted ${count} row(s).`);
}

const [command = "status", flag] = process.argv.slice(2);
const commands = {
  status,
  ensure,
  "prune-future": () => pruneFuture(flag === "--apply"),
};

if (!commands[command]) {
  console.error(`Unknown command "${command}". Use: status | ensure | prune-future [--apply]`);
  process.exitCode = 1;
} else {
  try {
    await commands[command]();
  } catch (err) {
    console.error(`dailyProblem ${command} failed:`, err?.message || err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}
