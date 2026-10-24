


# Calibr8 PRD: Remaining Backend APIs and Required Changes

Prepared for: Ayush and team | Based on calibr8-app.html (frontend prototype) and the backend API document | Draft v0.1 | October 2026

## 1. Purpose and how to read this

The backend already covers accounts, topics, onboarding, problems, code execution, GitHub linking, CS study material and themes. The prototype shows many more screens: Today, Solve, Problems, Library, Tracks, Rankings, Profile and Store. This PRD lists:

1. What must be fixed in the existing APIs (section 2)
2. Every mismatch between the prototype and the backend (section 3)
3. Conventions for all new endpoints (section 4) and data model additions (section 5)
4. Every missing endpoint with its rules (section 6)
5. The business rules with their numbers (section 7), security checks, build order, acceptance checks and open questions

Priority tags: **P0** fix now, **P1** needed for the core loop, **P2** needed for the full product, **P3** later.

## 2. Fix first in the existing APIs (P0)

| # | Problem found | Why it matters | Fix |
| --- | --- | --- | --- |
| 1 | POST /api/problems has no auth | Anyone can create content | Admin-only role check; move to /api/admin/problems |
| 2 | GET /api/execution/submissions/:id has no auth | Anyone can read other students' code | Require login; owner only; return 404 otherwise |
| 3 | Run and Submit allow anonymous users | Every run costs judge time; nothing can be scored | Require login on both |
| 4 | Submit is synchronous and returns only passed and total counts | The UI and scoring need tiers, points and the strict multiplier | Make it asynchronous (202, then poll) with tier fields (section 6.2) |
| 5 | Logout blacklist lives in memory | Lost on restart; useless with two instances | Store revoked token ids (jti) in Postgres with an expiry date, or use short tokens plus refresh |
| 6 | JWT\_SECRET falls back to a development secret | Forged tokens if the variable is missing | Refuse to start in production when it is unset; keep OAUTH\_STATE\_SECRET separate |
| 7 | Error shapes differ (themes return an error key) | The frontend needs one handler | Always return success false, code, message and optional details |
| 8 | Register accepts any password | Weak passwords | Minimum 8, maximum 72 bytes, must differ from the email |
| 9 | No rate limits mentioned | Brute force and judge abuse | Per-IP and per-user limits (section 4) |
| 10 | GET /api/problems/:slug returns test cases | Risk of leaking hidden tests | Return only visible tests and never the expected output of hidden ones; add a test in CI |
| 11 | Study MCQ submit is unauthenticated | Progress cannot be saved | Require login (lesson reading can stay public) |
| 12 | Run returns a fixed studentStdout message | Hides the student's own prints | Return the real captured output (marker design from the Run and Submit PRD) |
| 13 | OAuth callback puts error text in the redirect URL | Leaks details; open redirect risk | Use short error codes and an allow-list for FRONTEND\_URL |
| 14 | JWT kept in browser storage | An XSS bug steals sessions | Short expiry (about 1 day) with refresh, strict CSP, never log tokens; httpOnly cookie later |

## 3. Mismatches between the prototype and the backend

These are the extra changes found by comparing the two.

**3.1 The server must own all progress (P1).** The prototype keeps score, coins, rating, streak, tier, owned themes, notes and activity in browser storage. Move all of it to server tables; the browser only displays. Never accept points, tier, coins or timing from the client.

**3.2 Tier must come from test tiers, not code analysis (P1).** The prototype decides the tier with a client-side complexity analyzer (or a keyword guess such as deque means tier 3), then applies space multipliers of 1, 0.95, 0.9 and 0.8 and a plus 10 coin bonus. That can be fooled and is not a judge. Decision: tier is the highest test tier passed. Keep the analyzer only for the post-solve complexity quiz and optional hints, never for points. Drop the space multiplier and bonus unless you measure memory on the judge.

