import prisma from "../src/config/db.js";
import { getSolvedUserCounts } from "../src/utils/problemSolvedCount.js";

try {
  const [problems, submissions] = await Promise.all([
    prisma.problem.findMany({
      select: { id: true, solvedCount: true },
    }),
    prisma.submission.findMany({
      where: {
        status: { equals: "ACCEPTED", mode: "insensitive" },
        userId: { not: null },
        totalCount: { gt: 0 },
      },
      select: {
        problemId: true,
        userId: true,
        passedCount: true,
        totalCount: true,
        status: true,
      },
    }),
  ]);
  const solvedCounts = getSolvedUserCounts(submissions);
  let updatedCount = 0;

  for (const problem of problems) {
    const solvedCount = solvedCounts.get(problem.id) || 0;
    if (problem.solvedCount !== solvedCount) {
      await prisma.problem.update({
        where: { id: problem.id },
        data: { solvedCount },
      });
      updatedCount++;
    }
  }

  console.log(
    `Synchronized solvedCount for ${updatedCount} of ${problems.length} problems.`,
  );
} catch (error) {
  console.error("Failed to synchronize problem solved counts:", error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
