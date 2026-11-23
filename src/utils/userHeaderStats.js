const TIERS = ["Pulse", "Flux", "Prism", "Aurora", "Eclipse", "Zenith"];
const DIVISIONS = ["I", "II", "III"];

/** Tier label ("Prism II") for a rating; same formula as the reward logic. */
export function tierForRating(rating) {
  const value = Number.isFinite(Number(rating)) ? Number(rating) : 800;
  const tierIndex = Math.min(5, Math.max(0, Math.floor((value - 700) / 200)));
  const tierFloor = 700 + tierIndex * 200;
  const divisionIndex = Math.min(2, Math.max(0, Math.floor((value - tierFloor) / (200 / 3))));
  return `${TIERS[tierIndex]} ${DIVISIONS[divisionIndex]}`;
}

export function getUserHeaderStats(user) {
  const rating = user.rating ?? 800;
  const tierIndex = Math.min(5, Math.max(0, Math.floor((rating - 700) / 200)));
  const tierFloor = 700 + tierIndex * 200;
  const divisionIndex = Math.min(
    2,
    Math.max(0, Math.floor((rating - tierFloor) / (200 / 3))),
  );
  const scoreUnits = user.score ?? 0;

  return {
    rating,
    tier: `${TIERS[tierIndex]} ${DIVISIONS[divisionIndex]}`,
    score: Math.floor(scoreUnits / 10),
    scoreUnits,
    coins: user.coins ?? 100,
    streak: user.streak ?? 0,
    longestStreak: user.longestStreak ?? 0,
  };
}