**3.3 One topic list (P1).** Prototype topics: Arrays, Strings, Recursion, Graphs, Sliding Window, DP, SQL, Aptitude, Trees, Binary Search, Bit Manipulation, Heaps, Greedy, Verbal, OOPs, Networks. Backend: 5 DSA and 4 core topics named like DSA - Arrays, plus separate DSA categories such as arrays-and-hashing. Create one canonical topics table (slug, name, area, order, active) and treat categories as tags. Every API uses the topic slug.

**3.4 Day boundary and streak rules (P1).** The prototype computes the day from the UTC clock, which flips at 5:30 AM IST, and it never resets a streak after a missed day. Define the day in the user's time zone (default Asia/Kolkata, stored on the user). Streak: plus 1 when the daily question is completed that day; a missed day resets to 0 unless a freeze is available; store the longest streak too.

**3.5 Attempt source and mode (P1).** The prototype makes daily and stretch questions always strict, while the Problems list lets the student choose. The backend must enforce this using an attempt source (daily, stretch, practice, revision, track, library): daily and stretch are strict only, the others choose, and the mode is locked when the attempt opens.

**3.6 Solve ladder (P1).** The prototype keeps the best points per problem and credits only the difference. Store the best per user and problem on the server and credit the difference through the ledger.

**3.7 Hint cost.** The prototype uses cumulative penalties of 0, 5, 15 and 35 percent of the problem points, which equals levels costing 5, 10 and 20 percent each. Hints exist only in relaxed mode. Keep this and document it as cumulative.

**3.8 Rating update (P1).** The prototype uses expected = 1 / (1 + 10^((difficulty - rating) / 400)), results of 0, 0.4, 0.7 and 1.0 for tiers 0 to 3, and K = 60 for the first 10 solves, then 32. A failed stretch question changes nothing. Move this to the server and decide whether the overall rating is a plain average of topic ratings or weighted by solves.

**3.9 Calibration (P1).** The prototype ends calibration after 10 rated solves and 1,500 score units (150 points) and gives 3 free dry runs. Keep these values in configuration.

**3.10 Tier names and bands (P1).** The prototype uses Pulse, Flux, Prism, Aurora, Eclipse and Zenith, each 200 rating points wide starting at 700, with divisions I, II and III about 67 points each. The older design documents used different names and bands. Use the prototype's as the source and serve it through GET /api/config so the frontend never hardcodes it.

**3.11 Avatars (P2).** The prototype offers 10 emoji avatars; the backend plans a GitHub profile image. Model the avatar as a type (emoji or url) and a value.

**3.12 Theme slugs (P2).** The prototype uses mono and race; the backend seeds monochrome and racer. Pick one set of slugs and migrate.

**3.13 Languages (P1).** The prototype dropdown uses labels such as Python3; the backend keys are cpp, c, java, python and javascript. Use the backend keys with label and version from GET /api/execution/languages. Function-style problems need a driver per language, so ship Python and JavaScript first.

**3.14 Content size (P2).** The prototype generates 5,000 catalogue rows; the backend has 161 problems. Filtering, search and paging must be server-side from the start.

## 4. Conventions for every new endpoint

| Topic | Rule |
| --- | --- |
| Auth | Bearer token unless marked public |
| Ids | UUID strings; slugs where shown |
| Time | ISO 8601 UTC in responses; day boundaries computed in the user's time zone |
| Errors | success false, code, message and optional details. Codes: VALIDATION\_ERROR 400, UNAUTHENTICATED 401, FORBIDDEN 403, NOT\_FOUND 404, CONFLICT 409, UNPROCESSABLE 422, RATE\_LIMITED 429, INTERNAL 500, UNAVAILABLE 503 |
| Lists | page and pageSize (default 25, maximum 100); response includes total |
| Idempotency | Idempotency-Key header on submit, unlock, purchases, dry run and payments |
| Ownership | Every record with a userId is checked against the token; a mismatch returns 404 |
| Money and score | Changes happen only through ledger rows, never by editing a number |
| Client input | Never trust client-sent score, tier, coins or time |
| Rate limits | Auth 10 per minute per IP; Run 10 per minute; Submit 6 per minute; hints 20 per minute; dry run 5 per minute; everything else 120 per minute per user |

