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

const PORT = Number(process.env.PORT) || 3000;

let server;
let purgeTimer;
let shuttingDown = false;

// Codebox engine check
async function checkCodeboxEngine() {
  const url = process.env.CODEBOX_URL;
  if (!url) {
    console.log("ℹ CODEBOX_URL not configured — Codebox engine health check skipped.");
    return;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(`${url}/health`, { signal: controller.signal });
    clearTimeout(timeout);

    if (res.ok) {
      const data = await res.json();
      console.log(
        `✅ Successfully connected to Codebox exec engine (${data.status}) at ${url}`,
      );
    } else {
      console.log(`❌ Codebox OFF - Engine returned ${res.status} at ${url}`);
    }
  } catch (err) {
    console.log(`❌ Codebox OFF - Exec engine down at ${url} (${err.message})`);
  }
}

async function startServer() {
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
    // Background complexity profiling (no-op unless COMPLEXITY_PROFILING_ENABLED).
    startProfilingWorker().catch((err) => console.error("Profiling worker failed to start:", err.message));
    await checkCodeboxEngine();
  });

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

  // Stop accepting connections and let in-flight requests finish (bounded)
  // before tearing down the DB pool underneath them.
  if (server?.listening) {
    await Promise.race([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => setTimeout(resolve, 10_000).unref()),
    ]);
  }

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
