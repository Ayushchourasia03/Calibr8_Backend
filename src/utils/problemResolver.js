import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import prisma from "../config/db.js";
import { getUserTemplate } from "./codeBuilder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROBLEMS_DIR = path.resolve(__dirname, "../../problems");

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
        code: typeof val === "object" ? (val.userTemplate || val.code || "") : String(val),
        header: typeof val === "object" ? val.header : "",
        footer: typeof val === "object" ? val.footer : "",
      }));

      // Map of user-only templates for clean editor delivery
      const userTemplates = {};
      Object.keys(rawTemplates).forEach((lang) => {
        const val = rawTemplates[lang];
        userTemplates[lang] = typeof val === "object" ? (val.userTemplate || val.code || "") : String(val);
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
      if (!problemIndexBySlug.has(baseSlug)) problemIndexBySlug.set(baseSlug, p);
      if (!problemIndexBySlug.has(baseFileSlug)) problemIndexBySlug.set(baseFileSlug, p);

      problemIndexByNumber.set(num, p);
      problemIndexById.set(String(id), p);
    } catch (e) {
      console.warn(`[ProblemResolver] Error loading problem file ${file}:`, e.message);
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
      const all = await prisma.problem.findMany({ include });
      problem = all.find(
        (p) =>
          p.slug.toLowerCase() === queryStr ||
          p.slug.replace(/-\d+$/, "").toLowerCase() === queryStr ||
          String(p.id) === String(slugOrId)
      );
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
    if (!problem.templatesMap || Object.keys(problem.templatesMap).length === 0) {
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
 * Lists all problems with optional difficulty and search filter.
 */
export async function listAllProblems({ difficulty, search } = {}) {
  let problems = [];

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
        timeLimit: true,
        memoryLimit: true,
        _count: { select: { testcases: true, templates: true } },
      },
    });
  } catch (dbErr) {
    // Database findMany warning in dev environment
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
      timeLimit: p.timeLimit,
      memoryLimit: p.memoryLimit,
      _count: {
        testcases: (p.testcases || []).length,
        templates: Object.keys(p.templatesMap || {}).length,
      },
    }));
  }

  if (difficulty) {
    problems = problems.filter(
      (p) => String(p.difficulty).toLowerCase() === String(difficulty).toLowerCase()
    );
  }

  if (search && search.trim()) {
    const q = search.trim().toLowerCase();
    problems = problems.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.slug.toLowerCase().includes(q) ||
        String(p.problemNumber).includes(q)
    );
  }

  return problems;
}