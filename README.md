# Calibr8 Backend API ⚡

[![Node.js](https://img.shields.io/badge/Node.js-22.x-339933?logo=node.js)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-5.x-000000?logo=express)](https://expressjs.com)
[![Prisma](https://img.shields.io/badge/Prisma-6.x-2D3748?logo=prisma)](https://www.prisma.io)
[![Tests](https://img.shields.io/badge/Tests-38%2F38%20Passing-brightgreen?logo=node.js)](https://nodejs.org/api/test.html)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

High-performance, production-grade backend engine powering the **Calibr8** developer evaluation platform. Calibr8 provides competitive programming assessment, automated DSA skill calibration, multi-tier code execution, structured CS curriculum study with interactive MCQs, gamified coin rewards, IST-synchronized streak tracking, and global academic leaderboards.

---

## 🌟 Key Features

- **🔐 Robust Authentication & Session Management**:
  - Secure registration with password byte-length validation (min 8 chars, max 72 bytes to avoid bcrypt truncation attacks).
  - Case-insensitive email normalization and salted bcrypt hashing (10 rounds).
  - Cryptographically signed JWT tokens (1-day validity) with persistent revocation blacklisting on logout.
  - Profile management, academic background tracking (college, batch, branch, state, country), and preferred language selection.

- **⚡ Multi-Tier Code Execution Engine**:
  - Direct integration with CodeBox / Judge0 runner across 5 languages: **C++ (GCC 13 / C++20)**, **C (GCC 13)**, **Java (OpenJDK 17)**, **Python 3.10**, and **JavaScript (Node.js 22)**.
  - **Function-Only Enforcement**: Rejects user submissions defining custom `main()` functions to maintain platform isolation.
  - **True Tier Short-Circuiting**: Testcases are evaluated in progressive tiers (Tier 1: Sample/Brute-Force ~35%, Tier 2: Medium ~70%, Tier 3: Optimal 100%). Any failure in an earlier tier immediately halts subsequent executions to conserve compute.
  - **Zero Information Leak**: Evaluation testcases (`isVisible: false`) are strictly redacted in API outputs.
  - **Standalone Complexity Analyzer**: Static AST parsing and empirical classification estimating Time & Space $O$-notation with confidence metrics.

- **🪙 Gamified Coin Economy & Streak Tracking**:
  - **Strict IST Boundary**: Daily milestones reset at `00:00:00 IST` (`UTC+5:30` / `Asia/Kolkata`) regardless of server or client local time.
  - **Daily Login Reward**: Awards `+1 coin` on the user's first login of each IST day.
  - **Daily Problem Reward**: Awards `+2 coins` and advances the streak by `+1` upon the first `ACCEPTED` submission for the day's designated problem.
  - **Audit Ledger**: Every coin transaction writes an immutable record to `CoinTransaction` with the updated balance after.
  - **Theme Store**: Users can spend coins to purchase and activate custom IDE editor themes (`Orbit`, `Arcade`, `Cyberpunk`, etc.).

- **🎯 DSA Skill Calibration & Adaptive Problems Catalog**:
  - Comprehensive problem repository (161 DSA problems) with starter code snippets, input/output drivers, and structured testcases.
  - Adaptive 1-click beginner presets and per-topic skill calibration (Easy, Medium, Hard).
  - Structured categorization (Arrays, Two Pointers, Sliding Window, Trees, Graphs, Dynamic Programming).

- **🎓 Computer Science Curriculum & Study Module**:
  - Comprehensive course content across 5 foundational subjects: Computer Networks, DBMS, Operating Systems, System Design, and Object-Oriented Programming.
  - Structured chapters, reading topics, and integrated multiple-choice question (MCQ) assessments with automated scoring and explanations.

- **🏆 Global & Academic Leaderboards**:
  - Real-time rankings computed from user rating, score units, and problem solve counts.
  - Filterable by college, batch year, state, and country.
  - Automated rating tier mapping: *Pulse*, *Flux*, *Prism*, *Aurora*, *Eclipse*, and *Zenith* across divisions *I*, *II*, and *III*.

- **🛡️ Enterprise Security & Resilience**:
  - Zero-database-leak test isolation (`DATABASE_URL = ""` falls back to high-fidelity in-memory store).
  - Strict Content Security Policy (CSP), `X-Content-Type-Options: nosniff`, and `Referrer-Policy: strict-origin-when-cross-origin`.
  - Rate limiting on authentication routes and max-concurrency in-flight execution limiters (2 concurrent jobs per client).
  - Safe OAuth callbacks with HMAC-SHA256 state signing and host white-listing against open-redirect exploits.

---

## 🏛️ System Architecture

```
                                  +-----------------------+
                                  |   HTTP Client / Web   |
                                  +-----------+-----------+
                                              |
                          +-------------------v-------------------+
                          |  Security & CORS Middlewares          |
                          |  (CSP, nosniff, Referrer, rateLimit)  |
                          +-------------------+-------------------+
                                              |
                          +-------------------v-------------------+
                          |           Express Routers             |
                          |     (/api/auth, /api/users, etc.)     |
                          +-------------------+-------------------+
                                              |
                   +--------------------------+--------------------------+
                   |                                                     |
       +-----------v-----------+                             +-----------v-----------+
       |   Protected Routes    |                             |     Public Routes     |
       |  (protect / optAuth)  |                             | (ping, health, topics)|
       +-----------+-----------+                             +-----------+-----------+
                   |                                                     |
                   +--------------------------+--------------------------+
                                              |
                                  +-----------v-----------+
                                  |      Controllers      |
                                  +-----------+-----------+
                                              |
                     +------------------------+------------------------+
                     |                                                 |
         +-----------v-----------+                         +-----------v-----------+
         |    Domain Services    |                         |   CodeBox Execution   |
         |  - streakService      |                         |  - executeCodeBatch   |
         |  - coinService        |                         |  - complexityAnalyzer |
         |  - dailyProblemService|                         +-----------+-----------+
         +-----------+-----------+                                     |
                     |                                                 |
                     +------------------------+------------------------+
                                              |
                                  +-----------v-----------+
                                  |    Prisma Client /    |
                                  |  InMemoryStore Proxy  |
                                  +-----------+-----------+
                                              |
                               +--------------+--------------+
                               |                             |
                      [Production Neon DB]          [InMemory Fallback]
                       (Live Deployments)            (Automated Tests)
```

---

## 📁 Repository Structure

```
.
├── prisma/
│   ├── schema.prisma              # Complete database schema
│   ├── migrations/                # Database migrations
│   └── seed.js                    # Database seed scripts
├── problems/                      # 161 Curated DSA problem definitions (JSON)
├── study-material/                # CS curriculum (CN, DBMS, OS, etc.)
│   ├── cn/                        # Computer Networks modules & MCQs
│   └── dbms/                      # Database Management Systems modules & MCQs
├── public/
│   └── index.html                 # Interactive Developer Console & Documentation Dashboard
├── src/
│   ├── server.js                  # Entry point (port 3000, 0.0.0.0)
│   ├── app.js                     # Express app setup & middleware configuration
│   ├── config/
│   │   ├── db.js                  # Prisma Client with Dual-Mode InMemoryStore proxy
│   │   └── jwt.js                 # JWT configuration
│   ├── controllers/               # 11 Domain controllers (auth, execution, coin, etc.)
│   ├── routers/                   # 12 Express routers mounted under /api/*
│   ├── middlewares/               # Auth, rate-limiting, concurrency, and error handling
│   ├── services/                  # Business services (coinService, streakService, etc.)
│   ├── data/                      # Theme catalog & topic definitions
│   └── utils/                     # 11 Utilities (codeBuilder, outputComparator, etc.)
├── tests/                         # 38 Automated test suites (100% passing)
├── API_DOC.md                     # Compact API reference & contract
├── APIdetails.md                  # Comprehensive 2300+ line frontend & agent integration guide
├── CODE_EXECUTION_SYSTEM_DOCUMENTATION.md # In-depth execution sandbox documentation
└── README_COIN.md                 # Coin rewards and streak quickstart guide
```

---

## 🚀 Getting Started

### 1. Prerequisites
- **Node.js**: v20.x or v22.x LTS
- **npm**: v10.x+

### 2. Installation
Clone the repository and install dependencies:
```bash
git clone https://github.com/Ayushchourasia03/Calibr8_Backend.git
cd Calibr8_Backend
npm install
```

### 3. Environment Configuration
Create a `.env` file based on `.env.example`:
```env
PORT=3000
NODE_ENV=development
DATABASE_URL="postgresql://user:password@host/database?sslmode=require"
JWT_SECRET="your-ultra-secure-jwt-secret-at-least-32-chars"
OAUTH_STATE_SECRET="your-ultra-secure-oauth-secret-at-least-32-chars"
FRONTEND_URL="http://localhost:5173,http://127.0.0.1:5173"
CODEBOX_URL="https://runner.calibr8.internal"
CODEBOX_TOKEN="your-codebox-token"
```

> **Note on Zero-Config Fallback**: If `DATABASE_URL` is omitted or left empty, the server automatically boots into **InMemoryStore** mode. You can run and test the complete platform locally without needing a PostgreSQL server!

### 4. Running the Development Server
```bash
npm run dev
```
The server will start on `http://localhost:3000`. Navigate to `http://localhost:3000/` in your browser to view the interactive Developer API Dashboard.

---

## 🧪 Testing Suite

Calibr8 includes an exhaustive automated test suite using Node.js's native test runner (`node --test`). Tests run in memory and never touch remote databases.

```bash
# Run all 38 test suites (full test suite)
npm test

# Run isolated unit tests
npm run test:unit

# Run full HTTP and business logic integration tests
npm run test:integration

# Run tests with experimental coverage reporter
npm run test:coverage
```

### Test Suite Breakdown
| Category | Suites | Coverage Areas |
|---|---|---|
| **Authentication & Users** | 4 | Registration, login, logout, password change, token refresh, academic profiles, activity maps |
| **Problems & Topics** | 4 | Problem filters, starter templates, hidden testcase redaction, DSA calibration |
| **Code Execution** | 6 | Multi-tier judging, batching (max 20 cases), verdicts (Accepted, WA, TLE, CE), AST complexity |
| **Coins & Streaks** | 6 | Daily login coin, Daily problem solve (+2 coins, +1 streak), IST midnight calculations |
| **Store & Themes** | 3 | Theme catalog, purchasing with coins, applying active themes, ownership persistence |
| **Rankings & Leaderboards** | 1 | Sorting by score, sensitive field omission, academic filters (college, batch, state) |
| **Study & Curriculum** | 1 | Subjects, chapters, topics, reading material, MCQ quizzes, automated scoring |
| **Social & Security** | 4 | GitHub OAuth URL signing, callback verification, CORS, CSP headers, rate limiters |
| **Pure Unit Utilities** | 2 | `ApiError`, `outputComparator`, `codeBuilder`, `userHeaderStats`, `successfulSubmissionActivity` |

---

## 📖 API Documentation

- **Interactive Web Dashboard**: Visit `http://localhost:3000/` while running the server to inspect, test, and execute all 54 endpoints directly in your browser.
- **Detailed Integration Guide**: See [`APIdetails.md`](./APIdetails.md) for 2,300+ lines of complete JSON payloads, TypeScript interfaces, and Axios/Fetch interceptor patterns.
- **Compact API Reference**: See [`API_DOC.md`](./API_DOC.md) for quick-glance route contracts and error taxonomy.
- **Code Execution Architecture**: See [`CODE_EXECUTION_SYSTEM_DOCUMENTATION.md`](./CODE_EXECUTION_SYSTEM_DOCUMENTATION.md) for driver harnesses, multi-tier batching, and sandbox security.
- **Coin & Streak Mechanics**: See [`README_COIN.md`](./README_COIN.md) for IST date boundaries and reward rules.

---

## 📄 License
This project is licensed under the [MIT License](LICENSE).