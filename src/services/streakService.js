/**
 * Streak Service - Calibr8
 * Authoritative Asia/Kolkata (IST) date helpers for the Daily Problem and
 * login rewards. A day starts at 00:00 IST. IST is a fixed UTC+05:30 offset
 * (no daylight saving), so plain arithmetic is exact and needs no ICU data.
 */

const IST_OFFSET_MS = 330 * 60 * 1000;
const IST_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toValidDate(value) {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** IST calendar date ("YYYY-MM-DD") of an instant. Invalid input means "now". */
export function getISTDateString(date = new Date()) {
  const d = toValidDate(date) ?? new Date();
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** True for a real calendar date written as "YYYY-MM-DD". */
export function isISTDateString(value) {
  if (typeof value !== "string" || !IST_DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** IST date of a stored value; "YYYY-MM-DD" strings pass through. */
export function toISTDateString(value) {
  if (!value) return null;
  if (typeof value === "string" && IST_DATE_RE.test(value)) return value;
  const d = toValidDate(value);
  return d ? getISTDateString(d) : null;
}

export function addDaysToISTDate(istDateString, days) {
  if (!isISTDateString(istDateString)) istDateString = getISTDateString();
  const dt = new Date(`${istDateString}T00:00:00.000Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function getYesterdayIST(todayISTDate) {
  return addDaysToISTDate(todayISTDate, -1);
}

/** The instant 00:00 IST starts the given IST date. */
export function startOfISTDay(istDateString) {
  return new Date(Date.parse(`${istDateString}T00:00:00.000Z`) - IST_OFFSET_MS);
}

/** The next 00:00 IST strictly after `now`. */
export function nextISTMidnight(now = new Date()) {
  return startOfISTDay(addDaysToISTDate(getISTDateString(now), 1));
}

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

  if (!lastIST) {
    return { newStreak: 1, isNewDay: true };
  }
  if (lastIST === todayIST) {
    return { newStreak: cur, isNewDay: false };
  }
  if (lastIST === getYesterdayIST(todayIST)) {
    return { newStreak: cur + 1, isNewDay: true };
  }
  return { newStreak: 1, isNewDay: true };
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
