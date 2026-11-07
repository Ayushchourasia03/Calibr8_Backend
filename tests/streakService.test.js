import assert from "assert";
import {
  getISTDateString,
  getYesterdayIST,
  nextStreak,
  bonusForStreak,
} from "../src/services/streakService.js";

console.log("Running Streak Service Unit Tests (U1 - U11)...");

// U1: First login
const u1 = nextStreak(null, "2026-11-07", 0);
assert.strictEqual(u1, 1, "U1 failed: first login must return streak 1");
console.log("✔ U1: First login streak = 1");

// U2: Same day
const u2 = nextStreak("2026-11-07", "2026-11-07", 3);
assert.strictEqual(u2, 3, "U2 failed: same day login must preserve current streak");
console.log("✔ U2: Same day login streak preserved");

// U3: Next day
const u3 = nextStreak("2026-11-06", "2026-11-07", 3);
assert.strictEqual(u3, 4, "U3 failed: next day login must increment streak");
console.log("✔ U3: Next day login streak increments");

// U4: Gap of 2+ days
const u4 = nextStreak("2026-11-05", "2026-11-07", 5);
assert.strictEqual(u4, 1, "U4 failed: missed day must reset streak to 1");
console.log("✔ U4: Missed day resets streak to 1");

// U5: Bonus day 7
const u5 = bonusForStreak(7);
assert.strictEqual(u5.bonus, 5, "U5 failed: streak 7 bonus must be 5");
assert.strictEqual(u5.type, "STREAK_7_BONUS", "U5 failed: bonus type must be STREAK_7_BONUS");
console.log("✔ U5: Streak 7 gives +5 (STREAK_7_BONUS)");

// U6: Bonus day 14
const u6 = bonusForStreak(14);
assert.strictEqual(u6.bonus, 5, "U6 failed: streak 14 bonus must be 5");
assert.strictEqual(u6.type, "STREAK_7_BONUS", "U6 failed: bonus type must be STREAK_7_BONUS");
console.log("✔ U6: Streak 14 gives +5 (STREAK_7_BONUS)");

// U7: Bonus day 30 (must be 25, not 5)
const u7 = bonusForStreak(30);
assert.strictEqual(u7.bonus, 25, "U7 failed: streak 30 bonus must be 25");
assert.strictEqual(u7.type, "STREAK_30_BONUS", "U7 failed: bonus type must be STREAK_30_BONUS");
console.log("✔ U7: Streak 30 gives +25 (STREAK_30_BONUS, no extra +5)");

// U8: Bonus day 60
const u8 = bonusForStreak(60);
assert.strictEqual(u8.bonus, 25, "U8 failed: streak 60 bonus must be 25");
assert.strictEqual(u8.type, "STREAK_30_BONUS", "U8 failed: bonus type must be STREAK_30_BONUS");
console.log("✔ U8: Streak 60 gives +25 (STREAK_30_BONUS)");

// U9: No bonus day 6
const u9 = bonusForStreak(6);
assert.strictEqual(u9.bonus, 0, "U9 failed: streak 6 bonus must be 0");
assert.strictEqual(u9.type, null, "U9 failed: streak 6 bonus type must be null");
console.log("✔ U9: Streak 6 gives 0 bonus");

// U10: IST date conversion (UTC 2026-11-06 19:00:00Z -> IST 2026-11-07 00:30)
const u10Date = new Date("2026-11-06T19:00:00.000Z");
const u10 = getISTDateString(u10Date);
assert.strictEqual(u10, "2026-11-07", "U10 failed: 19:00 UTC should be 00:30 IST on next day");
console.log("✔ U10: UTC 19:00 correctly converts to IST next day 00:30 (2026-11-07)");

// U11: IST midnight edge (UTC 2026-11-06 18:29:00Z -> IST 23:59)
const u11Date = new Date("2026-11-06T18:29:00.000Z");
const u11 = getISTDateString(u11Date);
assert.strictEqual(u11, "2026-11-06", "U11 failed: 18:29 UTC should be 23:59 IST on 2026-11-06");
console.log("✔ U11: UTC 18:29 correctly converts to IST same day 23:59 (2026-11-06)");

// Extra helper check: getYesterdayIST
assert.strictEqual(getYesterdayIST("2026-11-07"), "2026-11-06");
assert.strictEqual(getYesterdayIST("2026-01-01"), "2025-12-31");
console.log("✔ getYesterdayIST handles month/year boundaries accurately");

console.log("ALL STREAK SERVICE UNIT TESTS PASSED! 🎉");
