// scripts/devStack.js
//
// One command to start / stop everything needed for local development:
//
//   npm run up     Docker Desktop -> local CodeBox -> backend (nodemon, in this terminal)
//   npm run down   backend -> CodeBox -> Docker Desktop (frees the RAM/CPU it uses)
//
// CodeBox is started from ../codebox/docker-compose.local.yml plus
// codebox.local.yml (binds it to 127.0.0.1 only). The CodeBox repo is not modified.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codeboxCompose = path.resolve(backendDir, "../codebox/docker-compose.local.yml");
const codeboxOverride = path.join(backendDir, "codebox.local.yml");
const nodemonBin = path.join(backendDir, "node_modules/nodemon/bin/nodemon.js");
const CODEBOX_HEALTH = "http://127.0.0.1:2358/health";

// Read .env without loading it into process.env: nodemon's children inherit
// this process's env, and stale values would then override later .env edits.
function readPort() {
  try {
    const env = dotenv.parse(fs.readFileSync(path.join(backendDir, ".env")));
    return Number(env.PORT) || 3000;
  } catch {
    return 3000;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) => spawnSync(cmd, args, { cwd: backendDir, stdio: "inherit" }).status === 0;
const quiet = (cmd, args) => spawnSync(cmd, args, { cwd: backendDir, stdio: "ignore" }).status === 0;
const compose = (...args) => run("docker", ["compose", "-f", codeboxCompose, "-f", codeboxOverride, ...args]);
const dockerReady = () => quiet("docker", ["info"]);

function powershell(script) {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  return (r.stdout || "").trim();
}

// The process serving the backend on `port`: the nodemon parent when there is
// one (so it does not linger), otherwise the node server itself. Anything that
// is not a node `server.js` is reported and left alone.
function findBackend(port) {
  const out = powershell(`
    $c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $c) { exit 0 }
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"
    if (-not $p -or $p.Name -ne 'node.exe' -or $p.CommandLine -notmatch 'server\\.js') { "OTHER $($c.OwningProcess) $($p.Name)"; exit 0 }
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"
    if ($parent -and $parent.CommandLine -match 'nodemon') { "BACKEND $($parent.ProcessId)" } else { "BACKEND $($p.ProcessId)" }
  `);
  const [kind, pid, name] = out.split(/\s+/);
  return kind ? { kind, pid: Number(pid), name } : null;
}

async function startDocker() {
  if (dockerReady()) return true;
  console.log("▶ Starting Docker Desktop (can take up to a minute)...");
  if (!quiet("docker", ["desktop", "start", "--timeout", "180"])) {
    // Older Docker Desktop without the `docker desktop` CLI: launch the app.
    const exe = [
      path.join(process.env.LOCALAPPDATA || "", "Programs/DockerDesktop/Docker Desktop.exe"),
      path.join(process.env.ProgramFiles || "", "Docker/Docker/Docker Desktop.exe"),
    ].find((p) => fs.existsSync(p));
    if (exe) spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
  }
  for (let i = 0; i < 90; i++) {
    if (dockerReady()) return true;
    await sleep(2000);
  }
  return false;
}

async function waitForCodebox() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(CODEBOX_HEALTH, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  return false;
}

async function up() {
  if (!fs.existsSync(codeboxCompose)) {
    console.error(`✖ CodeBox repo not found at ${path.dirname(codeboxCompose)}`);
    process.exit(1);
  }
  const port = readPort();
  const existing = findBackend(port);
  if (existing?.kind === "OTHER") {
    console.error(`✖ Port ${port} is used by another program (${existing.name}, PID ${existing.pid}). Close it first.`);
    process.exit(1);
  }

  if (!(await startDocker())) {
    console.error("✖ Docker Desktop did not start. Open it manually, then run `npm run up` again.");
    process.exit(1);
  }
  console.log("▶ Starting CodeBox...");
  if (!compose("up", "-d", "--build")) {
    console.error("✖ CodeBox failed to start (see the output above).");
    process.exit(1);
  }
  console.log((await waitForCodebox())
    ? "✅ CodeBox ready at http://127.0.0.1:2358"
    : "⚠ CodeBox is not answering yet; check it with `npm run codebox:logs`.");

  if (existing?.kind === "BACKEND") {
    console.log(`✅ Backend is already running on port ${port}. Stop everything with \`npm run down\`.`);
    return;
  }
  console.log(`▶ Starting backend on http://localhost:${port}  (Ctrl+C stops only the backend; \`npm run down\` stops everything)\n`);
  const child = spawn(process.execPath, [nodemonBin, "src/server.js"], { cwd: backendDir, stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}

async function down() {
  const port = readPort();
  const backend = findBackend(port);
  if (backend?.kind === "BACKEND") {
    console.log(`■ Stopping backend (PID ${backend.pid})...`);
    quiet("taskkill", ["/PID", String(backend.pid), "/T", "/F"]);
  } else {
    console.log("■ Backend is not running.");
  }

  if (!dockerReady()) {
    console.log("■ Docker Desktop is already off.");
    return;
  }
  console.log("■ Stopping CodeBox...");
  compose("stop");
  console.log("■ Quitting Docker Desktop (frees its memory)...");
  if (quiet("docker", ["desktop", "stop", "--timeout", "120"])) {
    console.log("✅ Everything is off.");
  } else {
    console.log("⚠ CodeBox is stopped, but Docker Desktop did not quit. Quit it from the system tray to free its memory.");
  }
}

const command = process.argv[2];
if (command === "up") await up();
else if (command === "down") await down();
else {
  console.error("Usage: node scripts/devStack.js up|down");
  process.exit(1);
}
