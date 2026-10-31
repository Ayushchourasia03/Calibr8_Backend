import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import prisma from "../config/db.js";
import { getUserTemplate } from "./codeBuilder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROBLEMS_DIR = path.resolve(__dirname, "../../problems");
const RESOLVED_CACHE_TTL_MS = 60 * 1000;
const RESOLVED_CACHE_MAX_SIZE = 256;
const resolvedProblemCache = new Map();
const pendingProblemLoads = new Map();

// In-memory cache of local problems loaded from /problems/*.json
let cachedProblems = null;
let problemIndexBySlug = new Map();
let problemIndexByNumber = new Map();
let problemIndexById = new Map();

/**
 * Loads and indexes all JSON problem definitions from /problems
 */
function loadLocalProblems() {
  if (cachedProblems) return cachedProblems;

  const list = [];
  problemIndexBySlug.clear();
  problemIndexByNumber.clear();
  problemIndexById.clear();

  if (!fs.existsSync(PROBLEMS_DIR)) {
    cachedProblems = [];
    return cachedProblems;
  }

  const files = fs
    .readdirSync(PROBLEMS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  files.forEach((file, idx) => {
    try {
      const raw = fs.readFileSync(path.join(PROBLEMS_DIR, file), "utf-8");
      const data = JSON.parse(raw);
      const fileSlug = file.replace(".json", "");
      const slug = data.slug || fileSlug;
      const id = data.id || `prob-${slug}`;
      const num = data.problemNumber || idx + 1;

      const tcs = (data.testcases || []).map((tc, tIdx) => ({
        testIndex: tc.testIndex ?? tIdx,
        isVisible: tc.isVisible ?? tc.visible ?? true,
        stdinSmall: String(tc.stdinSmall ?? tc.input ?? ""),
        expectedSmall: String(tc.expectedSmall ?? tc.output ?? ""),
        input: String(tc.input ?? tc.stdinSmall ?? ""),
        output: String(tc.output ?? tc.expectedSmall ?? ""),
      }));

      const rawTemplates = data.templates || {};
      const tmplsArray = Object.entries(rawTemplates).map(([lang, val]) => ({
        language: lang,
        code:
          typeof val === "object"
            ? val.userTemplate || val.code || ""
            : String(val),
        header: typeof val === "object" ? val.header : "",
        footer: typeof val === "object" ? val.footer : "",
      }));

      // Map of user-only templates for clean editor delivery
      const userTemplates = {};
      Object.keys(rawTemplates).forEach((lang) => {
        const val = rawTemplates[lang];
        userTemplates[lang] =
          typeof val === "object"
            ? val.userTemplate || val.code || ""
            : String(val);
      });

      const p = {
        id,
        problemNumber: num,
        slug,
        title: data.title || slug,
        description: data.description || data.title || slug,
        difficulty: data.difficulty || "Easy",
        topic: data.topic || "Core",
        timeLimit: data.timeLimit || data.time_limit || 1000,
        memoryLimit: data.memoryLimit || data.memory_limit || 256,
        testcases: tcs,
        templates: tmplsArray,
        templatesMap: rawTemplates,
        userTemplates,
      };

      list.push(p);

      // Indexing aliases
      const lowerSlug = slug.toLowerCase();
      const lowerFileSlug = fileSlug.toLowerCase();
      const baseSlug = lowerSlug.replace(/-\d+$/, "");
      const baseFileSlug = lowerFileSlug.replace(/-\d+$/, "");

      problemIndexBySlug.set(lowerSlug, p);
      problemIndexBySlug.set(lowerFileSlug, p);
      if (!problemIndexBySlug.has(baseSlug))
        problemIndexBySlug.set(baseSlug, p);
      if (!problemIndexBySlug.has(baseFileSlug))
        problemIndexBySlug.set(baseFileSlug, p);

      problemIndexByNumber.set(num, p);
      problemIndexById.set(String(id), p);
    } catch (e) {
      console.warn(
        `[ProblemResolver] Error loading problem file ${file}:`,
        e.message,
      );
    }
  });

  cachedProblems = list;
  return cachedProblems;
}

/**
 * Resolves a problem by slug, ID, or problemNumber.
 * Checks Prisma first (if DB is active); seamlessly falls back to indexed /problems/*.json.
 */
export async function resolveProblem(slugOrId) {
  if (!slugOrId) return null;
  const cacheKey = String(slugOrId).trim().toLowerCase();
  const cached = resolvedProblemCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.problem;
  if (cached) resolvedProblemCache.delete(cacheKey);

  const pending = pendingProblemLoads.get(cacheKey);
  if (pending) return pending;

  const load = resolveProblemUncached(slugOrId);
  pendingProblemLoads.set(cacheKey, load);
  try {
    const problem = await load;
    if (problem) {
      if (resolvedProblemCache.size >= RESOLVED_CACHE_MAX_SIZE) {
        resolvedProblemCache.delete(resolvedProblemCache.keys().next().value);
      }
      resolvedProblemCache.set(cacheKey, {
        problem,
        expiresAt: Date.now() + RESOLVED_CACHE_TTL_MS,
      });
    }
    return problem;
  } finally {
    pendingProblemLoads.delete(cacheKey);
  }
}

async function resolveProblemUncached(slugOrId) {
  const isNum = /^\d+$/.test(String(slugOrId));
  const queryStr = String(slugOrId).trim().toLowerCase();

  let problem = null;

  // 1. Try Prisma DB query if database connection is available
  try {
    const include = {
      testcases: { orderBy: { testIndex: "asc" } },
      templates: true,
    };

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
  } catch (dbErr) {
    // Database connection notice in dev environment
  }

  // 2. Fallback to /problems/*.json files if not in DB or missing testcases
  if (!problem || !problem.testcases || problem.testcases.length === 0) {
    loadLocalProblems();

    if (isNum && problemIndexByNumber.has(Number(slugOrId))) {
      problem = problemIndexByNumber.get(Number(slugOrId));
    } else if (problemIndexBySlug.has(queryStr)) {
      problem = problemIndexBySlug.get(queryStr);
    } else if (problemIndexById.has(String(slugOrId))) {
      problem = problemIndexById.get(String(slugOrId));
    } else {
      const base = queryStr.replace(/-\d+$/, "");
      if (problemIndexBySlug.has(base)) {
        problem = problemIndexBySlug.get(base);
      }
    }
  }

  if (problem) {
    // If problem came from DB or needs template enhancement, check local problem definitions
    loadLocalProblems();
    const localMatch =
      problemIndexBySlug.get(problem.slug?.toLowerCase()) ||
      problemIndexById.get(String(problem.id));

    // Populate templatesMap preserving rich structured templates
    if (
      !problem.templatesMap ||
      Object.keys(problem.templatesMap).length === 0
    ) {
      if (Array.isArray(problem.templates)) {
        problem.templatesMap = problem.templates.reduce((acc, t) => {
          let tmplObj = t.code;
          if (t.header || t.footer) {
            tmplObj = {
              userTemplate: t.code,
              header: t.header || "",
              footer: t.footer || "",
            };
          } else if (
            typeof t.code === "string" &&
            t.code.trim().startsWith("{")
          ) {
            try {
              const parsed = JSON.parse(t.code.trim());
              if (parsed.header !== undefined || parsed.footer !== undefined) {
                tmplObj = parsed;
              }
            } catch {}
          }
          acc[t.language] = tmplObj;
          return acc;
        }, {});
      } else {
        problem.templatesMap = problem.templates || {};
      }
    }

    // Merge with local rich templates (e.g. headers and drivers) if local problem has them
    if (localMatch && localMatch.templatesMap) {
      for (const [lang, val] of Object.entries(localMatch.templatesMap)) {
        if (typeof val === "object" && (val.header || val.footer)) {
          problem.templatesMap[lang] = val;
        } else if (!problem.templatesMap[lang]) {
          problem.templatesMap[lang] = val;
        }
      }
    }

    if (!problem.userTemplates) {
      problem.userTemplates = {};
      Object.keys(problem.templatesMap).forEach((lang) => {
        problem.userTemplates[lang] = getUserTemplate(problem, lang);
      });
    }
  }

  return problem;
}

/**
 * Lists real problems with optional catalog filters and user solve status.
 */
export async function listAllProblems({
  difficulty,
  search,
  topic,
  status,
  userId,
} = {}) {
  let problems = [];
  let submissionsByProblem = new Map();
  let solvedProblemIds = new Set();

  try {
    const where = {};
    if (difficulty) {
      where.difficulty = { equals: difficulty, mode: "insensitive" };
    }

    problems = await prisma.problem.findMany({
      where,
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
        _count: { select: { testcases: true, templates: true } },
      },
    });
  } catch (dbErr) {
    console.warn(
      "[ProblemResolver] Database problem lookup failed; using local problem definitions:",
      dbErr.message,
    );
    problems = [];
  }

  const problemIds = problems.map(({ id }) => id);
  const localProblemsBySlug = new Map(
    loadLocalProblems().map((problem) => [
      String(problem.slug).toLowerCase(),
      problem,
    ]),
  );
  if (problemIds.length > 0) {
    const [submissionGroups, solvedSubmissions] = await Promise.all([
      prisma.submission.groupBy({
        by: ["problemId", "status"],
        where: { problemId: { in: problemIds } },
        _count: { _all: true },
      }),
      userId
        ? prisma.submission.groupBy({
            by: ["problemId"],
            where: {
              userId,
              problemId: { in: problemIds },
              status: { equals: "ACCEPTED", mode: "insensitive" },
              totalCount: { gt: 0 },
            },
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);

    for (const group of submissionGroups) {
      const current = submissionsByProblem.get(group.problemId) || {
        accepted: 0,
        total: 0,
      };
      current.total += group._count._all;
      if (String(group.status).toUpperCase() === "ACCEPTED") {
        current.accepted += group._count._all;
      }
      submissionsByProblem.set(group.problemId, current);
    }

    if (userId) {
      solvedProblemIds = new Set(
        solvedSubmissions.map(({ problemId }) => problemId),
      );
    }
  }

  // Fallback to /problems/*.json if DB returned no problems
  if (!problems || problems.length === 0) {
    const local = loadLocalProblems();
    problems = local.map((p) => ({
      id: p.id,
      problemNumber: p.problemNumber,
      slug: p.slug,
      title: p.title,
      difficulty: p.difficulty,
      topic: p.topic,
      topicSlug: null,
      tags: p.tags || [],
      isSolved: false,
      acceptanceRate: null,
      points: pointsForDifficulty(p.difficulty),
      createdAt: null,
      timeLimit: p.timeLimit,
      memoryLimit: p.memoryLimit,
      _count: {
        testcases: (p.testcases || []).length,
        templates: Object.keys(p.templatesMap || {}).length,
      },
    }));
  } else {
    problems = problems.map((problem) => {
      const stats = submissionsByProblem.get(problem.id);
      const localProblem = localProblemsBySlug.get(
        String(problem.slug).toLowerCase(),
      );
      const topic =
        problem.dsaTopic?.name ||
        localProblem?.topic ||
        problem.tags?.[0] ||
        "Other";
      return {
        ...problem,
        topic,
        topicSlug:
          problem.dsaTopic?.slug ||
          String(topic)
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, ""),
        tags: problem.tags || [],
        isSolved: solvedProblemIds.has(problem.id),
        acceptanceRate:
          stats?.total > 0
            ? Math.round((stats.accepted / stats.total) * 1000) / 10
            : null,
        points: pointsForDifficulty(problem.difficulty),
      };
    });
  }

  if (difficulty) {
    problems = problems.filter(
      (p) =>
        String(p.difficulty).toLowerCase() === String(difficulty).toLowerCase(),
    );
  }

  if (search && search.trim()) {
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
