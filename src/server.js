import "dotenv/config";
import app from "./app.js";
import prisma from "./config/db.js";

const PORT = Number(process.env.PORT) || 3000;

let server;
let shuttingDown = false;

// Codebox engine check
async function checkCodeboxEngine() {
  const url = process.env.CODEBOX_URL;
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
    console.log(
      `   👉 VPS pe jaake 'cd /opt/codebox && docker compose up -d' chala de mere bhai`,
    );
  }
}

async function startServer() {
  if (process.env.DATABASE_URL) {
    try {
      await prisma.$connect();
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

  if (server?.listening) {
    server.close();
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
