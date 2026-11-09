import assert from "assert";
import {
  getISTDateString,
  getYesterdayIST,
  computeDailyProblemStreak,
  nextStreak,
  calcLoginReward,
} from "../src/services/streakService.js";

console.log("Running Streak Service Unit Tests (FR-04 & FR-05)...");

// U1: First Daily Problem completion
const u1 = nextStreak(null, "2026-11-07", 0);
assert.strictEqual(u1, 1, "U1 failed: first completion must return streak 1");
console.log("✔ U1: First Daily Problem completion streak = 1");

// U2: Same day duplicate completion
const u2 = nextStreak("2026-11-07", "2026-11-07", 3);
assert.strictEqual(u2, 3, "U2 failed: same day completion must preserve current streak");
console.log("✔ U2: Same day completion streak preserved (3 -> 3)");

// U3: Next consecutive day completion
const u3 = nextStreak("2026-11-06", "2026-11-07", 3);
assert.strictEqual(u3, 4, "U3 failed: next day completion must increment streak");
console.log("✔ U3: Consecutive day completion increments streak (3 -> 4)");

// U4: Gap of 2+ days (missed day reset)
const u4 = nextStreak("2026-11-05", "2026-11-07", 5);
assert.strictEqual(u4, 1, "U4 failed: missed day must reset streak to 1");
console.log("✔ U4: Missed day resets streak to 1 (5 -> 1)");

// U5: Object form nextStreak
const u5 = nextStreak({
  lastStreakDate: "2026-11-06",
  todayISTDate: "2026-11-07",
  currentStreak: 2,
});
assert.strictEqual(u5.newStreak, 3);
assert.strictEqual(u5.isNewDay, true);
console.log("✔ U5: Object parameter structure supported for nextStreak");

// U6: Login reward calculation (FR-05: +1 coin, no streak modification)
const u6a = calcLoginReward({ lastLoginISTDate: "2026-11-06" }, "2026-11-07");
assert.strictEqual(u6a.loginCoins, 1);
assert.strictEqual(u6a.isNewDay, true);

const u6b = calcLoginReward({ lastLoginISTDate: "2026-11-07" }, "2026-11-07");
assert.strictEqual(u6b.loginCoins, 0);
assert.strictEqual(u6b.isNewDay, false);
console.log("✔ U6: Login reward grants +1 coin on new IST day, 0 on same day");

// U7: IST date conversion (UTC 2026-11-06 19:00:00Z -> IST 2026-11-07 00:30)
const u7Date = new Date("2026-11-06T19:00:00.000Z");
const u7 = getISTDateString(u7Date);
assert.strictEqual(u7, "2026-11-07", "U7 failed: 19:00 UTC should be 00:30 IST on next day");
console.log("✔ U7: UTC 19:00 correctly converts to IST next day 00:30 (2026-11-07)");

// U8: IST midnight edge (UTC 2026-11-06 18:29:00Z -> IST 23:59)
const u8Date = new Date("2026-11-06T18:29:00.000Z");
const u8 = getISTDateString(u8Date);
assert.strictEqual(u8, "2026-11-06", "U8 failed: 18:29 UTC should be 23:59 IST on 2026-11-06");
console.log("✔ U8: UTC 18:29 correctly converts to IST same day 23:59 (2026-11-06)");

// U9: getYesterdayIST handles month/year boundaries accurately
assert.strictEqual(getYesterdayIST("2026-11-07"), "2026-11-06");
assert.strictEqual(getYesterdayIST("2026-03-01"), "2026-02-28");
assert.strictEqual(getYesterdayIST("2026-01-01"), "2025-12-31");
console.log("✔ U9: getYesterdayIST handles month/year boundaries accurately");

console.log("ALL STREAK SERVICE UNIT TESTS PASSED! 🎉");
