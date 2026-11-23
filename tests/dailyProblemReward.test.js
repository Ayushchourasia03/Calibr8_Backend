// Integration tests: daily-problem completion, reward, streak and decay.
//
// Uses the database in DATABASE_URL, but only test users and daily_problems
// rows dated in 2099 (cleaned up afterwards). The decay test uses dates in
// the year 2000 so it can only match test users.
import "dotenv/config";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const { default: prisma } = await import("../src/config/db.js");
const { recordDailyProblemCompletion, resetBrokenStreaks, DAILY_PROBLEM_COINS } =
  await import("../src/services/dailyProblemService.js");

const D1 = "2099-03-01";
const D2 = "2099-03-02";
const D3 = "2099-03-03";
const D4 = "2099-03-04"; // deliberately has no daily problem
const D5 = "2099-03-05";
const at = (istDate, time = "10:00:00") => new Date(`${istDate}T${time}+05:30`);

const userIds = [];
let A;
let B;

async function createUser(data = {}) {
  const id = `usr-dpr-${randomUUID()}`;
  userIds.push(id);
  return prisma.user.create({
    data: { id, email: `${id}@calibr8.test`, name: "Daily Reward Tester", passwordHash: "x", coins: 100, ...data },
  });
}

const getUser = (id) => prisma.user.findUnique({ where: { id } });
const dailyTxs = (userId) => prisma.coinTransaction.findMany({ where: { userId, type: "DAILY_PROBLEM" } });
const complete = (userId, problemId, submittedAt, submissionId = `sub-${randomUUID()}`) =>
  recordDailyProblemCompletion({ userId, problemId, submissionId, submittedAt });

before(async () => {
  const problems = await prisma.problem.findMany({
    where: { testcases: { some: {} } },
    select: { id: true },
    take: 2,
    orderBy: { problemNumber: "asc" },
  });
  assert.equal(problems.length, 2, "need 2 problems with testcases");
  [A, B] = problems.map((p) => p.id);

  await prisma.dailyProblem.deleteMany({ where: { istDate: { startsWith: "2099-03-" } } });
  await prisma.dailyProblem.createMany({
    data: [
      { istDate: D1, problemId: A },
      { istDate: D2, problemId: B },
      { istDate: D3, problemId: A },
      { istDate: D5, problemId: B },
    ],
  });
});

after(async () => {
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  await prisma.dailyProblem.deleteMany({ where: { istDate: { startsWith: "2099-03-" } } }).catch(() => {});
  await prisma.$disconnect().catch(() => {});
});

test("first accepted solve grants coins, streak and one audit row", async () => {
  const user = await createUser();
  const r = await complete(user.id, A, at(D1), "sub-first");
  assert.deepEqual(r, { granted: true, coins: DAILY_PROBLEM_COINS, streak: 1, longestStreak: 1, balance: 102 });

  const stored = await getUser(user.id);
  assert.equal(stored.coins, 102);
  assert.equal(stored.streak, 1);
  assert.equal(stored.lastStreakDate.toISOString(), at(D1).toISOString());

  const txs = await dailyTxs(user.id);
  assert.equal(txs.length, 1);
  assert.equal(txs[0].istDate, D1);
  assert.equal(txs[0].amount, 2);
  assert.equal(txs[0].balanceAfter, 102);
  assert.equal(txs[0].referenceId, "sub-first");

  // Same day again: nothing more.
  const again = await complete(user.id, A, at(D1, "18:00:00"));
  assert.deepEqual(again, { granted: false, coins: 0, reason: "ALREADY_COMPLETED" });
  assert.equal((await getUser(user.id)).coins, 102);
  assert.equal((await dailyTxs(user.id)).length, 1);
});

test("other problems, days without a row and bad input earn nothing", async () => {
  const user = await createUser();
  assert.equal((await complete(user.id, B, at(D1))).reason, "NOT_DAILY_PROBLEM");
  assert.equal((await complete(user.id, A, at(D4))).reason, "NO_DAILY_PROBLEM");
  assert.equal((await complete(user.id, null, at(D1))).reason, "MISSING_ARGS");
  assert.equal((await complete(`usr-missing-${randomUUID()}`, A, at(D1))).reason, "USER_NOT_FOUND");
  assert.equal((await getUser(user.id)).coins, 100);
  assert.equal(await prisma.dailyProblemCompletion.count({ where: { userId: user.id } }), 0);
});

