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

export async function syncProblemSolvedCount(prisma, problemId) {
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
