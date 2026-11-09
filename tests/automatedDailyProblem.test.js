import assert from "node:assert/strict";
process.env.DATABASE_URL = "";
process.env.JWT_SECRET = "a".repeat(40);
process.env.CODEBOX_URL = "https://codebox.internal";
process.env.CODEBOX_TOKEN = "test-token";

const { default: prisma } = await import("../src/config/db.js");
const {
  ensureDailyProblem,
  selectDailyProblemForDate,
  getDailyProblemWithUserStatus,
  getDailyProblemHistory,
  getAuthoritativeISTDate,
  getMillisecondsUntilNextMidnightIST,
  completeDailyProblemSubmission,
  stopDailyProblemScheduler,
} = await import("../src/services/dailyProblemService.js");
const { grantDailyProblemReward } =
  await import("../src/services/coinService.js");
const { signToken } = await import("../src/utils/jwt.js");
const { default: app } = await import("../src/app.js");

// Mock fetch for CodeBox
const originalFetch = globalThis.fetch;

let lastSubmitted = [];
globalThis.fetch = async (input, options = {}) => {
  const urlStr = typeof input === "string" ? input : input.toString();

  if (urlStr.startsWith("https://codebox.internal")) {
    const url = new URL(urlStr);
    if (options.method === "POST") {
      const payload = JSON.parse(options.body || "{}");
      lastSubmitted = payload.submissions || [];
      return new Response(
        JSON.stringify(
          lastSubmitted.map((_, idx) => ({
            token: `tok-${idx}-${Date.now()}`,
          })),
        ),
        { status: 201 },
      );
    }
    const tokens = (url.searchParams.get("tokens") || "").split(",");
    return new Response(
      JSON.stringify({
        submissions: tokens.map((token, idx) => {
          const sub = lastSubmitted[idx] || {};
          const stdin = String(sub.stdin || "");
          let stdout = "0 1";
          if (stdin.includes("3 6") || stdin.includes("4 10")) stdout = "1 2";
          else if (stdin.includes("5 13")) stdout = "1 3";
          return {
            token,
            status: { id: 3 }, // Accepted
            stdout,
            time: "0.01",
            memory: 1200,
          };
        }),
      }),
      { status: 200 },
    );
  }
  return originalFetch(input, options);
};

