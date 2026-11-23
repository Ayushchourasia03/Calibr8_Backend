import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import prisma from "../config/db.js";
import { getUserTemplate } from "./codeBuilder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const problemsDir = path.resolve(__dirname, "../../problems");
const pendingProblemLoads = new Map();

// Resolved problems (with all testcases/templates) are read-only after load and
// requested on every detail/run/submit call, so keep them briefly in memory.
const PROBLEM_CACHE_TTL_MS = Number(process.env.PROBLEM_CACHE_TTL_MS ?? 60_000);
const PROBLEM_CACHE_MAX_ENTRIES = 300;
// Problems carry every testcase: bound the cache by (approximate) bytes too.
const PROBLEM_CACHE_MAX_BYTES = Number(process.env.PROBLEM_CACHE_MAX_BYTES) || 64 * 1024 * 1024;
const problemCache = new Map(); // key -> { value, expiresAt, bytes }
let problemCacheBytes = 0;

function approxProblemBytes(problem) {
  let bytes = 4096;
  for (const tc of problem?.testcases || []) {
    bytes += (tc.stdinSmall?.length || 0) + (tc.expectedSmall?.length || 0) + 128;
  }
  for (const t of problem?.templates || []) bytes += (t.code?.length || 0) * 2;
  return bytes + (problem?.description?.length || 0);
}

function deleteProblemCacheEntry(key) {
  const entry = problemCache.get(key);
  if (!entry) return;
  problemCacheBytes -= entry.bytes || 0;
  problemCache.delete(key);
}

// Acceptance stats need a scan of all submissions: refreshed on their own,
// slower timer instead of on every catalog rebuild.
const STATS_CACHE_TTL_MS = Number(process.env.CATALOG_STATS_CACHE_TTL_MS ?? 5 * 60_000);
let statsCache = null; // { value: Map, expiresAt }
let pendingStatsLoad = null;

// Global catalog rows + acceptance stats (user-independent).
const CATALOG_CACHE_TTL_MS = Number(process.env.CATALOG_CACHE_TTL_MS ?? 30_000);
let catalogCache = null; // { value, expiresAt }
let pendingCatalogLoad = null;

// Bundled problem JSON files never change at runtime; read each one once.
const bundledTopicCache = new Map();

function readBundledProblemTopic(slug) {
  if (!slug) return null;
  if (bundledTopicCache.has(slug)) return bundledTopicCache.get(slug);
  let topic = null;
  try {
    const filePath = path.join(problemsDir, `${slug}.json`);
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      topic = raw.topic || (Array.isArray(raw.tags) ? raw.tags[0] : null) || null;
    }
  } catch {
    topic = null;
  }
  bundledTopicCache.set(slug, topic);
  return topic;
}

/**
 * Drops cached problem data so the next read hits the database.
 * Call after mutating a problem (e.g. solvedCount sync).
 */
export function invalidateProblemCache(problemId = null) {
  catalogCache = null;
  if (!problemId) {
    problemCache.clear();
    problemCacheBytes = 0;
    return;
  }
  for (const [key, entry] of problemCache) {
    if (entry.value?.id === problemId) deleteProblemCacheEntry(key);
  }
}

/**
 * After a solvedCount sync: patch the cached problems in place instead of
 * dropping them, so the next run/submit doesn't reload the problem and all its
 * testcases from the database just because one counter changed. The catalog
 * (problem list) is still rebuilt.
 */
export function updateCachedProblemSolvedCount(problemId, solvedCount) {
  catalogCache = null;
  if (!problemId || !Number.isFinite(Number(solvedCount))) {
    invalidateProblemCache(problemId);
    return;
  }
  for (const [key, entry] of problemCache) {
    if (entry.value?.id === problemId) {
      problemCache.set(key, { ...entry, value: { ...entry.value, solvedCount: Number(solvedCount) } });
    }
  }
}

/**
 * Resolves a problem by slug, ID, or problemNumber directly from PostgreSQL via Prisma.
 */
