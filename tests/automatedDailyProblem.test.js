// Integration tests: daily problem assignment, selection, history and API.
//
// Uses the database in DATABASE_URL. Every row it writes is either a test
// user or a daily_problems row dated in 2099, and only those are cleaned up.
// It never creates, changes or deletes a real day's row (the old version did,
// which reassigned live daily problems and cascade-deleted users' completions).
import "dotenv/config";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.JWT_SECRET = "a".repeat(40);

const { default: prisma } = await import("../src/config/db.js");
const {
  ensureDailyProblem,
  getDailyProblemHistory,
  COOLDOWN_DAYS,
} = await import("../src/services/dailyProblemService.js");
const { getISTDateString, addDaysToISTDate } = await import("../src/services/streakService.js");
const { signToken } = await import("../src/utils/jwt.js");
const { default: app } = await import("../src/app.js");

const TEST_DATE_PREFIX = "2099-";
const runId = randomUUID();
const users = [];
let server;
let baseUrl;
let eligibleIds;

before(async () => {
  server = app.listen(0);
  baseUrl = `http://localhost:${server.address().port}`;

  const eligible = await prisma.problem.findMany({ where: { testcases: { some: {} } }, select: { id: true } });
  eligibleIds = new Set(eligible.map((p) => p.id));
  assert.ok(eligibleIds.size >= 2, "need at least 2 problems with testcases");

  for (const n of [1, 2]) {
    users.push(await prisma.user.create({
      data: {
        id: `usr_daily_${n}_${runId}`,
        email: `daily-${n}-${runId}@calibr8.test`,
        passwordHash: "test-hash-not-for-login",
        name: `Daily Tester ${n}`,
        streak: 4,
        longestStreak: 9,
      },
    }));
  }
  await prisma.dailyProblem.deleteMany({ where: { istDate: { startsWith: TEST_DATE_PREFIX } } });
});

after(async () => {
  await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } }).catch(() => {});
  await prisma.dailyProblem.deleteMany({ where: { istDate: { startsWith: TEST_DATE_PREFIX } } }).catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect().catch(() => {});
});

test("concurrent ensure calls converge on one row", async () => {
  const date = "2099-01-01";
  const results = await Promise.all(Array.from({ length: 10 }, () => ensureDailyProblem(date)));
  assert.equal(new Set(results.map((r) => r.id)).size, 1);
  assert.equal(await prisma.dailyProblem.count({ where: { istDate: date } }), 1);
  assert.ok(eligibleIds.has(results[0].problemId), "picked problem has testcases");
  assert.equal(results[0].problem.id, results[0].problemId);
});

test("an assigned day never changes", async () => {
  const first = await ensureDailyProblem("2099-01-01");
  const again = await ensureDailyProblem("2099-01-01");
  assert.equal(again.id, first.id);
  assert.equal(again.problemId, first.problemId);
});

test("invalid dates are rejected", async () => {
  await assert.rejects(ensureDailyProblem("2099-13-01"), { code: "INVALID_IST_DATE" });
  await assert.rejects(ensureDailyProblem("tomorrow"), { code: "INVALID_IST_DATE" });
});

test("consecutive days respect the cooldown", async () => {
  const window = Math.min(COOLDOWN_DAYS, eligibleIds.size - 1);
  const picks = [];
  for (let d = 1; d <= 20; d++) {
    const row = await ensureDailyProblem(`2099-02-${String(d).padStart(2, "0")}`);
    assert.ok(eligibleIds.has(row.problemId));
    picks.push(row.problemId);
  }
  for (let i = 0; i < picks.length; i++) {
    for (let back = 1; back <= window && i - back >= 0; back++) {
      assert.notEqual(picks[i], picks[i - back], `day ${i + 1} repeats day ${i + 1 - back}`);
    }
  }
});

test("history stops at today and reports the user's completions", async () => {
  const now = new Date("2099-02-10T12:00:00+05:30");
  const day = await ensureDailyProblem("2099-02-09");
  await prisma.dailyProblemCompletion.create({ data: { userId: users[0].id, dailyProblemId: day.id } });

  const page = await getDailyProblemHistory({ userId: users[0].id, limit: 5, now });
  assert.deepEqual(page.history.map((h) => h.istDate), ["2099-02-10", "2099-02-09", "2099-02-08", "2099-02-07", "2099-02-06"]);
  assert.equal(page.history[1].completed, true);
  assert.ok(page.history[1].completedAt instanceof Date);
  assert.equal(page.history[0].completed, false);
  assert.equal(page.limit, 5);
  assert.ok(page.total >= 10);

  const anonymous = await getDailyProblemHistory({ limit: 5, now });
  assert.equal(anonymous.history[1].completed, false);

  const clamped = await getDailyProblemHistory({ page: "-3", limit: "1000", now });
  assert.equal(clamped.page, 1);
  assert.equal(clamped.limit, 100);
});

test("GET /api/daily-problem: same problem for everyone, with caller status", async () => {
  const today = getISTDateString();
  const [anon, user1, user2] = await Promise.all([
    fetch(`${baseUrl}/api/daily-problem`),
    fetch(`${baseUrl}/api/daily-problem`, { headers: { Authorization: `Bearer ${signToken(users[0])}` } }),
    fetch(`${baseUrl}/api/daily-problem`, { headers: { Authorization: `Bearer ${signToken(users[1])}` } }),
  ]);
  for (const res of [anon, user1, user2]) assert.equal(res.status, 200);
  const [a, b, c] = await Promise.all([anon.json(), user1.json(), user2.json()]);

  assert.equal(a.success, true);
  assert.equal(a.istDate, today);
  assert.ok(a.problem.slug && a.problem.title && a.problem.difficulty);
  assert.equal(b.problem.id, a.problem.id);
  assert.equal(c.problem.id, a.problem.id);
  assert.deepEqual(a.reward, { coins: 2, streak: 1 });

  assert.equal(a.completed, false);
  assert.equal(a.streak, 0);
  assert.equal(b.completed, false);
  assert.equal(b.streak, 4);
  assert.equal(b.longestStreak, 9);

  const refreshAt = new Date(a.nextRefreshAt);
  assert.equal(getISTDateString(refreshAt), addDaysToISTDate(today, 1));
  assert.equal(getISTDateString(new Date(refreshAt.getTime() - 1)), today);
  assert.ok(a.nextRefreshMs > 0 && a.nextRefreshMs <= 86_400_000);
});

test("GET /api/daily-problem/history never shows future days", async () => {
  const res = await fetch(`${baseUrl}/api/daily-problem/history?limit=10`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  const today = getISTDateString();
  const dates = body.history.map((h) => h.istDate);
  assert.ok(dates.every((d) => d <= today), `future dates leaked: ${dates.join(",")}`);
  assert.deepEqual([...dates].sort().reverse(), dates, "newest first");
});

test("old /api/coins/daily-problem aliases are gone", async () => {
  const res = await fetch(`${baseUrl}/api/coins/daily-problem`);
  assert.equal(res.status, 404);
});