test("consecutive days extend the streak, a missed day resets it", async () => {
  const user = await createUser();
  assert.equal((await complete(user.id, A, at(D1))).streak, 1);
  assert.equal((await complete(user.id, B, at(D2))).streak, 2);
  const afterGap = await complete(user.id, B, at(D5)); // D3, D4 missed
  assert.equal(afterGap.streak, 1);
  assert.equal(afterGap.longestStreak, 2);
  const stored = await getUser(user.id);
  assert.equal(stored.coins, 106);
  assert.equal(stored.longestStreak, 2);
});

test("a submission made before midnight counts for that day", async () => {
  const user = await createUser({ streak: 5, longestStreak: 5, lastStreakDate: at("2099-02-28", "20:00:00") });
  const r = await complete(user.id, A, at(D1, "23:59:59"));
  assert.equal(r.granted, true);
  assert.equal(r.streak, 6);
  const [tx] = await dailyTxs(user.id);
  assert.equal(tx.istDate, D1);
  // The next day's solve still continues the streak.
  assert.equal((await complete(user.id, B, at(D2, "00:00:30"))).streak, 7);
});

test("a late-judged earlier day pays coins but never moves the streak back", async () => {
  const user = await createUser();
  assert.equal((await complete(user.id, B, at(D2))).streak, 1);
  const late = await complete(user.id, A, at(D1, "23:59:00"));
  assert.equal(late.granted, true);
  assert.equal(late.streak, 1);
  const stored = await getUser(user.id);
  assert.equal(stored.lastStreakDate.toISOString(), at(D2).toISOString());
  assert.equal(stored.coins, 104);
  assert.equal((await complete(user.id, A, at(D3))).streak, 2);
});

test("parallel submissions are rewarded exactly once", async () => {
  const user = await createUser();
  const results = await Promise.all(Array.from({ length: 6 }, () => complete(user.id, A, at(D1))));
  assert.equal(results.filter((r) => r.granted).length, 1, JSON.stringify(results));
  assert.ok(results.filter((r) => !r.granted).every((r) => r.reason === "ALREADY_COMPLETED"));
  assert.equal((await getUser(user.id)).coins, 102);
  assert.equal((await dailyTxs(user.id)).length, 1);
  assert.equal(await prisma.dailyProblemCompletion.count({ where: { userId: user.id } }), 1);
});

test("the database refuses a second reward for the same day", async () => {
  // A reward row without a completion row (as old test runs left behind).
  const user = await createUser();
  await prisma.coinTransaction.create({
    data: { userId: user.id, amount: 2, type: "DAILY_PROBLEM", istDate: D1, balanceAfter: 102, referenceId: "orphan" },
  });
  const r = await complete(user.id, A, at(D1));
  assert.deepEqual(r, { granted: false, coins: 0, reason: "ALREADY_COMPLETED" });
  assert.equal((await getUser(user.id)).coins, 100, "coin increment rolled back");
  assert.equal(await prisma.dailyProblemCompletion.count({ where: { userId: user.id } }), 0, "completion rolled back");
});

test("decay resets streaks older than yesterday and keeps the rest", async () => {
  const now = new Date("2000-01-03T12:00:00+05:30"); // yesterday = 2000-01-02
  const broken = await createUser({ streak: 4, longestStreak: 4, lastStreakDate: new Date("2000-01-01T23:59:00+05:30") });
  const alive = await createUser({ streak: 2, longestStreak: 3, lastStreakDate: new Date("2000-01-02T00:00:30+05:30") });

  assert.ok((await resetBrokenStreaks(now)) >= 1);
  const b = await getUser(broken.id);
  assert.equal(b.streak, 0);
  assert.equal(b.longestStreak, 4, "longest streak is kept");
  assert.equal((await getUser(alive.id)).streak, 2);
});
