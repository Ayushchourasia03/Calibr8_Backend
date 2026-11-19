export function getSolvedUserCounts(submissions) {
  const usersByProblem = new Map();

  for (const submission of submissions) {
    if (
      String(submission.status).toUpperCase() !== "ACCEPTED" ||
      !submission.userId ||
      submission.totalCount <= 0 ||
      submission.passedCount !== submission.totalCount
    ) {
      continue;
    }

    if (!usersByProblem.has(submission.problemId)) {
      usersByProblem.set(submission.problemId, new Set());
    }
    usersByProblem.get(submission.problemId).add(submission.userId);
  }

  return new Map(
    [...usersByProblem].map(([problemId, users]) => [problemId, users.size]),
  );
}

async function countSolvedUsersSql(prisma, problemId) {
  if (typeof prisma.$queryRaw !== "function") return null;
  try {
    const [row] = await prisma.$queryRaw`
      SELECT COUNT(DISTINCT "userId")::int AS count
      FROM "submissions"
      WHERE "problemId" = ${problemId}
        AND UPPER("status") = 'ACCEPTED'
        AND "userId" IS NOT NULL
        AND "totalCount" > 0
        AND "passedCount" = "totalCount"
    `;
    return Number(row?.count) || 0;
  } catch {
    return null;
  }
}

export async function syncProblemSolvedCount(prisma, problemId) {
  // Fast path: aggregate in PostgreSQL instead of loading every accepted
  // submission for the problem into memory on each accepted submit.
  const sqlCount = await countSolvedUsersSql(prisma, problemId);
  if (sqlCount !== null) {
    await prisma.problem.update({
      where: { id: problemId },
      data: { solvedCount: sqlCount },
    });
    return sqlCount;
  }

  const submissions = await prisma.submission.findMany({
    where: {
      problemId,
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
  });
  const solvedCount = getSolvedUserCounts(submissions).get(problemId) || 0;

  await prisma.problem.update({
    where: { id: problemId },
    data: { solvedCount },
  });

  return solvedCount;
}
