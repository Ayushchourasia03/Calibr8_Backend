import "dotenv/config";
import app from "./app.js";
import prisma from "./config/db.js";
import { TOPIC_CATALOG } from "./data/topicCatalog.js";
import {
  startDailyProblemScheduler,
  stopDailyProblemScheduler,
} from "./services/dailyProblemService.js";
import { purgeExpiredRevokedTokens } from "./utils/tokenBlacklist.js";
import { startProfilingWorker } from "./profiling/profilingQueue.js";
import { closeComplexityPool } from "./services/complexityPool.js";
import {
  drainEvaluations,
  recoverStaleSubmissions,
} from "./controllers/execution.controller.js";

const PORT = Number(process.env.PORT) || 3000;

let server;
let purgeTimer;
let staleTimer;
let shuttingDown = false;

process.on("unhandledRejection", (reason) => {
  console.error("[Process] Unhandled promise rejection:", reason?.stack || reason);
});
process.on("uncaughtException", (error) => {
  console.error("[Process] Uncaught exception, exiting:", error?.stack || error);
  process.exit(1);
});

function warnAboutConfiguration() {
  if (!process.env.NODE_ENV) {
    console.warn("⚠ NODE_ENV is not set. Set NODE_ENV=production in production (CORS, proxy trust, secrets, HSTS depend on it).");
  }
  const codeboxUrl = process.env.CODEBOX_URL || "";
  if (codeboxUrl.startsWith("http://") && process.env.CODEBOX_ALLOW_INSECURE_HTTP === "true") {
    const log = process.env.NODE_ENV === "production" ? console.error : console.warn;
    log(
      "⚠ [Security] CodeBox is reached over plain HTTP: the CodeBox token and all submitted code travel unencrypted. " +
        "Serve CodeBox over HTTPS (or a private network) and unset CODEBOX_ALLOW_INSECURE_HTTP.",
    );
  }
}

// Codebox engine check
async function checkCodeboxEngine() {
  const url = process.env.CODEBOX_URL;
  if (!url) {
    console.log("ℹ CODEBOX_URL not configured — Codebox engine health check skipped.");
    return;
  }
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      console.log(`✅ Connected to Codebox exec engine (${data.status})`);
    } else {
      console.log(`❌ Codebox OFF - Engine returned ${res.status}`);
    }
  } catch (err) {
    console.log(`❌ Codebox OFF - Exec engine unreachable (${err.message})`);
  }
}

async function startServer() {
  warnAboutConfiguration();
  if (process.env.DATABASE_URL) {
    try {
      await prisma.$connect();
      await Promise.all(
        TOPIC_CATALOG.map((topic) =>
          prisma.topic.upsert({
            where: { slug: topic.slug },
            update: { name: topic.name, category: topic.category },
            create: topic,
          }),
        ),
      );
      console.log("✅ Connected to database");
    } catch (error) {
      console.warn("⚠ Database connection warning:", error.message);
    }
  } else {
    console.warn(
      "ℹ DATABASE_URL is not set. Set DATABASE_URL in .env to connect to your PostgreSQL database.",
    );
  }

  server = app.listen(PORT, "0.0.0.0", async () => {
    console.log(`🚀 Server running at http://0.0.0.0:${PORT}`);
    startDailyProblemScheduler();
    purgeTimer = setInterval(() => {
      purgeExpiredRevokedTokens().catch(() => {});
    }, 60 * 60 * 1000);
    purgeTimer.unref?.();
    // Submissions left PROCESSING by a crashed/restarted process.
    recoverStaleSubmissions().catch(() => {});
    staleTimer = setInterval(() => {
      recoverStaleSubmissions().catch(() => {});
    }, 5 * 60 * 1000);
    staleTimer.unref?.();
    // Background complexity profiling (no-op unless COMPLEXITY_PROFILING_ENABLED).
    startProfilingWorker().catch((err) => console.error("Profiling worker failed to start:", err.message));
    await checkCodeboxEngine();
  });
  // Keep idle connections open longer than typical load-balancer idle
  // timeouts (60 s) to avoid sporadic 502s on reused connections.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  server.on("error", (error) => {
    console.error("❌ Server error:", error.message);
    process.exitCode = 1;
  });

  server.on("close", () => {
    console.log("🛑 HTTP server closed");
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n⚠ ${signal} received. Shutting down gracefully...`);

  stopDailyProblemScheduler();
  if (purgeTimer) clearInterval(purgeTimer);
  if (staleTimer) clearInterval(staleTimer);

  // Stop accepting connections and let in-flight requests finish (bounded)
  // before tearing down the DB pool underneath them.
  if (server?.listening) {
    await Promise.race([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => setTimeout(resolve, 10_000).unref()),
    ]);
  }

  // Background (202) judging jobs: give them time to store their verdicts.
  // Anything still unfinished is marked ERROR by the next instance's sweep.
  const pending = await drainEvaluations(25_000);
  if (pending) console.log(`⏳ Waited for ${pending} background evaluation(s).`);

  await closeComplexityPool().catch(() => {});

  try {
    await prisma.$disconnect();
    console.log("🔌 Database disconnected");
  } catch (error) {
    console.error("⚠ Database disconnect error:", error.message);
  }

  console.log("✅ Shutdown complete");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

startServer();
