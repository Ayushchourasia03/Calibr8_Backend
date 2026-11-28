# Final Independent Security Verification, Round 2

> **Local document. It is NOT covered by `.gitignore`** (this verification did not change `.gitignore`). It describes residual weaknesses, and the Calibr8 repositories are public. Do not commit or push it; add it to `.gitignore`, or keep it outside the repository.

| | |
|---|---|
| Date | 2026-11-28 |
| Verifies | `SECURITY_REMEDIATION_ROUND2.md` and `SECURITY_AUDIT.md` Appendix C, against the working trees |
| Scope | `backend` (`31ee70c` + 28 modified, 19 untracked), `codebox` (`7117161` + 21 modified, 4 untracked), `frontend` (`e6240f1` + 1 modified) |
| Restrictions honored | No change to code, environment files, earlier reports, `.gitignore` or Git history. No commit, push or deploy. No production database or service accessed. No secret value printed: tokens were read programmatically and reported by length only. The diff statistics of all three repositories are identical before and after this verification. |

---

## 1. Executive summary

Round 2's central claim holds for the attack it was built against. **Four sleeping accounts can no longer lock other users out.** That was reproduced independently on a real sandbox:
- the victim was served in 7.1 s on a 100-case problem and 4.3 s on small problems (before round 2: 503 after 30 s);
- with attackers on other instances, 1.9 s.

The following also hold, verified against the actual running containers or a fresh isolated stack:
- **Process trees:** they are always killed, including signal-ignoring `setsid` daemons in Python and C, fork bombs and orphans.
- **ZIP attacks:** symlink, path-traversal and absolute-path entries are all rejected, and nothing is written outside the box.
- **Readiness flood:** 6,000 requests cost the database 6 transactions.
- **Log flood:** 5,000 rejected requests produce 184 backend log lines.
- **Campus polling:** 300 signed-in users behind one IP polling get 0 × 429.
- **Local stack:** the running `codebox-local` is the remediated build.

Four claims of round 2 are **overstated**. Each was reproduced here:

| # | Claim | What actually happens | Finding |
|---|---|---|---|
| 1 | "Sleeping submissions cannot monopolize judge slots" | False beyond a handful of accounts. **24 fresh accounts gave the first legitimate user 503 `JUDGE_BUSY` after 30 s**; 16 accounts, a 27.3 s wait. Fresh accounts are served before returning users with usage history (23.5 s). | R2V-1 |
| 2 | "Legitimate users can still submit under realistic shared-IP traffic" | True for signed-in traffic only. **Login and registration are still limited to 30 per IP per 15 minutes:** the 31st student behind a campus NAT is refused, and one flooder blocks logins for the whole IP. | R2V-2 |
| 3 | The C/C++ multi-case harness path is bounded like the batch path | Not attack-tested in round 2 (its E2E disables multi-case). Here, 4 sleeping C++ accounts made a legitimate user wait **21.6 s**. | R2V-3 |
| 4 | "Worker crash leaves nothing behind" | True for boxes and processes, but **batch snapshot directories with the crashed job's source code remain** on the worker. CodeBox still writes **one log line per request** (3,000 for 3,000 rejected requests). | R2V-4, R2V-5 |

**Verdict:**
- **Staging: READY FOR STAGING WITH CONDITIONS.**
- **Production: NOT READY FOR PRODUCTION.** The owner's credential, GitHub visibility, database, hosting, firewall, HTTPS and deployment actions are all still open. R2V-1 and R2V-2 also need an engineering or product decision first.

---

## 2. Method and environment

| Target | Used for |
|---|---|
| **Running `codebox-local` stack** (the containers on this machine; API `127.0.0.1:2358`) | Container inspection, plus harmless probes with the backend's own token: sandbox view, ZIP attacks, process persistence. Nothing disruptive. |
| **Isolated stack `c8v3`**: built from the working tree; its own compose project, port (`127.0.0.1:2396`), random token, isolate `cg_root` and worker cgroup | Capacity and disruptive attacks: sleeping submissions, multi-account waves, C++ harness, Redis outage, worker crash; the round-2 test suites |
| **Real backend code**, in-process or as a child process, production mode | Judging and scheduling against the isolated sandbox, with an unreachable database. Platform attacks against a throwaway PostgreSQL 16. |
| **Measurements** | Database load counted by Postgres itself (`pg_stat_database`). Log volume counted from the real stdout/stderr of a separate server process, and from `docker logs` for CodeBox. |

