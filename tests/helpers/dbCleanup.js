// tests/helpers/dbCleanup.js
//
// Tests run against the real database (.env DATABASE_URL). Every test that
// writes to it must remove everything it wrote, and only that. Import this
// module FIRST in such a test and call cleanupTestUsers(where) in its final
// cleanup for the users it created.
//
// What a test can leave behind, and how it is removed:
//   - its users and everything that belongs to them (submissions, solve
//     progress, coin transactions, daily-problem completions, themes, social
//     accounts, topics, complexity profiles): deleted through the users'
//     ON DELETE CASCADE relations;
//   - revoked_tokens rows (logout / refresh / password change): no foreign
//     key, deleted by userId;
//   - problems.solvedCount (raised by a test user's first accepted solve):
//     recomputed from the remaining real submissions; when that equals the
//     value from before the test, updatedAt is restored too, so the row is
//     exactly as it was;
//   - today's daily problem row (GET /api/daily-problem and accepted
//     submissions create it when missing): deleted if it did not exist when
//     the test started and nobody completed it.
// Far-future daily_problems rows are cleaned up by the daily-problem tests.
import prisma from "../../src/config/db.js";
import { getISTDateString, addDaysToISTDate } from "../../src/services/streakService.js";

// ---- snapshot taken when the test file starts ----------------------------
const startedAt = new Date();
const today = getISTDateString(startedAt);
const watchedDates = [addDaysToISTDate(today, -1), today, addDaysToISTDate(today, 1)];
const existingDailyDates = new Set(
  (
    await prisma.dailyProblem.findMany({
      where: { istDate: { in: watchedDates } },
      select: { istDate: true },
    })
  ).map((row) => row.istDate),
);
const problemSnapshot = new Map(
  (
    await prisma.problem.findMany({ select: { id: true, solvedCount: true, updatedAt: true } })
  ).map((p) => [p.id, p]),
);

async function realSolvedCount(problemId) {
  const [row] = await prisma.$queryRaw`
    SELECT COUNT(DISTINCT "userId")::int AS count
      FROM "submissions"
     WHERE "problemId" = ${problemId}
       AND UPPER("status") = 'ACCEPTED'
       AND "userId" IS NOT NULL
       AND "totalCount" > 0
       AND "passedCount" = "totalCount"`;
  return Number(row?.count) || 0;
}

/** Restores problems.solvedCount (and updatedAt when unchanged) after the test users are gone. */
async function restoreProblems(problemIds) {
  for (const problemId of problemIds) {
    const before = problemSnapshot.get(problemId);
    if (!before) continue; // a problem the test created itself
    const count = await realSolvedCount(problemId);
    if (count === before.solvedCount) {
      await prisma.$executeRaw`
        UPDATE "problems" SET "solvedCount" = ${count}, "updatedAt" = ${before.updatedAt}
         WHERE "id" = ${problemId}`;
    } else {
      await prisma.$executeRaw`UPDATE "problems" SET "solvedCount" = ${count} WHERE "id" = ${problemId}`;
    }
  }
}

/** Deletes real-date daily_problems rows this test created (only if nobody completed them). */
async function removeCreatedDailyRows() {
  const rows = await prisma.dailyProblem.findMany({
    where: { istDate: { in: watchedDates.filter((d) => !existingDailyDates.has(d)) } },
    select: { id: true, istDate: true, createdAt: true, _count: { select: { completions: true } } },
  });
  for (const row of rows) {
    if (row.createdAt >= startedAt && row._count.completions === 0) {
      await prisma.dailyProblem.delete({ where: { id: row.id } }).catch(() => {});
    }
  }
}

/**
 * Removes the users matching `where` and every trace they left (see above).
 * Safe to call more than once; never throws.
 * @param {object} where Prisma UserWhereInput selecting ONLY users this test created
 */
export async function cleanupTestUsers(where) {
  try {
    const users = await prisma.user.findMany({ where, select: { id: true } });
    const ids = users.map((u) => u.id);
    let touchedProblems = [];
    if (ids.length) {
      touchedProblems = (
        await prisma.submission.findMany({
          where: { userId: { in: ids } },
          distinct: ["problemId"],
          select: { problemId: true },
        })
      ).map((s) => s.problemId);
      await prisma.revokedToken.deleteMany({ where: { userId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    // Users a test deleted itself (e.g. DELETE /api/users/me) are no longer
    // matched above: remove revocation rows written during this run whose
    // user no longer exists. Rows of existing users are never touched.
    await prisma.$executeRaw`
      DELETE FROM "revoked_tokens" r
       WHERE r."createdAt" >= ${startedAt}
         AND r."userId" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = r."userId")`;
    await restoreProblems(touchedProblems);
    await removeCreatedDailyRows();
  } catch (err) {
    console.error("[dbCleanup] cleanup failed:", err?.message || err);
  }
}

/** Removes revoked_tokens rows left by tokens of the given user ids (users kept). */
export async function cleanupRevokedTokens(userIds) {
  if (!userIds?.length) return;
  await prisma.revokedToken.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
}
