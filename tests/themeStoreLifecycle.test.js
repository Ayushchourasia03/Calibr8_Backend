import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "";
process.env.JWT_SECRET = "test-jwt-secret-key-that-is-at-least-32-chars-long";

const { default: app } = await import("../src/app.js");
const { default: prisma } = await import("../src/config/db.js");

const server = app.listen(0);
const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

try {
  console.log("=== Running Theme Store Lifecycle Test Suite ===");

  // 1. Setup user with initial coins
  const email = `theme-user-${randomUUID()}@example.com`;
  const regRes = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Theodore Skinner",
      email,
      password: "TheodorePassword123",
    }),
  });
  const regData = await regRes.json();
  const token = regData.token;
  const authHeaders = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // 2. GET /api/themes/me (default active theme)
  const myThemeRes = await fetch(`${baseUrl}/themes/me`, {
    headers: authHeaders,
  });
  assert.equal(myThemeRes.status, 200);
  const myThemeData = await myThemeRes.json();
  assert.equal(myThemeData.success, true);
  assert.equal(myThemeData.activeTheme, "default");
  assert.equal(myThemeData.coins, 100);

  // 3. GET /api/themes (themes list with ownership & pricing)
  const listRes = await fetch(`${baseUrl}/themes`, { headers: authHeaders });
  assert.equal(listRes.status, 200);
  const listData = await listRes.json();
  assert.equal(listData.success, true);
  assert.ok(Array.isArray(listData.themes));
  assert.ok(listData.themes.length > 0);

  const defaultTheme = listData.themes.find((t) => t.isDefault);
  assert.ok(defaultTheme);
  assert.equal(defaultTheme.owned, true);
  assert.equal(defaultTheme.applied, true);

  // 4. PUT /api/themes/apply errors
  // 4a. Missing slug -> 400
  const missSlugRes = await fetch(`${baseUrl}/themes/apply`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({}),
  });
  assert.equal(missSlugRes.status, 400);

  // 4b. Unknown slug -> 404
  const unknownApplyRes = await fetch(`${baseUrl}/themes/apply`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({ slug: "non-existent-theme-xyz" }),
  });
  assert.equal(unknownApplyRes.status, 404);

  // 4c. Applying unowned non-default theme -> 403
  const unownedTheme = listData.themes.find((t) => !t.isDefault && t.price > 0);
  assert.ok(unownedTheme);
  const unownedApplyRes = await fetch(`${baseUrl}/themes/apply`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({ slug: unownedTheme.slug }),
  });
  assert.equal(unownedApplyRes.status, 403);
  assert.equal((await unownedApplyRes.json()).code, "FORBIDDEN");

  // 5. POST /api/themes/:slug/buy
  // 5a. Unknown theme slug -> 404
  const unknownBuyRes = await fetch(
    `${baseUrl}/themes/non-existent-theme-xyz/buy`,
    {
      method: "POST",
      headers: authHeaders,
    },
  );
  assert.equal(unknownBuyRes.status, 404);

  // 5b. Insufficient coins -> 400
  const expensiveTheme = listData.themes.find((t) => t.price > 100);
  if (expensiveTheme) {
    const brokeBuyRes = await fetch(
      `${baseUrl}/themes/${expensiveTheme.slug}/buy`,
      {
        method: "POST",
        headers: authHeaders,
      },
    );
    assert.equal(brokeBuyRes.status, 400);
    assert.equal((await brokeBuyRes.json()).code, "INSUFFICIENT_COINS");
  }

  // 5c. Give user enough coins to buy the theme
  await prisma.user.update({
    where: { id: regData.user.id },
    data: { coins: 1500 },
  });

  const buyRes = await fetch(`${baseUrl}/themes/${unownedTheme.slug}/buy`, {
    method: "POST",
    headers: authHeaders,
  });
  assert.equal(buyRes.status, 200);
  const buyData = await buyRes.json();
  assert.equal(buyData.success, true);
  assert.equal(buyData.theme.owned, true);
  assert.equal(buyData.coins, 1500 - unownedTheme.price);

  // Verify CoinTransaction audit record was written
  const tx = await prisma.coinTransaction.findFirst({
    where: {
      userId: regData.user.id,
      type: "THEME_PURCHASE",
    },
  });
  assert.ok(tx);
  assert.equal(tx.amount, -unownedTheme.price);

  // 5d. Duplicate buy returns ALREADY_OWNED (400)
  const dupBuyRes = await fetch(`${baseUrl}/themes/${unownedTheme.slug}/buy`, {
    method: "POST",
    headers: authHeaders,
  });
  assert.equal(dupBuyRes.status, 400);
  assert.equal((await dupBuyRes.json()).code, "ALREADY_OWNED");

  // 6. Applying newly owned theme succeeds (200)
  const applyOwnedRes = await fetch(`${baseUrl}/themes/apply`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({ slug: unownedTheme.slug }),
  });
  assert.equal(applyOwnedRes.status, 200);
  const applyOwnedData = await applyOwnedRes.json();
  assert.equal(applyOwnedData.activeTheme, unownedTheme.slug);

  // Verify /themes/me now reflects the active theme
  const updatedMeRes = await fetch(`${baseUrl}/themes/me`, {
    headers: authHeaders,
  });
  const updatedMeData = await updatedMeRes.json();
  assert.equal(updatedMeData.activeTheme, unownedTheme.slug);
  assert.ok(updatedMeData.ownedThemes.includes(unownedTheme.slug));

  // 7. Re-applying default theme succeeds (200)
  const applyDefaultRes = await fetch(`${baseUrl}/themes/apply`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({ slug: "default" }),
  });
  assert.equal(applyDefaultRes.status, 200);

  // 8. Unauthenticated requests to theme routes return 401
  assert.equal((await fetch(`${baseUrl}/themes`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/themes/me`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/themes/orbit/buy`, { method: "POST" })).status, 401);
  assert.equal((await fetch(`${baseUrl}/themes/apply`, { method: "PUT" })).status, 401);

  console.log("✔ Theme Store Lifecycle tests passed successfully!");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
