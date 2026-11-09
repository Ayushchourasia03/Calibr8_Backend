/**
 * Streak Service - Calibr8
 * Authoritative Asia/Kolkata (IST) Timezone calculations for Daily Problem & Login Rewards.
 * Day boundary starts at 00:00 IST.
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
    // Fallback: manual offset UTC+5:30
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

/**
 * Computes Daily Problem streak advancement according to FR-04:
 * 1. First Daily Problem completion: streak = 1.
 * 2. Completion on consecutive IST calendar days: streak += 1.
 * 3. Missed IST calendar day: streak resets to 1.
 * 4. Duplicate solve on same IST day: streak unchanged.
 */
export function computeDailyProblemStreak(lastStreakDate, todayIST = getISTDateString(), currentStreak = 0) {
  const lastIST = toISTDateString(lastStreakDate);
  const cur = Number(currentStreak) || 0;
  const yesterdayIST = getYesterdayIST(todayIST);

  if (!lastIST) {
    return { newStreak: 1, isNewDay: true };
  }
  if (lastIST === todayIST) {
    return { newStreak: cur, isNewDay: false };
  }
  if (lastIST === yesterdayIST) {
    return { newStreak: cur + 1, isNewDay: true };
  }
  return { newStreak: 1, isNewDay: true };
}

/**
 * Supports both:
 *  nextStreak("2026-11-06", "2026-11-07", 3) -> 4 (number)
 *  nextStreak({ lastStreakDate, currentStreak, todayISTDate }) -> { newStreak, isNewDay } (object)
 */
export function nextStreak(a, b, c) {
  if (a !== null && typeof a === "object" && !(a instanceof Date) && !Array.isArray(a)) {
    const lastIST = toISTDateString(a.lastStreakDate ?? a.lastDate ?? null);
    const todayIST = a.todayISTDate || a.todayIST || getISTDateString(new Date());
    const cur = a.currentStreak ?? a.streak ?? 0;
    return computeDailyProblemStreak(lastIST, todayIST, cur);
  }
  const lastIST = toISTDateString(a);
  const todayIST = typeof b === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b) ? b : getISTDateString(b || new Date());
  const streakVal = typeof c === "number" ? c : (typeof b === "number" ? b : 0);
  const res = computeDailyProblemStreak(lastIST, todayIST, streakVal);
  return res.newStreak;
}

/**
 * Calculates daily login reward per FR-05:
 * +1 coin for the first login of an IST calendar day.
 * Login does NOT alter streak or grant milestone bonuses.
 */
export function calcLoginReward(input, maybeTodayIST) {
  let lastLoginIST = null;
  let todayIST = null;

  if (input !== null && typeof input === "object" && !(input instanceof Date)) {
    lastLoginIST = toISTDateString(input.lastLoginISTDate ?? null);
    todayIST = maybeTodayIST || input.todayISTDate || input.todayIST || getISTDateString(new Date());
  } else {
    lastLoginIST = toISTDateString(input);
    todayIST = typeof maybeTodayIST === "string" ? maybeTodayIST : getISTDateString(new Date());
  }

  const isNewDay = !lastLoginIST || lastLoginIST !== todayIST;

  return {
    isNewDay,
    loginCoins: isNewDay ? 1 : 0,
    coinsEarnedToday: isNewDay ? 1 : 0,
    bonusCoins: 0,
    bonus: 0,
    bonusType: null,
    type: isNewDay ? "DAILY_LOGIN" : null,
  };
}