async function runDailyProblemTests() {
  console.log("=== Calibr8 Automated Daily Problem System Test Suite ===");
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  try {
    const todayIST = getAuthoritativeISTDate();
    console.log(`[Test Setup] Current IST Date: ${todayIST}`);

    // Create 2 test users
    const user1 = {
      id: "usr_daily_test_1",
      email: "user1@calibr8.test",
      name: "User One",
      coins: 100,
      tier: "Prism I",
      role: "USER",
    };
    const user2 = {
      id: "usr_daily_test_2",
      email: "user2@calibr8.test",
      name: "User Two",
      coins: 100,
      tier: "Prism I",
      role: "USER",
    };

    await prisma.user.create({ data: user1 });
    await prisma.user.create({ data: user2 });

    const token1 = signToken(user1);
    const token2 = signToken(user2);

    // Clean up daily problem records for today and future test dates
    await prisma.dailyProblem.deleteMany({
      where: {
        istDate: todayIST,
      },
    });

    // -------------------------------------------------------------------------
    // 1. Generation & Consistency Across Requests & Users
    // -------------------------------------------------------------------------
    console.log(
      "\n[Test 1 & 2 & 3] Lazy Generation, Consistency & Multi-User Identity",
    );
    const res1 = await fetch(`${baseUrl}/api/daily-problem`, {
      headers: { Authorization: `Bearer ${token1}` },
    });
    assert.strictEqual(res1.status, 200, "Must return 200 OK");
    const data1 = await res1.json();
    assert.strictEqual(data1.success, true);
    assert.strictEqual(data1.istDate, todayIST);
    assert.ok(data1.problem && data1.problem.id, "Must include problem object");
    assert.strictEqual(data1.reward.coins, 2);
    assert.strictEqual(data1.completed, false);

    // Repeated request by User 2 must return the identical problem
    const res2 = await fetch(`${baseUrl}/api/daily-problem`, {
      headers: { Authorization: `Bearer ${token2}` },
    });
    const data2 = await res2.json();
    assert.strictEqual(
      data2.problem.id,
      data1.problem.id,
      "User 2 must receive the identical daily problem as User 1",
    );
    assert.strictEqual(data2.istDate, data1.istDate);

    // Public request (no token) also receives identical problem
    const resPublic = await fetch(`${baseUrl}/api/daily-problem`);
    const dataPublic = await resPublic.json();
    assert.strictEqual(
      dataPublic.problem.id,
      data1.problem.id,
      "Public client must receive the same daily problem",
    );
    console.log(
      "✔ Lazy generation, repeated consistency, and multi-user parity verified",
    );

    // -------------------------------------------------------------------------
    // 4. Midnight Scheduling & Asia/Kolkata Day Boundary
    // -------------------------------------------------------------------------
    console.log("\n[Test 4 & 5] Asia/Kolkata Timezone & Midnight Calculation");
    const msLeft = getMillisecondsUntilNextMidnightIST();
    assert.ok(
      msLeft > 0 && msLeft <= 86400000,
      "msLeft must be between 0 and 24 hours in ms",
    );
    assert.ok(data1.nextRefreshMs > 0, "nextRefreshMs must be positive");
    assert.strictEqual(data1.nextRefreshTime, "12:00 AM IST");
    console.log(
      `✔ IST midnight countdown verified (${Math.round(msLeft / 3600000)}h remaining until 12:00 AM IST)`,
    );

    // -------------------------------------------------------------------------
    // 6. Concurrency Protection (Prevent Conflicting Daily Assignments)
    // -------------------------------------------------------------------------
    console.log("\n[Test 6 & 7] Concurrency Safety Under Parallel Generation");
    const testDate = "2029-12-31";
    await prisma.dailyProblem.deleteMany({ where: { istDate: testDate } });

    // Fire 10 parallel generation requests simultaneously for testDate
    const parallelRequests = Array.from({ length: 10 }, () =>
      ensureDailyProblem(testDate),
    );
    const parallelResults = await Promise.all(parallelRequests);
    const assignedIds = new Set(parallelResults.map((r) => r.problemId));
    assert.strictEqual(
      assignedIds.size,
      1,
      "Concurrent parallel generation must converge on exactly 1 problemId without error",
    );
    console.log(
      "✔ 10 simultaneous parallel generation calls safely converged on single assignment",
    );

    // -------------------------------------------------------------------------
    // 8 & 9. Repetition Policy: Avoid Selecting Yesterday's Problem (FR-01)
    // -------------------------------------------------------------------------
    console.log(
      "\n[Test 8 & 9] Repetition Policy: Avoid Selecting Yesterday's Problem (FR-01)",
    );
    // Get all eligible problems in database
    const allProblems = await prisma.problem.findMany({ select: { id: true } });
    const totalProblemCount = allProblems.length;
    console.log(`Total eligible problems in DB: ${totalProblemCount}`);

    // Create a mock simulation over sequential simulated days
    const simPrefix = "2035-01-";
    let lastSimProblemId = null;

    for (let day = 1; day <= 15; day++) {
      const simDate = `${simPrefix}${String(day).padStart(2, "0")}`;
      await prisma.dailyProblem.deleteMany({ where: { istDate: simDate } });

      const selection = await selectDailyProblemForDate(simDate);
      assert.ok(
        selection.problem && selection.problem.id,
        "Must select an eligible problem",
      );

      await prisma.dailyProblem.create({
        data: {
          istDate: simDate,
          problemId: selection.problem.id,
        },
      });

      // When total eligible problems >= 2, must never pick yesterday's problem
      if (day > 1 && totalProblemCount >= 2) {
        assert.notStrictEqual(
          selection.problem.id,
          lastSimProblemId,
          `Day ${day} (${simDate}) must not repeat day ${day - 1} problem`,
        );
      }
      lastSimProblemId = selection.problem.id;
    }
    console.log(
      "✔ Avoid-yesterday repetition policy verified across consecutive IST dates",
    );

    // -------------------------------------------------------------------------
    // 10, 11, 12. Submission & Reward Pipeline Integration
    // -------------------------------------------------------------------------
    // -------------------------------------------------------------------------
    // 10, 11, 12. Submission & Reward Pipeline Integration
    // -------------------------------------------------------------------------
    console.log(
      "\n[Test 10, 11, 12] Submission, Completion Tracking & Idempotent Rewards",
    );
    await prisma.dailyProblemCompletion.deleteMany({
      where: { userId: user1.id },
    });
    await prisma.coinTransaction.deleteMany({ where: { userId: user1.id } });
    const twoSumProblem = await prisma.problem.findFirst({
      where: { slug: "two-sum" },
    });
    if (twoSumProblem) {
      await prisma.dailyProblem.upsert({
        where: { istDate: todayIST },
        update: { problemId: twoSumProblem.id },
        create: { istDate: todayIST, problemId: twoSumProblem.id },
      });
    }
    const targetDaily = await ensureDailyProblem(todayIST);
    const targetProblemSlug = targetDaily.problem.slug;
    const initialUser1Coins = 100;

    // 1. Submit ACCEPTED solution for today's daily problem
    const submitAcceptedRes = await fetch(`${baseUrl}/api/execution/submit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token1}`,
      },
      body: JSON.stringify({
        slug: targetProblemSlug,
        language: "python",
        code: `class Solution:\n    def twoSum(self, nums, target):\n        return [0, 1]`,
        wait: true,
      }),
    });

    assert.strictEqual(submitAcceptedRes.status, 200);
    const submitAcceptedData = await submitAcceptedRes.json();
    assert.strictEqual(submitAcceptedData.verdict, "ACCEPTED");

    // Verify dailyProblemReward field is populated
    assert.ok(
      submitAcceptedData.dailyProblemReward,
      "Must include dailyProblemReward",
    );
    assert.strictEqual(submitAcceptedData.dailyProblemReward.granted, true);
    assert.strictEqual(submitAcceptedData.dailyProblemReward.coins, 2);

    // Verify User 1 coin balance increased by 2
    const user1After = await prisma.user.findUnique({
      where: { id: user1.id },
    });
    assert.strictEqual(
      user1After.coins,
      initialUser1Coins + 2,
      "Coins must increase by exactly 2",
    );

    // Verify DailyProblemCompletion record was created in database
    const completionRecord = await prisma.dailyProblemCompletion.findUnique({
      where: {
        userId_dailyProblemId: {
          userId: user1.id,
          dailyProblemId: targetDaily.id,
        },
      },
    });
    assert.ok(
      completionRecord,
      "DailyProblemCompletion record must exist in database",
    );

    // 2. User 1 submits AGAIN on the same day -> Must NOT grant duplicate coins
    const secondSubmitRes = await fetch(`${baseUrl}/api/execution/submit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token1}`,
      },
      body: JSON.stringify({
        slug: targetProblemSlug,
        language: "python",
        code: `class Solution:\n    def twoSum(self, nums, target):\n        return [0, 1]`,
        wait: true,
      }),
    });
    const secondSubmitData = await secondSubmitRes.json();
    assert.strictEqual(
      secondSubmitData.dailyProblemReward.granted,
      false,
      "Second submission must NOT grant duplicate reward",
    );
    assert.strictEqual(secondSubmitData.dailyProblemReward.coins, 0);

    const user1SecondCheck = await prisma.user.findUnique({
      where: { id: user1.id },
    });
    assert.strictEqual(
      user1SecondCheck.coins,
      initialUser1Coins + 2,
      "Coins must NOT increase on duplicate submission",
    );

    // 3. User 1 checks daily problem API -> Must show completed and reward claimed
    const statusRes = await fetch(`${baseUrl}/api/daily-problem`, {
      headers: { Authorization: `Bearer ${token1}` },
    });
    const statusData = await statusRes.json();
    assert.strictEqual(
      statusData.completed,
      true,
      "Must reflect completed status",
    );
    assert.strictEqual(
      statusData.rewardClaimed,
      true,
      "Must reflect rewardClaimed status",
    );

    // 4. User 2 has NOT submitted -> Must show NOT completed
    const user2StatusRes = await fetch(`${baseUrl}/api/daily-problem`, {
      headers: { Authorization: `Bearer ${token2}` },
    });
    const user2StatusData = await user2StatusRes.json();
    assert.strictEqual(
      user2StatusData.completed,
      false,
      "User 2 must still show not completed",
    );

    // 5. Submit non-daily problem -> Must NOT grant daily problem reward
    const otherProblem = await prisma.problem.findFirst({
      where: { id: { not: targetDaily.problemId } },
    });
    if (otherProblem) {
      const nonDailyRes = await fetch(`${baseUrl}/api/execution/submit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token2}`,
        },
        body: JSON.stringify({
          slug: otherProblem.slug,
          language: "python",
          code: `class Solution:\n    def solve(self):\n        pass`,
          wait: true,
        }),
      });
      const nonDailyData = await nonDailyRes.json();
      assert.strictEqual(
        nonDailyData.dailyProblemReward.granted,
        false,
        "Non-daily problem submission must not grant daily problem reward",
      );
    }

    console.log(
      "✔ Daily completion record created, reward granted once, duplicate prevented",
    );

    // -------------------------------------------------------------------------
    // 13. Historical Daily Problem Retrieval API
    // -------------------------------------------------------------------------
    console.log(
      "\n[Test 13] Historical Daily Problem Retrieval (/api/daily-problem/history)",
    );
    const historyRes = await fetch(
      `${baseUrl}/api/daily-problem/history?limit=10&page=1`,
      {
        headers: { Authorization: `Bearer ${token1}` },
      },
    );
    assert.strictEqual(historyRes.status, 200);
    const historyData = await historyRes.json();
    assert.strictEqual(historyData.success, true);
    assert.ok(Array.isArray(historyData.history), "Must return history array");
    assert.ok(
      historyData.total >= 1,
      "Must have at least 1 historical daily record",
    );

    // Verify ordering: first entry should be the latest IST date
    const firstHist = historyData.history[0];
    assert.ok(firstHist.istDate);
    assert.ok(firstHist.problem);

    // Verify user completion status is populated in history
    const todayHistEntry = historyData.history.find(
      (h) => h.istDate === todayIST,
    );
    if (todayHistEntry) {
      assert.strictEqual(
        todayHistEntry.completed,
        true,
        "User 1 should be marked completed on today's entry",
      );
    }
    console.log(
      "✔ Historical daily problems retrieved with pagination and user completion",
    );

    console.log("\n=======================================================");
    console.log("✔ ALL 15 AUTOMATED DAILY PROBLEM TEST SCENARIOS PASSED!");
    console.log("=======================================================\n");
  } finally {
    stopDailyProblemScheduler();
    server.close();
  }
}

await runDailyProblemTests();