## 5. Data model additions

| Table or change | Key fields | Needed by |
| --- | --- | --- |
| users (extend) | role, timeZone, handle, avatarType, avatarValue, collegeId, collegeVerified, branch, batchYear, state, privacy | Profile, rankings, admin |
| topics (canonical) | slug, name, area, order, isActive | Everything |
| user\_topics | userId, topicId, level, rating, ratingDeviation, solves | Rating, daily |
| rating\_events | userId, topicId, before, after, problemId, result, at | Rating graph |
| attempts, submissions | mode, source, status, absences, bestTier, tierResults, points | Solve, scoring |
| score\_ledger, coin\_ledger, balances | amount, reason, refId, idempotencyKey | Scoring, store, unlock |
| daily\_assignments | userId, date, problemId, kind, index, doneAt | Daily, stretch |
| streaks, activity\_days | current, longest, freezesLeft; date and counts | Streak, calendar |
| revision\_items | userId, problemId, dueAt, step, reason | Revision |
| drafts, notes, reflections, hints\_used | per attempt or problem | Learning tools |
| dry\_runs | attemptId, input, traceKey, cost, creditUsed | Dry run |
| words, user\_words | content; learned dates | Word of the day |
| videos, video\_progress | segments, checkPassed | Videos |
| challenges, challenge\_progress | day, problemId, done | 30-day challenges |
| algorithms | slug, content, linked problems | Algorithms |
| badges, user\_badges | key, earnedAt | Badges |
| study\_progress | userId, topicSlug, bestScore | CS fundamentals |
| tracks, track\_progress, assessments | readiness, rounds, answers | Tracks |
| colleges, college\_verifications | name, domains; code, expiry | Rankings |
| friendships | userId, friendId | Friends board |
| share\_assets | type, status, url | Sharing |
| store\_items, purchases, payments | price, gateway reference | Store |
| problem\_reports, admin\_audit\_log | reason, status; actor, action | Content and admin |

## 6. API specifications

### 6.1 Today and progress (P1)

| Endpoint | Request | Response | Rules |
| --- | --- | --- | --- |
| GET /api/progress/summary | none | rating, overallRating, tier (name, division, color, progressToNext, nextName, nextAt), calibrating (active, solvesDone, solvesNeeded), score, coins, freeDryRuns, streak (current, longest), solvedCount | Tier computed on the server from the bands in config |
| GET /api/progress/topics | none | List of topic slug, name, level, rating, solvedCount, health (good, better, weak, notStarted) | Weakest first; health thresholds in config |
| GET /api/progress/rating-history | range (30d, 90d, all) | List of at and rating | Downsample to at most 200 points |
| GET /api/progress/calendar | month (YYYY-MM) or year (YYYY) | Days with date, submissions, dailyDone; monthly totals | Powers the month ring view and the annual heatmap |
| GET /api/streak | none | current, longest, weekDays (date, done, frozen), nextMilestone (7, 14, 30, 60, 100, 365), freezesLeft | Streak rules in section 3.4 |
| GET /api/daily | none | status (ready or done), question (slug, title, topic, points, difficultyLabel, mode strict), assignedFor, doneAt | First call of the day picks and stores the assignment; the same answer all day; target difficulty is topic rating minus 147; weighted toward weak topics; excludes solved problems |
| GET /api/daily/stretch/next | none | A question like the daily one, plus chainIndex | 403 STRETCH\_LOCKED until the daily is done; target difficulty about 120 above the daily target; failing costs nothing |
| GET /api/word-of-the-day | none | word, partOfSpeech, meaning, example, learnedToday, totalLearned | Word chosen by day index |
| POST /api/word-of-the-day/learned | none | totalLearned | Counts once per day |
| GET /api/revision | limit | Items with id, problemSlug, title, reason (failed or below tier 3), dueAt | Scheduled 3, 7 and 21 days after a failure or a result below tier 3; returned when due |
| PATCH /api/users/me/topics/:topicSlug | level (easy, medium, hard) | Updated topic row | Affects the next daily question, not today's; does not reset an existing rating |

