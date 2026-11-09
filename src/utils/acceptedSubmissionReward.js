import { getUserHeaderStats } from "./userHeaderStats.js";

const DIFFICULTY_POINTS = {
  easy: 10,
  medium: 25,
  hard: 50,
};

const DIVISION_NAMES = ["Pulse", "Flux", "Prism", "Aurora", "Eclipse", "Zenith"];
const DIVISIONS = ["I", "II", "III"];

function getTier(rating) {
  const tierIndex = Math.min(5, Math.max(0, Math.floor((rating - 700) / 200)));
  const tierFloor = 700 + tierIndex * 200;
  const divisionIndex = Math.min(
    2,
    Math.max(0, Math.floor((rating - tierFloor) / (200 / 3))),
  );
  return `${DIVISION_NAMES[tierIndex]} ${DIVISIONS[divisionIndex]}`;
}

export async function applyAcceptedSubmissionReward(
  tx,
  { userId, problem, now = new Date() },
) {
  if (!userId) return null;

  const points =
    DIFFICULTY_POINTS[String(problem.difficulty || "").toLowerCase()] ?? 10;
  const scoreAwarded = points * 10;
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      rating: true,
      score: true,
      coins: true,
      streak: true,
      longestStreak: true,
      lastStreakDate: true,
    },
  });

  if (!user) return null;

  const inserted = await tx.userProblemProgress.createMany({
    data: [
      {
        userId,
        problemId: problem.id,
        points,
        scoreAwarded,
        coinsAwarded: 0,
        solvedAt: now,
      },
    ],
    skipDuplicates: true,
  });

  if (inserted.count === 0) {
    return {
      awarded: false,
      points: 0,
      scoreDelta: 0,
      coinsEarned: 0,
      stats: getUserHeaderStats(user),
    };
  }

  const completedProblems = await tx.userProblemProgress.count({
    where: { userId },
  });
  const problemRating =
    { easy: 800, medium: 1200, hard: 1600 }[
      String(problem.difficulty || "").toLowerCase()
    ] ?? 800;
  const expected = 1 / (1 + 10 ** ((problemRating - user.rating) / 400));
  const kFactor = completedProblems <= 10 ? 60 : 32;
  const rating = Math.max(
    0,
    Math.round(user.rating + kFactor * (1 - expected)),
  );

  const updatedUser = await tx.user.update({
    where: { id: userId },
    data: {
      score: { increment: scoreAwarded },
      rating,
      tier: getTier(rating),
    },
  });

  return {
    awarded: true,
    points,
    scoreDelta: scoreAwarded,
    coinsEarned: 0,
    stats: getUserHeaderStats(updatedUser),
  };
}