export async function resolveProblem(slugOrId) {
  if (!slugOrId) return null;
  const key = String(slugOrId).trim().toLowerCase();

  if (PROBLEM_CACHE_TTL_MS > 0) {
    const cached = problemCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (cached) deleteProblemCacheEntry(key);
  }

  const pending = pendingProblemLoads.get(key);
  if (pending) return pending;

  const load = resolveProblemUncached(slugOrId);
  pendingProblemLoads.set(key, load);
  try {
    const problem = await load;
    // Only cache hits; a miss may be a problem that is about to be uploaded.
    if (problem && PROBLEM_CACHE_TTL_MS > 0) {
      const bytes = approxProblemBytes(problem);
      if (bytes <= PROBLEM_CACHE_MAX_BYTES / 4) {
        deleteProblemCacheEntry(key);
        while (
          problemCache.size > 0 &&
          (problemCache.size >= PROBLEM_CACHE_MAX_ENTRIES || problemCacheBytes + bytes > PROBLEM_CACHE_MAX_BYTES)
        ) {
          deleteProblemCacheEntry(problemCache.keys().next().value);
        }
        problemCache.set(key, {
          value: problem,
          bytes,
          expiresAt: Date.now() + PROBLEM_CACHE_TTL_MS,
        });
        problemCacheBytes += bytes;
      }
    }
    return problem;
  } finally {
    pendingProblemLoads.delete(key);
  }
}

async function resolveProblemUncached(slugOrId) {
  const isNum = /^\d+$/.test(String(slugOrId));
  const queryStr = String(slugOrId).trim().toLowerCase();

  const include = {
    examples: { orderBy: { order: "asc" } },
    testcases: { orderBy: { testIndex: "asc" } },
    templates: true,
  };

  let problem = null;

  if (isNum) {
    problem = await prisma.problem.findUnique({
      where: { problemNumber: Number(slugOrId) },
      include,
    });
  } else {
    problem = await prisma.problem.findUnique({
      where: { slug: queryStr },
      include,
    });
  }

  if (!problem && !isNum) {
    const baseSlug = queryStr.replace(/-\d+$/, "");
    problem = await prisma.problem.findFirst({
      where: {
        OR: [
          { slug: queryStr },
          ...(baseSlug === queryStr ? [] : [{ slug: baseSlug }]),
          { id: String(slugOrId) },
        ],
      },
      include,
    });
  }

  if (problem) {
    if (Array.isArray(problem.templates)) {
      problem.templatesMap = problem.templates.reduce((acc, t) => {
        let tmplObj = t.code;
        if (t.header || t.footer) {
          tmplObj = {
            userTemplate: t.code,
            header: t.header || "",
            footer: t.footer || "",
          };
        } else if (typeof t.code === "string" && t.code.trim().startsWith("{")) {
          try {
            const parsed = JSON.parse(t.code.trim());
            if (
              parsed &&
              typeof parsed === "object" &&
              (parsed.userTemplate !== undefined ||
                parsed.header !== undefined ||
                parsed.footer !== undefined)
            ) {
              tmplObj = parsed;
            }
          } catch {
            // Keep raw template string if not valid JSON
          }
        }
        acc[t.language] = tmplObj;
        return acc;
      }, {});
    } else {
      problem.templatesMap = problem.templates || {};
    }

    problem.userTemplates = {};
    Object.keys(problem.templatesMap).forEach((lang) => {
      problem.userTemplates[lang] = getUserTemplate(problem, lang);
    });
  }

  return problem;
}

/**
 * Lists problems from PostgreSQL with optional catalog filters and user solve status.
 */
export async function listAllProblems({
  difficulty,
  search,
  topic,
  status,
  userId,
} = {}) {
  const [catalog, solvedProblemIds] = await Promise.all([
    loadCatalog(),
    userId ? loadSolvedProblemIds(userId) : Promise.resolve(new Set()),
  ]);

  let problems = catalog.map((problem) => ({
    ...problem,
    isSolved: solvedProblemIds.has(problem.id),
  }));

  if (difficulty) {
    const wanted = String(difficulty).trim().toLowerCase();
    problems = problems.filter(
      (p) => String(p.difficulty || "").toLowerCase() === wanted,
    );
  }

  return filterCatalog(problems, { search, topic, status });
}

async function loadSolvedProblemIds(userId) {
  // Statuses are always written upper-case; an exact match lets PostgreSQL use
  // the (userId, status) index instead of a case-insensitive scan.
  const solved = await prisma.submission.findMany({
    where: { userId, status: "ACCEPTED", totalCount: { gt: 0 } },
    distinct: ["problemId"],
    select: { problemId: true },
  });
  return new Set(solved.map(({ problemId }) => problemId));
}

