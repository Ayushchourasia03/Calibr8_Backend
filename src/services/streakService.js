/**
 * Streak Service - Pure functions for IST date handling, streak calculation, and bonus rewards.
 * Zero database side-effects - fully unit testable.
 *
 * Timezone: Asia/Kolkata (IST, UTC+5:30)
 * Calendar Day: 00:00:00 to 23:59:59 IST
 */

/**
 * Returns the current or provided date formatted as YYYY-MM-DD in Asia/Kolkata (IST).
 * @param {Date|string|number} [date=new Date()]
 * @returns {string} YYYY-MM-DD in IST
 */
export function getISTDateString(date = new Date()) {
  const d = typeof date === "string" || typeof date === "number" ? new Date(date) : (date || new Date());
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Computes the previous calendar day's YYYY-MM-DD string from an existing IST date string.
 * Uses UTC date calculations to prevent DST and local clock shifts.
 * @param {string} todayISTDate YYYY-MM-DD
 * @returns {string} YYYY-MM-DD of the previous day
 */
export function getYesterdayIST(todayISTDate) {
  if (!todayISTDate || typeof todayISTDate !== "string") return null;
  const [y, m, d] = todayISTDate.split("-").map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  const prevY = prev.getUTCFullYear();
  const prevM = String(prev.getUTCMonth() + 1).padStart(2, "0");
  const prevD = String(prev.getUTCDate()).padStart(2, "0");
  return `${prevY}-${prevM}-${prevD}`;
}

/**
 * Computes the next streak count on login.
 *
 * Cases:
 * - first login ever (lastISTDate is null): returns 1
 * - same day login (lastISTDate === todayISTDate): returns currentStreak
 * - consecutive day login (lastISTDate === yesterdayISTDate): returns currentStreak + 1
 * - missed 1+ days: resets to 1 (because today's login itself counts)
 *
 * @param {string|null} lastISTDate
 * @param {string} todayISTDate
 * @param {number} [currentStreak=0]
 * @returns {number}
 */
export function nextStreak(lastISTDate, todayISTDate, currentStreak = 0) {
  if (!lastISTDate) return 1;
  if (lastISTDate === todayISTDate) return Number(currentStreak) || 0;
  if (lastISTDate === getYesterdayIST(todayISTDate)) {
    return (Number(currentStreak) || 0) + 1;
  }
  return 1;
}

/**
 * Calculates milestone streak bonus coins.
 * Stacking Rule:
 * - Milestone 30 (30, 60, 90...): +25 coins, type "STREAK_30_BONUS" (no extra +5)
 * - Milestone 7 (7, 14, 21, 28, 35...): +5 coins, type "STREAK_7_BONUS"
 * - Otherwise: 0 bonus coins
 *
 * @param {number} streak
 * @returns {{ bonus: number, type: string|null }}
 */
export function bonusForStreak(streak) {
  const s = Number(streak) || 0;
  if (s <= 0) return { bonus: 0, type: null };
  if (s % 30 === 0) {
    return { bonus: 25, type: "STREAK_30_BONUS" };
  }
  if (s % 7 === 0) {
    return { bonus: 5, type: "STREAK_7_BONUS" };
  }
  return { bonus: 0, type: null };
}
