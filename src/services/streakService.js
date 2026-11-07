/**
 * Streak Service - UNIFIED version
 * Supports BOTH APIs so old and new coinService code both work:
 *  - OLD: nextStreak(lastISTDate, todayISTDate, currentStreak) -> number
 *  - NEW: nextStreak({ lastStreakDate, currentStreak, todayISTDate }) -> { newStreak, isNewDay }
 *  - OLD: bonusForStreak(streak) -> { bonus, type }
 *  - NEW: bonusForStreak(streak) -> { bonus, bonusType }
 * This file returns BOTH keys: { bonus, type, bonusType }
 * getISTDateString NEVER throws - invalid input returns today's IST date.
 */

export function getISTDateString(date = new Date()) {
  try {
    let d = date;
    if (d === null || d === undefined || d === "") d = new Date();
    else if (typeof d === "string" || typeof d === "number") d = new Date(d);
    if (!(d instanceof Date) || isNaN(d.getTime())) d = new Date();
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    // Fallback: never crash, return today IST via manual offset
    const now = new Date();
    const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
    const y = ist.getUTCFullYear();
    const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(ist.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }
}

export function toISTDateString(value) {
  if (!value) return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  try {
    const d = new Date(value);
    if (isNaN(d.getTime())) return null;
    return getISTDateString(d);
  } catch {
    return null;
  }
}

export function addDaysToISTDate(istDateString, days) {
  if (!istDateString || typeof istDateString !== "string") istDateString = getISTDateString(new Date());
  const [y, m, d] = istDateString.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
export const addDaysToIST = addDaysToISTDate;
export const addDays = addDaysToISTDate;

export function getYesterdayIST(todayISTDate) {
  if (!todayISTDate || typeof todayISTDate !== "string") todayISTDate = getISTDateString(new Date());
  return addDaysToISTDate(todayISTDate, -1);
}
export const getYesterdayISTDate = getYesterdayIST;

function computeNextStreak(lastIST, todayIST, currentStreak) {
  const cur = Number(currentStreak) || 0;
  if (!lastIST) return { newStreak: 1, isNewDay: true };
  if (lastIST === todayIST) return { newStreak: cur, isNewDay: false };
  if (lastIST === getYesterdayIST(todayIST)) return { newStreak: cur + 1, isNewDay: true };
  return { newStreak: 1, isNewDay: true };
}

/**
 * Supports both:
 *  nextStreak("2026-11-06", "2026-11-07", 3) -> 4 (number, old API)
 *  nextStreak({ lastStreakDate, currentStreak, todayISTDate }) -> { newStreak, isNewDay } (new API)
 *  nextStreak(Date, ...) also works - Date is converted via toISTDateString
 */
export function nextStreak(a, b, c) {
  // New API: single object arg
  if (a !== null && typeof a === "object" && !(a instanceof Date) && !Array.isArray(a)) {
    const lastIST = toISTDateString(a.lastStreakDate ?? a.lastISTDate ?? a.lastDate ?? null);
    const todayIST = a.todayISTDate || a.todayIST || getISTDateString(new Date());
    const cur = a.currentStreak ?? a.streak ?? 0;
    return computeNextStreak(lastIST, todayIST, cur);
  }
  // Old API: positional
  const lastIST = toISTDateString(a);
  const todayIST = typeof b === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b) ? b : getISTDateString(b || new Date());
  const cur = typeof b === "number" ? b : (c ?? 0);
  // Handle old call: nextStreak(lastIST, todayIST, currentStreak) where b is today, c is streak
  // Also handle nextStreak(lastIST, currentStreak) - not used, but be safe
  const today = typeof b === "string" ? b : todayIST;
  const streakVal = typeof c === "number" ? c : (typeof b === "number" ? b : 0);
  const res = computeNextStreak(lastIST, today, streakVal);
  return res.newStreak; // OLD API returns number
}

export function bonusForStreak(streak) {
  const s = Number(streak) || 0;
  if (s <= 0) return { bonus: 0, type: null, bonusType: null };
  if (s % 30 === 0) return { bonus: 25, type: "STREAK_30_BONUS", bonusType: "STREAK_30_BONUS" };
  if (s % 7 === 0) return { bonus: 5, type: "STREAK_7_BONUS", bonusType: "STREAK_7_BONUS" };
  return { bonus: 0, type: null, bonusType: null };
}

export function calcLoginReward(input) {
  // Supports both: calcLoginReward({ lastStreakDate, currentStreak, todayISTDate })
  // and calcLoginReward(lastISTDate, todayISTDate, currentStreak)
  let lastIST = null, todayIST = null, cur = 0;
  if (input !== null && typeof input === "object" && !(input instanceof Date)) {
    lastIST = toISTDateString(input.lastStreakDate ?? input.lastISTDate ?? null);
    todayIST = input.todayISTDate || input.todayIST || getISTDateString(new Date());
    cur = input.currentStreak ?? input.streak ?? 0;
  } else {
    lastIST = toISTDateString(input);
    todayIST = getISTDateString(new Date());
    cur = 0;
  }
  const { newStreak, isNewDay } = computeNextStreak(lastIST, todayIST, cur);
  if (!isNewDay) {
    return { newStreak, isNewDay: false, loginCoins: 0, bonusCoins: 0, bonus: 0, bonusType: null, type: null, coinsEarnedToday: 0 };
  }
  const b = bonusForStreak(newStreak);
  return {
    newStreak,
    isNewDay: true,
    loginCoins: 1,
    bonusCoins: b.bonus,
    bonus: b.bonus,
    bonusType: b.bonusType,
    type: b.type,
    coinsEarnedToday: 1 + b.bonus,
  };
}