### 6.2 Attempts and judging (P1)

| Endpoint | Request | Response | Rules |
| --- | --- | --- | --- |
| POST /api/attempts | problemSlug, mode, source; Idempotency-Key | attemptId, mode, state, rules (hints, dryRun, paste, awayLimitSeconds 15, maxAbsences 2, heartbeatSeconds 5), serverTime | Mode locked at open; daily and stretch must be strict; one open strict attempt per user (409 with the existing attemptId) |
| GET /api/attempts/:id | none | state (active, away, warned, locked, submitted, abandoned, final), absences, hintsUsed, bestTier, pointsAwarded | Owner only |
| POST /api/attempts/:id/abandon | revealSolution (relaxed only) | state | Frees the open attempt; strict abandon earns nothing |
| POST /api/attempts/:id/heartbeat | seq, visible, fullscreen, sentAt | state, absences, locked | Strict only; every 5 seconds; the server measures gaps; away longer than 15 seconds warns the first time and locks the second |
| POST /api/attempts/:id/telemetry | seq, events (type, ms, chars), typing summary | accepted | Strict only; never code text or key identities; reject gaps and duplicates |
| POST /api/attempts/:id/unlock | none; Idempotency-Key | coinsSpent, newBalance, state | Spends coins through the ledger (500 in the prototype, set in config); 400 NOT\_ENOUGH\_COINS |
| GET and PUT /api/attempts/:id/draft | language, code | savedAt | Autosave about every 10 seconds; at most 64 KB per attempt and language |
| POST /api/attempts/:id/hints | level (1 to 3) | hintText, costPercent, totalPenaltyPercent | Relaxed only (403 in strict); levels in order; each once; cumulative 5, 15, 35 percent |
| POST /api/execution/submissions | attemptId, language, code; Idempotency-Key | 202 with submissionId, status queued | Replaces the current synchronous version; attemptId required |
| GET /api/execution/submissions/:id | none | status (queued, running, done, error); progress (currentTier, tiersPassed); when done: verdict, tierReached, tierLabel (brute force, better, optimal), pointsAwarded, deltaPoints, coinsAwarded, multiplier, maxTimeMs, maxMemoryKb, compileOutput, firstFailure, ratingChange | Owner only; polled every second; hidden test data follows the visibility rules in the Run and Submit PRD |
| POST /api/execution/runs | problemSlug, language, code | Cases with input, expected, actual, studentStdout, status, timeMs | Login required; sample tests only; no score; allowed in both modes |
| POST /api/attempts/:id/reflection | text (up to 280 characters) | saved | After a solve; once per attempt; feeds the ideas-learned counter |
| POST /api/attempts/:id/complexity-quiz | timeAnswer, spaceAnswer | correct, correctAnswer, bonusPoints | Once per attempt; plus 2 points in the prototype; the correct answer comes from problem metadata, never from the analyzer |
| POST /api/attempts/:id/dry-run | input (sample index or custom text), language, code | dryRunId, status, cost (freeCredit or coins) | Relaxed only; free credit first, otherwise 20 coins; a failing test costs more; refund on failure; step limit 5,000 |
| GET /api/dry-runs/:id | none | Steps with line, variables, output, structure data | Owner only; traces expire after 30 days |
| GET /api/problems/:slug/solution | none | Brute, better and optimal approaches with complexity, common mistakes, thought process | 403 SOLUTION\_LOCKED until solved or abandoned with reveal; always locked during a strict attempt |
| GET and PUT /api/problems/:slug/notes | text (up to 5,000 characters) | text, updatedAt | Owner only; 403 while a strict attempt on that problem is open |
| GET /api/me/submissions | problem, page, pageSize | Rows with problemSlug, title, tier, points, mode, language, at | Powers recent submissions on the profile |