async function loadCatalog() {
  if (CATALOG_CACHE_TTL_MS > 0 && catalogCache && catalogCache.expiresAt > Date.now()) {
    return catalogCache.value;
  }
  if (pendingCatalogLoad) return pendingCatalogLoad;

  pendingCatalogLoad = loadCatalogUncached()
    .then((value) => {
      if (CATALOG_CACHE_TTL_MS > 0) {
        catalogCache = { value, expiresAt: Date.now() + CATALOG_CACHE_TTL_MS };
      }
      return value;
    })
    .finally(() => {
      pendingCatalogLoad = null;
    });
  return pendingCatalogLoad;
}

async function loadCatalogUncached() {
  const problems = await prisma.problem.findMany({
    orderBy: { problemNumber: "asc" },
    select: {
      id: true,
      problemNumber: true,
      slug: true,
      title: true,
      difficulty: true,
      tags: true,
      solvedCount: true,
      createdAt: true,
      dsaTopic: { select: { name: true, slug: true } },
      timeLimit: true,
      memoryLimit: true,
      _count: { select: { examples: true, testcases: true, templates: true } },
    },
  });

  const submissionsByProblem = problems.length > 0 ? await loadAcceptanceStats() : new Map();

  return problems.map((problem) => {
    const stats = submissionsByProblem.get(problem.id);
    const resolvedTopic =
      problem.dsaTopic?.name ||
      problem.tags?.[0] ||
      readBundledProblemTopic(problem.slug) ||
      "Other";
    const tags =
      Array.isArray(problem.tags) && problem.tags.length > 0
        ? problem.tags
        : resolvedTopic !== "Other"
          ? [resolvedTopic]
          : [];
    return {
      ...problem,
      topic: resolvedTopic,
      topicSlug:
        problem.dsaTopic?.slug ||
        String(resolvedTopic)
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, ""),
      tags,
      acceptanceRate:
        stats?.total > 0
          ? Math.round((stats.accepted / stats.total) * 1000) / 10
          : null,
      points: pointsForDifficulty(problem.difficulty),
    };
  });
}

async function loadAcceptanceStatsUncached() {
  // All problems are included, so no IN (...) list is needed.
  const submissionGroups = await prisma.submission.groupBy({
    by: ["problemId", "status"],
    _count: { _all: true },
  });
  const byProblem = new Map();
  for (const group of submissionGroups) {
    const current = byProblem.get(group.problemId) || { accepted: 0, total: 0 };
    current.total += group._count._all;
    if (String(group.status).toUpperCase() === "ACCEPTED") {
      current.accepted += group._count._all;
    }
    byProblem.set(group.problemId, current);
  }
  return byProblem;
}

function loadAcceptanceStats() {
  if (STATS_CACHE_TTL_MS > 0 && statsCache && statsCache.expiresAt > Date.now()) {
    return Promise.resolve(statsCache.value);
  }
  if (pendingStatsLoad) return pendingStatsLoad;
  pendingStatsLoad = loadAcceptanceStatsUncached()
    .then((value) => {
      if (STATS_CACHE_TTL_MS > 0) statsCache = { value, expiresAt: Date.now() + STATS_CACHE_TTL_MS };
      return value;
    })
    .finally(() => {
      pendingStatsLoad = null;
    });
  return pendingStatsLoad;
}

function filterCatalog(problems, { search, topic, status }) {
  if (typeof search === "string" && search.trim()) {
    const q = search.trim().toLowerCase();
    problems = problems.filter(
      (p) =>
        String(p.title || "")
          .toLowerCase()
          .includes(q) ||
        String(p.slug || "")
          .toLowerCase()
          .includes(q) ||
        String(p.problemNumber).includes(q) ||
        String(p.topic || "")
          .toLowerCase()
          .includes(q) ||
        String(p.difficulty || "")
          .toLowerCase()
          .includes(q) ||
        (p.tags || []).some((tag) => String(tag).toLowerCase().includes(q)),
    );
  }

  if (topic) {
    const selectedTopic = String(topic).trim().toLowerCase();
    problems = problems.filter(
      (p) =>
        String(p.topic || "")
          .trim()
          .toLowerCase() === selectedTopic,
    );
  }

  if (status === "solved") {
    problems = problems.filter((p) => p.isSolved);
  } else if (status === "todo") {
    problems = problems.filter((p) => !p.isSolved);
  } else if (status) {
    throw new Error(`Unsupported problem status filter: ${status}`);
  }

  return problems;
}

function pointsForDifficulty(difficulty) {
  const normalized = String(difficulty || "").toLowerCase();
  if (normalized === "medium") return 25;
  if (normalized === "hard") return 50;
  return 10;
}
