// scripts/test-isolated.mjs
//
// Runs the backend test suite against an ISOLATED database, never production.
//
//   npm run test:isolated -- --setup   create + push schema + seed the test database
//   npm run test:isolated              run every tests/*.test.js against it
//   npm run test:isolated -- tests/x.test.js   run selected files
//
// The test database is a separate database (default "calibr8_test", override
// with TEST_DATABASE_NAME) on the same Postgres server as DATABASE_URL. Its URL
// is derived in memory and never printed. Safety rules:
//   - refuses any database whose name does not end in "_test";
//   - CodeBox calls that a test does not mock go to an unreachable host;
//   - complexity profiling is disabled.
import "dotenv/config";
import { spawnSync } from "child_process";
import { createRequire } from "module";
import fs from "fs";
import path from "path";

const require = createRequire(import.meta.url);
const pg = require("pg");

const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
const testDb = process.env.TEST_DATABASE_NAME || "calibr8_test";
if (!/^[a-z0-9_]+_test$/.test(testDb)) {
  console.error(`Refusing to use '${testDb}': the test database name must end in "_test".`);
  process.exit(1);
}
const source = new URL(sourceUrl);
if (source.pathname.slice(1) === testDb) {
  console.error("DATABASE_URL already points at the test database name; refusing (expected the main database URL).");
  process.exit(1);
}
const testUrl = new URL(sourceUrl);
testUrl.pathname = `/${testDb}`;

const env = {
  ...process.env,
  DATABASE_URL: testUrl.toString(),
  CODEBOX_URL: "https://codebox.invalid",
  CODEBOX_TOKEN: "test-token",
  COMPLEXITY_PROFILING_ENABLED: "false",
};
const run = (args, label) => {
  console.log(`\n▶ ${label}`);
  const r = spawnSync(process.execPath, args, { env, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`✖ ${label} failed`);
    process.exit(r.status ?? 1);
  }
};

const SQL_MANAGED_MIGRATIONS = [
  "20261119000000_unique_daily_login_tx",
  "20261123000000_daily_problem_hardening",
  "20261124000000_session_token_version",
];

const args = process.argv.slice(2);
if (args.includes("--setup")) {
  const admin = new pg.Client({ connectionString: sourceUrl });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [testDb]);
  if (!exists.rowCount) await admin.query(`CREATE DATABASE "${testDb}"`);
  await admin.end();
  console.log(`Test database '${testDb}' ${exists.rowCount ? "exists" : "created"}.`);
  const prisma = path.resolve("node_modules/prisma/build/index.js");
  run([prisma, "db", "push", "--skip-generate", "--accept-data-loss"], "prisma db push (test database)");
  // Objects Prisma cannot express (partial unique indexes, FK RESTRICT): idempotent SQL.
  for (const migration of SQL_MANAGED_MIGRATIONS) {
    run(
      [prisma, "db", "execute", "--file", `prisma/migrations/${migration}/migration.sql`, "--schema", "prisma/schema.prisma"],
      `apply ${migration}`,
    );
  }
  run(["prisma/seed.js"], "seed topics and themes");
  run(["scripts/seedProblems.js"], "seed problems");
  run(["scripts/upload-study.js"], "seed study material");
  process.exit(0);
}

const files = args.length ? args : fs.readdirSync("tests").filter((f) => f.endsWith(".test.js")).map((f) => path.join("tests", f));
run(["--test", "--test-concurrency=1", ...files], `node --test (${files.length} files) against '${testDb}'`);
