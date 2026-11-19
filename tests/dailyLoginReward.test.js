import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getISTDateString, getYesterdayIST } from "../src/services/streakService.js";

const { default: app } = await import("../src/app.js");
const { default: prisma } = await import("../src/config/db.js");
const { grantDailyLoginReward } = await import("../src/services/coinService.js");

const server = app.listen(0);
const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

console.log("Running Daily Login Reward Integration Tests (I0 - I12)...");

const createdUserIds = [];
const todayIST = getISTDateString();
const yesterdayIST = getYesterdayIST(todayIST);

async function registerUser(customEmail = null) {
  const email = customEmail || `login-test-${randomUUID()}@example.test`;
  const password = "StrongPassword123";
  const res = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Login Reward Tester",
      email,
      password,
    }),
  });
  const data = await res.json();
  assert.equal(res.status, 201, "Registration should succeed");
  if (data.user?.id) createdUserIds.push(data.user.id);
  return { ...data, rawPassword: password };
}

/** Simulate that the user's last reward happened on `istDate` (default: yesterday). */
async function moveLastLoginTo(userId, istDate = yesterdayIST, extra = {}) {
  await prisma.coinTransaction.updateMany({
    where: { userId, type: "DAILY_LOGIN", istDate: todayIST },
    data: { istDate, referenceId: istDate },
  });
  await prisma.user.update({
    where: { id: userId },
    data: { lastLoginISTDate: istDate, ...extra },
  });
}

function login(user, password = user.rawPassword) {
  return fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: user.user.email, password }),
  });
}

async function dailyLoginTxCount(userId) {
  return prisma.coinTransaction.count({ where: { userId, type: "DAILY_LOGIN" } });
}

