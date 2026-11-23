// Safety guard for scripts that write to (or wipe) the database.
//
// Destructive scripts call requireDestructiveConfirmation() before touching
// anything. Against any non-local database they refuse to run unless the
// exact target host is confirmed on the command line:
//
//   node scripts/reset-and-upload.js --confirm=<database host>
//
// so a script can never be pointed at production by accident (e.g. because
// .env holds the production DATABASE_URL).

function describe(url) {
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname, database: parsed.pathname.replace(/^\//, "") || "(default)" };
  } catch {
    return { host: null, database: null };
  }
}

export function isLocalDatabase(url = process.env.DATABASE_URL) {
  const { host } = describe(url || "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Exits the process unless the target is local or explicitly confirmed with
 * --confirm=<host>. Prints what is about to be changed either way.
 * @param {string} action human description, e.g. "TRUNCATE all problems and submissions"
 */
export function requireDestructiveConfirmation(action, argv = process.argv) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const { host, database } = describe(url);
  console.log(`Target database: host=${host} db=${database}`);
  console.log(`About to: ${action}`);
  if (isLocalDatabase(url)) return;

  const confirm = argv.find((arg) => arg.startsWith("--confirm="))?.slice("--confirm=".length);
  if (confirm !== host) {
    console.error(
      `\nRefusing to run against a remote database without confirmation.\n` +
        `Re-run with --confirm=${host} if you really mean to ${action} on this database.\n` +
        `(Take a backup / Neon branch first.)`,
    );
    process.exit(1);
  }
}