The test stack, database, images and cgroups were all removed afterwards. Scripts are in `C:\Users\USER\AppData\Local\Temp\claude\45be2b2642ffb3e1\d41e6fb4-82ea-43a3-be07-0c392318f1e0\scratchpad\verify3\`, a temporary folder.

---

## 3. Attack reproduction (the eight requested attacks)

### 3.1 Sleep-based judge-slot exhaustion

Real sandbox; Python wrong answer sleeping 3.5 s per case; 100-case problem.

| Measure | Round 1 (verification) | Now |
|---|---|---|
| Cases run | 35/35 | **4** |
| Sandbox time | 123.4 s | **14.2 s** |
| Verdict | WRONG_ANSWER | WRONG_ANSWER |

A sleeping **correct** answer is stopped by the evaluation budget: TIME_LIMIT_EXCEEDED at about 123 s of sandbox time, as documented. **Reproduced as fixed.**

### 3.2 Four-account judge monopolization

| Scenario | Victim latency (3 consecutive Runs) | Round 1 |
|---|---|---|
| 4 accounts, Python, 100 cases | 4.8 s, 2.4 s, 1.9 s (`attack.mjs`); 7.1 s, 1.6 s, 0.08 s (`judgeDos.e2e.js`) | 503 after 30 s |
| 4 accounts, 5-case problem (one-shot path) | 4.3 s, 0.08 s, 0.08 s | 503 after 30 s |
| 4 accounts, 15-case problem (one-shot path) | 4.3 s, 2.2 s, 2.2 s | 503 after 30 s |
| 4 accounts on two other backend instances | 1.9 s, 1.6 s, 1.6 s | not measured |
| **4 accounts, C++ through the multi-case harness** (sleep 1.9 s per case, accepted by the harness gate) | 6.3 s, **21.6 s**, 0.1 s | not tested in round 2 |

**Reproduced as fixed for the batch path.** The harness path is markedly slower (R2V-3).

### 3.3 Multi-account abuse

Fresh accounts submit sleeping Python simultaneously; the victim arrives 2 s later.

| Accounts | First victim | Next victims | Attackers |
|---|---|---|---|
| 16 fresh | **27.3 s** (30 s timeout) | 2.2 s, 2.2 s | WRONG_ANSWER, up to 58 s |
| **24 fresh** | **503 `JUDGE_BUSY` after 30,010 ms** | 6.4 s, 2.2 s | some attackers also 503 |
| 16 fresh + a **returning** victim (with recent usage) | **23.5 s** | 2.2 s, 2.2 s | |

**Reproduced as NOT fixed** (R2V-1).
- **Why it happens:** fresh attackers have no history, so they tie with a fresh victim and are served in arrival order. A returning user's usage score even ranks it **behind** them.
- **Why it repeats:** once attackers have run something, newcomers go first again. An attacker therefore needs a new wave of fresh accounts for each outage. Registration allows 30 accounts per IP per 15 minutes.

### 3.4 Process persistence after a timeout

All run against the **running `codebox-local` containers**. After each job, the worker was checked for processes running as a box uid (60000–60999) and for box directories.

| Probe | Result |
|---|---|
| Python: main process ignoring SIGTERM, SIGINT, SIGHUP and SIGQUIT, plus a `setsid` double-forked grandchild ignoring the same signals and looping forever | TLE (wall clock); **0** box processes left |
| C: every signal 1–31 ignored, `setsid` double fork, grandchild `pause()` forever | TLE (wall clock); **0** left |
| Python fork bomb (up to 1,000 forks) | 58 forks, then the process limit; **0** left |
| 3 orphans sleeping 300 s (an earlier probe on the same stack) | 0 left |
| Box directories after all probes | 0 |

**Reproduced as fixed.** On the isolated stack, after two deliberate worker crashes, the processes and boxes were clean, but **two batch snapshot directories with the crashed jobs' `main.py` remained** (R2V-4).

### 3.5 Health-endpoint database exhaustion

Real app in a child process, production mode, throwaway PostgreSQL. 6,000 requests to `/health/ready` and `/api/health/ready` in 12.3 s, from one IP.

| Measure | Result |
|---|---|
| 200 / 429 / 503 | 120 / 5,880 / 0 |
| **Database transactions caused** (`pg_stat_database`) | **6** (round 1: 1 per request) |
| Database connections | 1 before, 1 after |

**Reproduced as fixed.** Both paths share one 120-per-minute bucket per IP. A readiness probe sharing an IP with a flood is refused too (R2V-6).

### 3.6 Security log flooding

**Backend:** 5,000 rejected requests of five kinds in one minute, counted from the server process's real output:
- unknown routes with an encoded newline (`%0A`);
- forged bearer tokens;
- malformed JSON;
- oversized emails;
- readiness floods.

| Measure | Result |
|---|---|
| Statuses | 400: 330, 401: 300, 404: 300, 429: 3,950, 200: 120 |
| **Backend log lines** | **184** (round 1: one or two per request) |
| Log injection (`%0A` splitting a line) | none |

**CodeBox:** 3,000 requests with a wrong token produced **3,000 log lines** (one JSON line per request, including the 2,980 that were rate-limited). The lines are JSON-escaped, so there's no injection.

**Backend reproduced as fixed; CodeBox not bounded** (R2V-5).

### 3.7 Shared-IP rate-limit interference

| Scenario (one IP, production mode, real database) | Result |
|---|---|
| 300 signed-in users × 5 status polls (real `protect` and `pollLimiter`) | 1,500 × 404, **0 × 429** |
| **60 students log in** (a fresh process) | **30 admitted, 30 × 429**; the first refusal is the 31st |
| 5 registrations right after | **5 × 429** (login and registration share `authLimiter`) |
| A login flood earlier in the same window (from the log test) | then **all 60** logins are 429 |

**Signed-in traffic: fixed. Login and registration: NOT fixed** (R2V-2, pre-existing). Round 2 changed only `apiLimiter`.

### 3.8 CodeBox sandbox escape and ZIP symlink attacks

Run against the **running `codebox-local` stack**, with probe programs that build sensitive names at run time.

| Probe | Result |
|---|---|
| Identity | box user `60019:60019` |
| Network: `redis:6379`, `api:3000`, `host.docker.internal:2358`, `1.1.1.1:53` | all fail (DNS or socket error): **no network** |
| Visible: `/app/src`, Docker socket, `/var/cache/codebox`, isolate box root, `/root`, `/home/codebox`, `/proc/1/environ` | all **invisible** |
| Readable: `/etc/shadow`, `/proc/1/environ`, `/proc/kcore` | all **unreadable** |
| Writable: `/etc`, `/usr`, `/sys/fs/cgroup` | not writable; only the box directory is |
| Processes visible | PIDs 2 and 3 only (private PID namespace) |
| Environment | `HOME, LANG, LIBC_FATAL_STDERR_, OLDPWD, PATH, PWD` |
| `/usr` mount | `nosuid` |
| `/usr/local/etc/isolate` (isolate's config) | **visible** (informational, R2V-8) |
| ZIP with a symlink entry (N1) | rejected: "archive contains a symbolic link"; target not written |
| ZIP with `../../../../tmp/…` | rejected: "path traversal entries" |
| ZIP with an absolute path | stripped and rejected |
| Files outside the box after the ZIP probes | **none** |

On the isolated stack, the 21-check E2E passed every sandbox check (symlinked outputs, FIFO, `/metrics`, environment, network, other jobs' files, memory, CPU and process limits, output truncation, ZIP symlink). The one failure was the snapshot check, caused by R2V-4. CodeBox's own sandbox E2E passed 11/11.

**Reproduced as fixed.**

---

## 4. The running local containers

| Container | Inspected (`docker inspect`, `docker exec`) |
|---|---|
| `codebox-local-api-1` | Image built 2026-11-28 06:12 UTC; **no CodeBox source file is newer**. User `node`, not privileged, private cgroup namespace. Published **only** on `127.0.0.1:2358`. Host allow-list returns 421 for a foreign Host. A cross-origin preflight gets 401 with no CORS headers. |
| `codebox-local-worker-1` | Same build; PID 1 `node src/queue/worker.js` runs as **`codebox`** (uid 1002); isolate 2.7, setuid root; `cg_root=/sys/fs/cgroup/isolate`. **Privileged, host cgroup namespace, `label=disable`** (SA-I3, by design). 4 GB memory and 1.5 CPU limits; no container PID limit (isolate enforces per box); no stale boxes. |
| `codebox-local-redis-1` | Not published; internal network only; **no password** (SA-L8); `maxmemory-policy noeviction`; data in a named volume |
| Token | The API's `AUTH_TOKEN` is 15 characters, the public default (`CODEBOX_LOCAL_TOKEN` not set). It's not exploitable from browsers any more (CORS off, Host allow-list), but anything on this machine can use it. |

---

## 5. Finding-by-finding status

The "Round 2 claimed" column is from `SECURITY_AUDIT.md` Appendix C (or B, where C has no row). "Accurate?" compares that claim with this verification.

### 5.1 Original findings

| ID | Round 2 claimed | Verified status | Accurate? | Evidence or note |
|---|---|---|---|---|
| SA-H1 | Fixed and verified | VERIFIED_FIXED | yes | Comparator timing tests pass in the full suite |
| **SA-H2** | **Fixed and verified (monopolization)** | **PARTIALLY_FIXED** (residual **Medium**) | **no** | Fixed for 4 accounts (§3.2). **24 fresh accounts reproduce the 503** (§3.3, R2V-1); the C++ harness gives 21.6 s (R2V-3). |
| SA-H3 | Requires manual action | OWNER_ACTION_REQUIRED | yes | Hosted environments not verifiable; the local `CODEBOX_URL` is loopback |
| SA-H4 | Fixed and verified | VERIFIED_FIXED | yes | 21-check: an unauthenticated flood gets 429 while the authenticated client gets 200 |
| SA-H5 | Fixed and verified | VERIFIED_FIXED | yes | Symlinked outputs not followed; FIFO; non-root worker (§4) |
| SA-H6 | Requires manual action | OWNER_ACTION_REQUIRED | yes | `.env` still has 20 plaintext note lines and 1 commented public IP (structure only) |
| SA-M1 | Fixed and verified | VERIFIED_FIXED | yes | Oversized email rejected (§3.6); suite |
| SA-M2 | Fixed and verified | VERIFIED_FIXED | yes | Suite |
| SA-M3 | Requires manual action | OWNER_ACTION_REQUIRED | yes | Local `NODE_ENV=development`, `TRUST_PROXY` unset |
| **SA-M4** | Partially fixed | **PARTIALLY_FIXED** (residual **Medium**) | understated | Multi-account waves cause 503 for others (R2V-1), not only "draw capacity" |
| SA-M5 | Requires manual action | OWNER_ACTION_REQUIRED | yes | Role not applied on Neon (not verifiable here) |
| SA-M6 / FV-3 | Fixed and verified | VERIFIED_FIXED | yes | 6 database transactions for 6,000 probes (§3.5); see R2V-6 |
| SA-M7 | Requires manual action | OWNER_ACTION_REQUIRED | yes | Visibility not re-queried in this verification; treat as public |
| SA-M8 | Fixed and verified | VERIFIED_FIXED | yes | 21-check (7 MB unauthenticated body → 401; 9 MB authenticated → 413) |
| SA-L1 | Partially fixed | PARTIALLY_FIXED | yes | Side channels accepted |
| SA-L2 | Fixed and verified | VERIFIED_FIXED | yes | Malformed JSON → 400 (§3.6) |
| SA-L3 | Partially fixed | PARTIALLY_FIXED | yes | `.env` `JWT_EXPIRES_IN=7d` |
| SA-L4, SA-L5, SA-L6 | Fixed and verified | VERIFIED_FIXED | yes | Suite |
| SA-L7 | Partially fixed | PARTIALLY_FIXED | yes | Not re-audited |
| SA-L8 | Partially fixed | PARTIALLY_FIXED | yes | Redis without a password in the running stack (§4) |
| SA-L9 / FV-4 | Fixed and verified | VERIFIED_FIXED (backend) | yes for the backend | 184 lines for 5,000 rejected requests; CodeBox unbounded (R2V-5) |
| SA-L10 | Requires product decision | OWNER_ACTION_REQUIRED | yes | Switch present, default `all` |
| SA-L11 | Requires manual action | OWNER_ACTION_REQUIRED | yes | Unchanged |
| SA-I1 | Not applicable | NOT_APPLICABLE | yes | |
| SA-I2 | Requires manual action | OWNER_ACTION_REQUIRED | yes | `OAUTH_STATE_SECRET` and `CODEBOX_TOKEN` under 32 characters in `.env` |
| SA-I3 | Partially fixed | PARTIALLY_FIXED | yes | Privileged worker (§4) |
| SA-I4, SA-I5 | Not applicable | NOT_APPLICABLE | yes | |
| SA-I6 | Partially fixed | PARTIALLY_FIXED | yes | |
| SA-I7 | Partially fixed | PARTIALLY_FIXED | yes | Cross-instance controls only in CodeBox (multi-instance test §3.2) |

### 5.2 Findings from remediation (N1–N5) and the first verification (FV-1 to FV-10)

| ID | Round 2 claimed | Verified status | Accurate? | Evidence or note |
|---|---|---|---|---|
| N1 | Fixed | VERIFIED_FIXED | yes | ZIP symlink, traversal and absolute paths on the **running** stack (§3.8) |
| N2 | Fixed | VERIFIED_FIXED | yes | CodeBox logs path and status, never bodies (§3.6 sample) |
| N3 | Fixed and verified | VERIFIED_FIXED | yes | 422 on the running stack; `api.test.js` 14/14 |
| N4 | Fixed | VERIFIED_FIXED | yes | Bound to `127.0.0.1` only (§4) |
| N5 | Not applicable | NOT_APPLICABLE | yes | Bypassed again: only the literal `/proc/self/` was rejected; the run-time-built path passed |
| **FV-1** | Fixed and verified | **PARTIALLY_FIXED** | **no** | Same as SA-H2 |
| FV-2 | Fixed and verified | VERIFIED_FIXED | yes | §4; the public default token remains an owner recommendation |
| **FV-5** | Fixed and verified | **PARTIALLY_FIXED** | **no** | Signed-in traffic fixed; login and registration not (R2V-2) |
| FV-6 | Fixed (local) | PARTIALLY_FIXED | partly | Earlier reports are ignored; **this report and `AGENTS.md` are not** |
| FV-7, FV-8, FV-9 | Fixed and verified | VERIFIED_FIXED | yes | Suite (`remediationRound2Platform`, `codebox/tests/round2.test.js`) |
| FV-10 | Requires manual action | OWNER_ACTION_REQUIRED | yes | Still uncommitted |
| Round-2 items: stale boxes, Redis hang, one-shot hole | Fixed | VERIFIED_FIXED | yes, except snapshots (R2V-4) | §3.2, §3.4, the attack E2E Redis test |

**Counts.** These cover the 32 original findings plus N1–N5 and FV-1 to FV-10, with SA-M6/FV-3 and SA-L9/FV-4 counted once each:

| Status | Count | Findings |
|---|---|---|
| VERIFIED_FIXED | 20 | SA-H1, H4, H5, M1, M2, M6, M8, L2, L4, L5, L6, L9; N1–N4; FV-2, FV-7, FV-8, FV-9 |
| PARTIALLY_FIXED | 12 | SA-H2, M4, L1, L3, L7, L8, I3, I6, I7; FV-1, FV-5, FV-6 |
| OWNER_ACTION_REQUIRED | 9 | SA-H3, H6, M3, M5, M7, L10, L11, I2; FV-10 |
| NOT_APPLICABLE | 4 | SA-I1, I4, I5; N5 |
| NOT_FIXED | 0 | |
| REGRESSION_INTRODUCED | 0 | |

That is 45 findings in total (32 original + N1–N5 + FV-1 to FV-10, less FV-3 and FV-4 merged into SA-M6 and SA-L9). Section 6 adds 9 new findings.

---

## 6. New findings (this verification)

| ID | Severity | Component | Status | Finding and evidence | Recommended action |
|---|---|---|---|---|---|
| **R2V-1** | **Medium** | Backend scheduler / account abuse | NOT_FIXED | **Fresh-account waves still deny judging.**<br>• 24 fresh accounts: the first other user gets 503 after 30 s.<br>• 16 accounts: 27.3 s.<br>• A returning user with history: 23.5 s, served behind the fresh attackers.<br>"Lightest user first" treats every brand-new account as the lightest, and the first-slot timeout is 30 s. Each wave needs fresh accounts: 30 per IP per 15 minutes. | Treat unknown and new accounts as a separate class: cap their combined concurrent blind requests, so they cannot fill every slot; rank users with a good history ahead of brand-new ones; per-IP or ASN caps on blind requests; email verification or CAPTCHA (SA-M4). Raising capacity only raises the number of accounts needed. |
| **R2V-2** | **Medium** | Backend `authLimiter` (pre-existing; not covered by round 2's FV-5 fix) | NOT_FIXED | **Login and registration share 30 attempts per IP per 15 minutes.** The 31st student behind one NAT is refused (measured 30/30), registrations are refused after that, and one person flooding login blocks every login from that IP for 15 minutes. | Key login throttling per account and IP with a high per-IP ceiling; CAPTCHA or a proof-of-work step after a per-IP threshold instead of a hard 429; a separate registration budget |
| **R2V-3** | Low–Medium | C/C++ multi-case harness path | PARTIALLY_FIXED | Not attack-tested in round 2 (`judgeDos.e2e.js` disables multi-case). 4 sleeping C++ accounts made a legitimate Run wait **21.6 s** (batch path: ≤ 7.1 s). After the first request, a harness round may take up to 16 s, and the round size does not shrink after a failure. | Apply adaptive sizing and the post-failure budget to harness rounds (a smaller budget after a failure or for slow per-case cost); add a harness variant to `judgeDos.e2e.js` |
| **R2V-4** | Low | CodeBox worker crash cleanup | NOT_FIXED | After a worker crash, `/tmp/codebox-batch-*` snapshot directories holding the crashed job's `main.py` (user source code) remain. `cleanupStaleBoxes` removes isolate boxes only. Not reachable from sandboxes; removed when the container is recreated. | Remove stale `codebox-batch-*` directories at worker start; add the check to the crash E2E |
| **R2V-5** | Low | CodeBox API logging | NOT_FIXED | One log line per request: 3,000 lines for 3,000 rejected requests (2,980 of them 429). JSON-escaped, so no injection, but unbounded volume once CodeBox is publicly hosted. | Sample or rate-limit the request log (as the backend now does); never log 429s individually |
| R2V-6 | Low | Readiness probe limiter | NOT_FIXED | `/health/ready` and `/api/health/ready` share one 120-per-minute bucket per IP. A probe that shares an IP with a flooder gets 429 and can take an instance out of rotation. | Exempt internal probe sources, or serve readiness on an internal port |
| R2V-7 | Info | Background profiler | NOT_FIXED (disabled) | `src/profiling/profiler.js` calls CodeBox directly: no judge slot, no tenant header (untagged cap 1,000, no budget). Disabled in `.env` and by default. | Route it through `withExecutionSlot` and a "system" tenant before enabling |
| R2V-8 | Info | Sandbox | NOT_APPLICABLE | `/usr/local/etc/isolate` (cg_root, uid range) is readable inside the box. No secret. | None required |
| R2V-9 | Info | Documents | OWNER_ACTION_REQUIRED | This file is not git-ignored; `AGENTS.md` is untracked and not ignored | Ignore them, or review them before any commit |

---

## 7. Test re-runs (independent, on the final working tree)

| Suite | Result | Note |
|---|---|---|
| Backend full suite (throwaway Postgres + isolated CodeBox), 49 files | 186 tests: **176 passed, 0 failed, 10 skipped** | 9 skips are `judgeDos.e2e.js` (opt-in, run separately). The 10th is `codeboxComparison.e2e.js`, which skipped itself because an earlier unauthenticated flood had used CodeBox's per-IP budget. Re-run alone: **1/1, 70 scenario rows PASS**. |
| Backend `judgeDos.e2e.js`, with disruptive steps | **9/9** | Same results as round 2 |
| CodeBox `sandbox.e2e.test.js`, with disruptive steps | **11/11** | |
| CodeBox unit tests (Linux image) | **37/37** | |
| CodeBox `api.test.js` | 13/14, then **14/14** on re-run | The first run hit the unauthenticated limit left by the 21-check flood (ordering) |
| CodeBox 21-check E2E | **20/21** | The failure is R2V-4: snapshots left by the earlier crash tests. Round 2 ran this before its crash tests. |
| Additional attacks (§3) | as reported | `attack.mjs`, `platform-attacks.mjs`, `classroom.mjs`, `local-probes.mjs` |

---

## 8. Not verifiable from here

These stay unverified until the owner checks them:
- the deployed backend and frontend versions;
- host environment variables;
- the proxy and CDN topology, and whether `TRUST_PROXY` matches it;
- whether hosted environments still reference the old CodeBox IP;
- credential rotation;
- current GitHub repository visibility;
- the Neon role in use, PITR and backups;
- a production CodeBox host with HTTPS, a firewall, a private token, a Redis password and an isolate version;
- monitoring and alerting;
- edge rate limiting;
- production capacity.

Local results do not establish production readiness.

---

## 9. Owner checklist

**Before any untrusted access, including staging:**
1. Rotate every credential in the `.env` notes and delete those lines. Staging gets fresh secrets.
2. Repository visibility: make the repositories private, or keep every security document out of them. Add `FINAL_SECURITY_VERIFICATION_ROUND2.md` and, after review, `AGENTS.md` to `.gitignore`.
3. Review the uncommitted changes and commit them to a branch (FV-10).
4. Set the staging and production environment:
   - `NODE_ENV=production`;
   - the real `TRUST_PROXY` hop count;
   - `JWT_EXPIRES_IN=1d`;
   - 32-character `OAUTH_STATE_SECRET` and `CODEBOX_TOKEN`;
   - an HTTPS `CODEBOX_URL`.
5. Set a private `CODEBOX_LOCAL_TOKEN`, and the same value as the backend's `CODEBOX_TOKEN`.

**Before production:**

6. Decide on R2V-1 (new-account class limits, verification or CAPTCHA) and R2V-2 (login throttling per account and IP). Both are engineering or product work, not configuration.
7. Fix R2V-3 (harness round sizing), R2V-4 (snapshot cleanup) and R2V-5 (CodeBox log sampling), and re-run the attack E2E with a C++ variant.
8. Apply the least-privilege database role on a Neon branch, then production; confirm PITR.
9. Re-host CodeBox with `docker-compose.prod.yml`: HTTPS, firewall, private token, Redis password, sized capacity, and `JUDGE_MAX_CONCURRENT` to match. Check hosted environments for the old IP.
10. Deploy to staging, re-run `judgeDos.e2e.js` and `sandbox.e2e.test.js` against the **staging** CodeBox, then production.
11. Product decisions: leaderboard fields (SA-L10); password reset, verification and MFA (SA-L11).

---

## 10. Verdict

**Staging: READY FOR STAGING WITH CONDITIONS.** Conditions:
- checklist items 1–5 are done;
- staging is not open to public registration while R2V-1 and R2V-2 are open: invite-only, or registration capped;
- staging runs the round-2 CodeBox (the tenant controls need it) on its own Neon branch.

**Production: NOT READY FOR PRODUCTION.** The production claim waits on two groups of work:
- **Owner actions:** credentials, GitHub visibility, the database role and PITR, hosting, firewall, HTTPS and deployment.
- **Engineering or product decisions:** R2V-1 and R2V-2, both reproduced Medium-severity availability gaps.

**What round 2 achieved is real and reproducible:**
- process trees are killed at timeouts;
- ZIP attacks are blocked;
- readiness floods cost the database almost nothing;
- backend logs are bounded;
- signed-in campus traffic is unaffected;
- four sleeping accounts no longer lock everyone out.

**What it overstated:**
- that sleeping submissions cannot monopolize the judge at all (R2V-1);
- that shared-IP users are unaffected, which is false for login and registration (R2V-2);
- the boundedness of the C/C++ harness path (R2V-3);
- the completeness of crash cleanup (R2V-4).