try {
  // I0: Registration day counts as the first daily login
  const user0 = await registerUser();
  assert.equal(user0.rewards.loginCoins, 1, "Registration grants the day's login coin");
  assert.equal(user0.rewards.isNewDay, true);
  assert.equal(user0.user.coins, 101, "100 starting + 1 login coin");
  assert.equal(user0.stats.coins, 101);
  const tx0 = await prisma.coinTransaction.findMany({
    where: { userId: user0.user.id, type: "DAILY_LOGIN" },
  });
  assert.equal(tx0.length, 1);
  assert.equal(tx0[0].istDate, todayIST);
  assert.equal(tx0[0].balanceAfter, 101);
  console.log("✔ I0: Registration grants +1 login coin, audited");

  // I1: First login of a new day grants +1 coin, streak unchanged
  const user1 = await registerUser();
  await moveLastLoginTo(user1.user.id);
  const loginRes1 = await login(user1);
  const loginData1 = await loginRes1.json();
  assert.equal(loginRes1.status, 200);
  assert.equal(loginData1.rewards.coinsEarnedToday, 1, "First login of the day should grant +1 coin");
  assert.equal(loginData1.rewards.loginCoins, 1);
  assert.equal(loginData1.rewards.streak, 0, "Login does not mutate Daily Problem streak");
  assert.equal(loginData1.user.coins, 102, "101 + 1");
  assert.equal(loginData1.stats.coins, 102);
  const tx1 = await prisma.coinTransaction.findMany({
    where: { userId: user1.user.id, type: "DAILY_LOGIN", istDate: todayIST },
  });
  assert.equal(tx1.length, 1);
  assert.equal(tx1[0].balanceAfter, 102);
  console.log("✔ I1: First login of the day grants +1 coin, streak unchanged, transaction audited");

  // I2: Same day second login grants 0 coins
  const loginRes2 = await login(user1);
  const loginData2 = await loginRes2.json();
  assert.equal(loginRes2.status, 200);
  assert.equal(loginData2.rewards.coinsEarnedToday, 0);
  assert.equal(loginData2.rewards.isNewDay, false);
  assert.equal(loginData2.user.coins, 102, "Coins must remain unchanged");
  assert.equal(await dailyLoginTxCount(user1.user.id), 2, "One per day (yesterday + today)");
  console.log("✔ I2: Same day second login grants 0 extra coins, idempotent");

  // I3: Login after registration on the same day grants 0
  const user3 = await registerUser();
  const loginData3 = await (await login(user3)).json();
  assert.equal(loginData3.rewards.loginCoins, 0, "Already rewarded at registration");
  assert.equal(loginData3.user.coins, 101);
  console.log("✔ I3: Same-day login after registration grants 0");

  // I4: Next day login preserves Daily Problem streak
  const user4 = await registerUser();
  await moveLastLoginTo(user4.user.id, yesterdayIST, {
    coins: 106,
    streak: 6,
    longestStreak: 6,
    lastStreakDate: new Date(Date.now() - 86400000),
  });
  const loginData4 = await (await login(user4)).json();
  assert.equal(loginData4.rewards.streak, 6);
  assert.equal(loginData4.rewards.loginCoins, 1);
  assert.equal(loginData4.user.coins, 107);
  console.log("✔ I4: Next day login grants +1 coin, preserves Daily Problem streak");

  // I5: Missed days preserve coins and longestStreak
  const user5 = await registerUser();
  await moveLastLoginTo(user5.user.id, "2026-11-01", {
    coins: 105,
    streak: 5,
    longestStreak: 5,
    lastStreakDate: new Date("2026-11-01T10:00:00Z"),
  });
  const loginData5 = await (await login(user5)).json();
  assert.equal(loginData5.rewards.coinsEarnedToday, 1);
  assert.equal(loginData5.user.longestStreak, 5);
  assert.equal(loginData5.user.coins, 106);
  console.log("✔ I5: Missed day login grants +1 coin, preserves longestStreak and balance");

  // I6: Concurrent logins grant exactly once
  const user6 = await registerUser();
  await moveLastLoginTo(user6.user.id);
  const concurrentCalls = await Promise.all([login(user6), login(user6), login(user6)]);
  const concurrentBodies = await Promise.all(concurrentCalls.map((r) => r.json()));
  concurrentCalls.forEach((r) => assert.equal(r.status, 200));
  const totalGranted = concurrentBodies.reduce((s, b) => s + (b.rewards?.coinsEarnedToday || 0), 0);
  assert.equal(totalGranted, 1, "Only one +1 across parallel logins");
  const storedUser6 = await prisma.user.findUnique({ where: { id: user6.user.id } });
  assert.equal(storedUser6.coins, 102);
  console.log("✔ I6: Parallel logins safely grant coins exactly once");

  // I7: Login failure does not grant
  const user7 = await registerUser();
  await moveLastLoginTo(user7.user.id);
  const failRes = await login(user7, "WrongPassword123");
  assert.equal(failRes.status, 401);
  const storedUser7 = await prisma.user.findUnique({ where: { id: user7.user.id } });
  assert.equal(storedUser7.coins, 101);
  assert.equal(storedUser7.lastLoginISTDate, yesterdayIST);
  console.log("✔ I7: Invalid credentials never grant coins");

  // I8: Token refresh on a new day grants the daily coin (stay-signed-in users)
  const user8 = await registerUser();
  await moveLastLoginTo(user8.user.id);
  const refreshRes = await fetch(`${baseUrl}/auth/refresh`, {
    method: "POST",
    headers: { Authorization: `Bearer ${user8.token}`, "Content-Type": "application/json" },
  });
  const refreshData = await refreshRes.json();
  assert.equal(refreshRes.status, 200);
  assert.equal(refreshData.rewards.loginCoins, 1);
  assert.equal(refreshData.user.coins, 102);
  console.log("✔ I8: Refresh on a new day grants +1 coin");

  // I9: Second refresh same day grants nothing
  const refreshRes9 = await fetch(`${baseUrl}/auth/refresh`, {
    method: "POST",
    headers: { Authorization: `Bearer ${refreshData.token}`, "Content-Type": "application/json" },
  });
  const refreshData9 = await refreshRes9.json();
  assert.equal(refreshRes9.status, 200);
  assert.equal(refreshData9.rewards.loginCoins, 0);
  assert.equal(refreshData9.user.coins, 102);
  console.log("✔ I9: Same-day refresh grants 0");

  // I10: GET /auth/me on a new day grants the daily coin; repeat grants nothing
  const user10 = await registerUser();
  await moveLastLoginTo(user10.user.id);
  const meHeaders = { Authorization: `Bearer ${user10.token}` };
  const meData1 = await (await fetch(`${baseUrl}/auth/me`, { headers: meHeaders })).json();
  assert.equal(meData1.user.loginCoins, 1);
  assert.equal(meData1.user.coins, 102);
  assert.equal(meData1.user.todayISTDate, todayIST);
  assert.equal(meData1.user.coinsEarnedToday, 1);
  const meData2 = await (await fetch(`${baseUrl}/auth/me`, { headers: meHeaders })).json();
  assert.equal(meData2.user.loginCoins, 0);
  assert.equal(meData2.user.coins, 102);
  assert.equal(await dailyLoginTxCount(user10.user.id), 2);
  console.log("✔ I10: GET /auth/me grants once per day");

  // I11: Mixed concurrent entry points (login + refresh + me) grant exactly once
  const user11 = await registerUser();
  await moveLastLoginTo(user11.user.id);
  const h11 = { Authorization: `Bearer ${user11.token}` };
  await Promise.all([
    login(user11),
    fetch(`${baseUrl}/auth/me`, { headers: h11 }),
    fetch(`${baseUrl}/auth/me`, { headers: h11 }),
  ]);
  const storedUser11 = await prisma.user.findUnique({ where: { id: user11.user.id } });
  assert.equal(storedUser11.coins, 102);
  assert.equal(
    await prisma.coinTransaction.count({
      where: { userId: user11.user.id, type: "DAILY_LOGIN", istDate: todayIST },
    }),
    1,
  );
  console.log("✔ I11: Concurrent login/me grant exactly once");

  // I12: Fallback is safe
  const fallback = await grantDailyLoginReward(null);
  assert.equal(fallback.coinsEarnedToday, 0);
  assert.equal(fallback.isNewDay, false);
  assert.equal(fallback.coins, null, "Fallback never reports a fake balance");
  console.log("✔ I12: Reward errors fail safely");

  console.log("ALL DAILY LOGIN REWARD INTEGRATION TESTS PASSED! 🎉");
} finally {
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
  }
  await prisma.$disconnect().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}
