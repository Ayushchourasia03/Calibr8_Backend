// Imported FIRST by every test that touches the database or CodeBox.
//
// Tests create and delete rows and send code to the judge, so they must never
// run against the DATABASE_URL / CODEBOX_URL in .env (which may be
// production). This module runs before dotenv, picks an explicit test
// database and blanks the judge, and refuses to continue otherwise.
//
//   TEST_DATABASE_URL=postgresql://...  node --test tests/x.test.js
//
// A local database (localhost / 127.0.0.1) passed as DATABASE_URL is also
// accepted. To use the .env database deliberately, set TEST_DATABASE_URL to
// it AND TEST_DATABASE_CONFIRM=<its host>.
// For tests that need a real judge: TEST_CODEBOX_URL / TEST_CODEBOX_TOKEN.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(here, "../../.env");
const fileEnv = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {};

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};
const isLocal = (url) => ["localhost", "127.0.0.1", "::1"].includes(hostOf(url));

function refuse(reason) {
  console.error(
    `\n[testEnv] Refusing to run database tests: ${reason}\n` +
      "Set TEST_DATABASE_URL to a disposable database (a Neon branch or local Postgres).\n",
  );
  process.exit(1);
}

const explicit = process.env.TEST_DATABASE_URL?.trim();
const shell = process.env.DATABASE_URL?.trim();
let target;
if (explicit) {
  if (explicit === fileEnv.DATABASE_URL && !isLocal(explicit) && process.env.TEST_DATABASE_CONFIRM !== hostOf(explicit)) {
    refuse("TEST_DATABASE_URL is the DATABASE_URL from .env. Confirm with TEST_DATABASE_CONFIRM=<host> if intended.");
  }
  target = explicit;
} else if (shell && isLocal(shell)) {
  target = shell;
} else {
  refuse("no TEST_DATABASE_URL is set.");
}
process.env.DATABASE_URL = target;

// Never reach the judge configured in .env from tests.
if (process.env.TEST_CODEBOX_URL) {
  process.env.CODEBOX_URL = process.env.TEST_CODEBOX_URL;
  process.env.CODEBOX_TOKEN = process.env.TEST_CODEBOX_TOKEN || "";
} else {
  process.env.CODEBOX_URL = "";
  process.env.CODEBOX_TOKEN = "";
}
