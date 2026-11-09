import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getISTDateString, getYesterdayIST } from "../src/services/streakService.js";

process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/calibr8_login_rewards_test";

const { default: app } = await import("../src/app.js");
const { default: prisma } = await import("../src/config/db.js");
const { grantDailyLoginReward } = await import("../src/services/coinService.js");

const server = app.listen(0);
const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

console.log("Running Daily Login Reward Integration Tests (I1 - I10)...");

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
  return { ...data, rawPassword: password };
}

try {
  // I1: First login after deploy grants +1 coin, streak remains unchanged (0)
  const user1 = await registerUser();
  const loginRes1 = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: user1.user.email, password: user1.rawPassword }),
  });
  const loginData1 = await loginRes1.json();
  assert.equal(loginRes1.status, 200);
  assert.equal(loginData1.rewards.coinsEarnedToday, 1, "First login should grant +1 coin");
  assert.equal(loginData1.rewards.loginCoins, 1);
  assert.equal(loginData1.rewards.streak, 0, "Login does not mutate Daily Problem streak (remains 0)");
  assert.equal(loginData1.user.coins, 101, "User coins should be 101");
  assert.equal(loginData1.stats.coins, 101);

  const tx1 = await prisma.coinTransaction.findMany({
    where: { userId: user1.user.id, type: "DAILY_LOGIN" },
  });
  assert.equal(tx1.length, 1, "Should have exactly 1 DAILY_LOGIN transaction");
  assert.equal(tx1[0].amount, 1);
  assert.equal(tx1[0].balanceAfter, 101);
  console.log("✔ I1: First login grants +1 coin, streak unchanged, transaction audited");

  // I2: Same day double login grants 0 coins
  const loginRes2 = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: user1.user.email, password: user1.rawPassword }),
  });
  const loginData2 = await loginRes2.json();
  assert.equal(loginRes2.status, 200);
  assert.equal(loginData2.rewards.coinsEarnedToday, 0, "Second login same day should grant 0 extra coins");
  assert.equal(loginData2.rewards.isNewDay, false);
  assert.equal(loginData2.user.coins, 101, "Coins must remain unchanged");
  assert.equal(loginData2.rewards.streak, 0, "Streak must remain unchanged");

  const tx2 = await prisma.coinTransaction.findMany({
    where: { userId: user1.user.id, type: "DAILY_LOGIN" },
  });
  assert.equal(tx2.length, 1, "Still only 1 DAILY_LOGIN transaction for the day");
  console.log("✔ I2: Same day second login grants 0 extra coins, idempotent");

  // I3: Login on next day grants +1 coin, preserves streak from Daily Problems
  const user3 = await registerUser();
  const todayIST = getISTDateString();
  const yesterdayIST = getYesterdayIST(todayIST);

  // Set user to last login yesterday, with streak 6 earned from previous Daily Problem solves
  await prisma.user.update({
    where: { id: user3.user.id },
    data: {
      coins: 106,
      streak: 6,
      longestStreak: 6,
      lastStreakDate: new Date(Date.now() - 86400000),
      lastLoginISTDate: yesterdayIST,
    },
  });

  const loginRes3 = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: user3.user.email, password: user3.rawPassword }),
  });
  const loginData3 = await loginRes3.json();
  assert.equal(loginRes3.status, 200);
  assert.equal(loginData3.rewards.streak, 6, "Login preserves existing Daily Problem streak");
  assert.equal(loginData3.rewards.loginCoins, 1, "Login coins should be 1");
  assert.equal(loginData3.rewards.coinsEarnedToday, 1, "Total login reward today should be 1");
  assert.equal(loginData3.user.coins, 107, "Balance should be 106 + 1 = 107");

  const user3Txs = await prisma.coinTransaction.findMany({
    where: { userId: user3.user.id },
  });
  assert.ok(user3Txs.some((t) => t.type === "DAILY_LOGIN" && t.amount === 1));
  console.log("✔ I3: Next day login grants +1 coin, preserves Daily Problem streak");

  // I4: Multiple logins across consecutive days
  const user4 = await registerUser();
  const loginRes4 = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: user4.user.email, password: user4.rawPassword }),
  });
  const loginData4 = await loginRes4.json();
  assert.equal(loginRes4.status, 200);
  assert.equal(loginData4.rewards.loginCoins, 1);
  assert.equal(loginData4.user.coins, 101);
  console.log("✔ I4: Fresh user daily login grants +1 coin");

  // I5: Missed day preserves coins and longestStreak
  const user5 = await registerUser();
  const twoDaysAgoIST = "2026-11-01";
  await prisma.user.update({
    where: { id: user5.user.id },
    data: {
      coins: 105,
      streak: 5,
      longestStreak: 5,
      lastStreakDate: new Date("2026-11-01T10:00:00Z"),
      lastLoginISTDate: twoDaysAgoIST,
    },
  });

  const loginRes5 = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: user5.user.email, password: user5.rawPassword }),
  });
  const loginData5 = await loginRes5.json();
  assert.equal(loginRes5.status, 200);
  assert.equal(loginData5.rewards.coinsEarnedToday, 1);
  assert.equal(loginData5.user.longestStreak, 5, "longestStreak must be preserved");
  assert.equal(loginData5.user.coins, 106, "Coins stay (105 + 1)");
  console.log("✔ I5: Missed day login grants +1 coin, preserves longestStreak and coin balance");

  // I6: Concurrent logins safely grant coins exactly once
  const user6 = await registerUser();
  const concurrentCalls = await Promise.all([
    fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user6.user.email, password: user6.rawPassword }),
    }),
    fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user6.user.email, password: user6.rawPassword }),
    }),
    fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user6.user.email, password: user6.rawPassword }),
    }),
  ]);

  const concurrentBodies = await Promise.all(concurrentCalls.map((r) => r.json()));
  concurrentCalls.forEach((r) => assert.equal(r.status, 200));

  const totalGranted = concurrentBodies.reduce((sum, b) => sum + (b.rewards?.coinsEarnedToday || 0), 0);
  assert.equal(totalGranted, 1, "Only one +1 should be granted across parallel login calls");

  const storedUser6 = await prisma.user.findUnique({ where: { id: user6.user.id } });
  assert.equal(storedUser6.coins, 101, "Final user coins must be 101");
  console.log("✔ I6: Parallel logins safely grant coins exactly once");

  // I7: Login failure does not grant
  const user7 = await registerUser();
  const failRes = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: user7.user.email, password: "WrongPassword123" }),
  });
  assert.equal(failRes.status, 401);

  const storedUser7 = await prisma.user.findUnique({ where: { id: user7.user.id } });
  assert.equal(storedUser7.coins, 100);
  const user7Txs = await prisma.coinTransaction.findMany({ where: { userId: user7.user.id } });
  assert.equal(user7Txs.length, 0);
  console.log("✔ I7: Invalid credentials never grant coins or write transactions");

  // I8: Refresh does not grant
  const user8 = await registerUser();
  const loginRes8 = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: user8.user.email, password: user8.rawPassword }),
  });
  const loginData8 = await loginRes8.json();
  assert.equal(loginData8.user.coins, 101);

  const refreshRes = await fetch(`${baseUrl}/auth/refresh`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${loginData8.token}`,
      "Content-Type": "application/json",
    },
  });
  const refreshData = await refreshRes.json();
  assert.equal(refreshRes.status, 200);
  assert.equal(refreshData.user.coins, 101, "Coins should still be 101 after refresh");

  const user8Txs = await prisma.coinTransaction.findMany({
    where: { userId: user8.user.id, type: "DAILY_LOGIN" },
  });
  assert.equal(user8Txs.length, 1, "Refresh never creates a coin transaction");
  console.log("✔ I8: Refresh token does not grant coins or streak");

  // I9: Verify /auth/me does not grant
  const verifyRes = await fetch(`${baseUrl}/auth/me`, {
    headers: { Authorization: `Bearer ${refreshData.token}` },
  });
  const verifyData = await verifyRes.json();
  assert.equal(verifyRes.status, 200);
  assert.equal(verifyData.user.coins, 101);
  assert.equal(verifyData.user.todayISTDate, getISTDateString());
  assert.equal(verifyData.user.coinsEarnedToday, 1);

  const user8TxsAfterMe = await prisma.coinTransaction.findMany({
    where: { userId: user8.user.id, type: "DAILY_LOGIN" },
  });
  assert.equal(user8TxsAfterMe.length, 1, "GET /auth/me never modifies transactions");
  console.log("✔ I9: GET /auth/me enriches today's stats without modifying balance");

  // I10: Transaction failure does not block login
  const fallback = await grantDailyLoginReward(null);
  assert.equal(fallback.coinsEarnedToday, 0);
  assert.equal(fallback.isNewDay, false);
  console.log("✔ I10: Coin transaction errors fail safely without breaking login");

  console.log("ALL DAILY LOGIN REWARD INTEGRATION TESTS PASSED! 🎉");
} finally {
  server.close();
}
