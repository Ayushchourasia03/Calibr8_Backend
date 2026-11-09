import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "";
process.env.JWT_SECRET = "test-jwt-secret-key-that-is-at-least-32-chars-long";

const { default: app } = await import("../src/app.js");
const { default: prisma } = await import("../src/config/db.js");
const { getBalance, getCoinHistory } = await import(
  "../src/services/coinService.js"
);

const server = app.listen(0);
const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

try {
  console.log("=== Running Coin Service, Balance & History Test Suite ===");

  // 1. Setup user
  const email = `coin-audit-${randomUUID()}@example.com`;
  const regRes = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Frank Coinmaster",
      email,
      password: "FrankPassword123",
    }),
  });
  const regData = await regRes.json();
  const token = regData.token;
  const authHeaders = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // 2. GET /api/coins/balance
  const balanceRes = await fetch(`${baseUrl}/coins/balance`, {
    headers: authHeaders,
  });
  assert.equal(balanceRes.status, 200);
  const balanceData = await balanceRes.json();
  assert.equal(balanceData.success, true);
  assert.equal(balanceData.coins, 100);
  assert.equal(balanceData.streak, 0);
  assert.equal(balanceData.longestStreak, 0);

  // 3. Service direct call getBalance for non-existent user returns default structure
  const fallbackBal = await getBalance("non-existent-user-id");
  assert.equal(fallbackBal.coins, 100);
  assert.equal(fallbackBal.streak, 0);
  assert.equal(fallbackBal.longestStreak, 0);

  // 4. Record multiple coin transactions for the user
  const todayIST = "2026-11-09";
  for (let i = 1; i <= 5; i++) {
    await prisma.coinTransaction.create({
      data: {
        userId: regData.user.id,
        amount: 2,
        type: "DAILY_PROBLEM",
        referenceId: `test-ref-${i}`,
        istDate: todayIST,
        balanceAfter: 100 + i * 2,
      },
    });
  }

  // 5. GET /api/coins/history
  const historyRes = await fetch(`${baseUrl}/coins/history`, {
    headers: authHeaders,
  });
  assert.equal(historyRes.status, 200);
  const historyData = await historyRes.json();
  assert.equal(historyData.success, true);
  assert.ok(Array.isArray(historyData.transactions));
  assert.equal(historyData.transactions.length, 5);

  // 5b. History pagination (?limit=2&offset=1)
  const paginatedRes = await fetch(
    `${baseUrl}/coins/history?limit=2&offset=1`,
    {
      headers: authHeaders,
    },
  );
  assert.equal(paginatedRes.status, 200);
  const paginatedData = await paginatedRes.json();
  assert.equal(paginatedData.transactions.length, 2);

  // 6. Direct service getCoinHistory with limit and offset boundaries
  const serviceHist = await getCoinHistory(regData.user.id, {
    limit: 100, // should clamp to max 50
    offset: -5,  // should clamp to 0
  });
  assert.ok(Array.isArray(serviceHist.transactions));

  // 7. Unauthenticated requests rejected with 401
  assert.equal((await fetch(`${baseUrl}/coins/balance`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/coins/history`)).status, 401);

  console.log("✔ Coin Service, Balance & History tests passed successfully!");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
