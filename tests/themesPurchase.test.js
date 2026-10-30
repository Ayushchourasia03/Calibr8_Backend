import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/calibr8_themes_test";

const { default: app } = await import("../src/app.js");
const { default: prisma } = await import("../src/config/db.js");
const server = app.listen(0);
const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

async function registerAndGetToken() {
  const response = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Theme Purchase Test",
      email: `theme-${randomUUID()}@example.test`,
      password: "theme-purchase-test-password",
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  return body;
}

try {
  const account = await registerAndGetToken();
  const headers = {
    Authorization: `Bearer ${account.token}`,
    "Content-Type": "application/json",
  };
  await prisma.user.update({
    where: { id: account.user.id },
    data: { coins: 1000 },
  });

  const purchaseResponse = await fetch(`${baseUrl}/themes/orbit/buy`, {
    method: "POST",
    headers,
  });
  const purchase = await purchaseResponse.json();
  assert.equal(purchaseResponse.status, 200);
  assert.equal(purchase.success, true);
  assert.equal(purchase.coins, 550);
  assert.equal(purchase.stats.coins, 550);

  const ownedTheme = await prisma.userTheme.findFirst({
    where: { userId: account.user.id, themeId: "thm-orbit" },
  });
  assert.ok(ownedTheme, "theme purchase should be persisted");

  const storedUser = await prisma.user.findUnique({
    where: { id: account.user.id },
  });
  assert.equal(storedUser.coins, 550);
  assert.equal(storedUser.activeThemeId, "thm-orbit");

  const themesResponse = await fetch(`${baseUrl}/themes`, { headers });
  const themes = await themesResponse.json();
  assert.equal(themesResponse.status, 200);
  assert.equal(
    themes.themes.find((theme) => theme.slug === "orbit").owned,
    true,
  );
  assert.equal(
    themes.themes.find((theme) => theme.slug === "orbit").applied,
    true,
  );

  const duplicateResponse = await fetch(`${baseUrl}/themes/orbit/buy`, {
    method: "POST",
    headers,
  });
  const duplicate = await duplicateResponse.json();
  assert.equal(duplicateResponse.status, 400);
  assert.equal(duplicate.code, "ALREADY_OWNED");
  assert.equal(
    (await prisma.user.findUnique({ where: { id: account.user.id } })).coins,
    550,
  );

  const lowBalanceAccount = await registerAndGetToken();
  const lowBalanceHeaders = {
    Authorization: `Bearer ${lowBalanceAccount.token}`,
    "Content-Type": "application/json",
  };
  const rejectedResponse = await fetch(`${baseUrl}/themes/arcade/buy`, {
    method: "POST",
    headers: lowBalanceHeaders,
  });
  const rejected = await rejectedResponse.json();
  assert.equal(rejectedResponse.status, 400);
  assert.equal(rejected.code, "INSUFFICIENT_COINS");
  assert.equal(
    await prisma.userTheme.findFirst({
      where: { userId: lowBalanceAccount.user.id, themeId: "thm-arcade" },
    }),
    null,
  );
  assert.equal(
    (await prisma.user.findUnique({
      where: { id: lowBalanceAccount.user.id },
    })).coins,
    100,
  );

  console.log("Theme purchase persistence tests passed.");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
