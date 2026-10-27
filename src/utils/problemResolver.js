import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import prisma from "../config/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROBLEMS_DIR = path.resolve(__dirname, "../../problems");

/**
 * Resolves a problem by slug, ID, or problemNumber.
 * Checks Prisma first; if database is unavailable or doesn't have the problem,
 * seamlessly loads from local problem definitions in /problems/*.json.
 */
export async function resolveProblem(slugOrId) {
  if (!slugOrId) return null;
  const isNum = /^\d+$/.test(String(slugOrId));
  const include = {
    testcases: { orderBy: { testIndex: "asc" } },
    templates: true,
  };

  let problem = null;

  // 1. Try Prisma DB query
  try {
    if (isNum) {
      problem = await prisma.problem.findUnique({
        where: { problemNumber: Number(slugOrId) },
        include,
      });
    } else {
      problem = await prisma.problem.findUnique({
        where: { slug: String(slugOrId).toLowerCase() },
        include,
      });
    }

    if (!problem && !isNum) {
      const all = await prisma.problem.findMany({ include });
      const target = String(slugOrId).toLowerCase();
      problem = all.find(
        (p) =>
          p.slug.toLowerCase() === target ||
          p.slug.replace(/-\d+$/, "").toLowerCase() === target ||
          String(p.id) === String(slugOrId)
      );
    }
  } catch (dbErr) {
    // Database connection notice in dev environment
    console.warn("[ProblemResolver] Prisma notice:", dbErr.message);
  }

  // 2. Fallback to /problems/*.json files if not in DB or missing testcases
  if (!problem || !problem.testcases || problem.testcases.length === 0) {
    try {
      const targetSlug = String(slugOrId).toLowerCase();
      if (fs.existsSync(PROBLEMS_DIR)) {
        const files = fs.readdirSync(PROBLEMS_DIR).filter((f) => f.endsWith(".json"));
        let matchFile = files.find(
          (f) => f.replace(".json", "").toLowerCase() === targetSlug
        );
        if (!matchFile) {
          matchFile = files.find(
            (f) =>
              f.replace(/-\d+\.json$/, "").toLowerCase() === targetSlug ||
              f.replace(".json", "").toLowerCase().includes(targetSlug)
          );
        }

        if (matchFile) {
          const raw = fs.readFileSync(path.join(PROBLEMS_DIR, matchFile), "utf-8");
          const data = JSON.parse(raw);
          const tcs = (data.testcases || []).map((tc, idx) => ({
            testIndex: tc.testIndex ?? idx,
            isVisible: tc.isVisible ?? tc.visible ?? true,
            stdinSmall: String(tc.stdinSmall ?? tc.input ?? ""),
            expectedSmall: String(tc.expectedSmall ?? tc.output ?? ""),
            input: String(tc.input ?? tc.stdinSmall ?? ""),
            output: String(tc.output ?? tc.expectedSmall ?? ""),
          }));

          const rawTemplates = data.templates || {};
          const tmpls = Object.entries(rawTemplates).map(([lang, code]) => ({
            language: lang,
            code: String(code),
          }));

          if (!problem) {
            problem = {
              id: `prob-${matchFile.replace(".json", "")}`,
              problemNumber: 1,
              slug: data.slug || matchFile.replace(".json", ""),
              title: data.title || matchFile.replace(".json", ""),
              description: data.description || data.title,
              difficulty: data.difficulty || "Easy",
              timeLimit: data.timeLimit || data.time_limit || 1000,
              memoryLimit: data.memoryLimit || data.memory_limit || 256,
              testcases: tcs,
              templates: tmpls,
              templatesMap: rawTemplates,
            };
          } else {
            problem.testcases = tcs;
            if (!problem.templates || problem.templates.length === 0) {
              problem.templates = tmpls;
              problem.templatesMap = rawTemplates;
            }
          }
        }
      }
    } catch (fsErr) {
      console.warn("[ProblemResolver] Local file read error:", fsErr.message);
    }
  }

  if (problem) {
    // Ensure templates map is populated
    if (!problem.templatesMap) {
      if (Array.isArray(problem.templates)) {
        problem.templatesMap = problem.templates.reduce((acc, t) => {
          acc[t.language] = t.code;
          return acc;
        }, {});
      } else {
        problem.templatesMap = problem.templates || {};
      }
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
    console.warn("[ProblemResolver] Prisma findMany notice:", dbErr.message);
  }

  // Fallback to /problems/*.json if DB returned no problems
  if (!problems || problems.length === 0) {
    if (fs.existsSync(PROBLEMS_DIR)) {
      const files = fs.readdirSync(PROBLEMS_DIR).filter((f) => f.endsWith(".json")).sort();
      problems = files.map((file, idx) => {
        try {
          const raw = fs.readFileSync(path.join(PROBLEMS_DIR, file), "utf-8");
          const data = JSON.parse(raw);
          const slug = data.slug || file.replace(".json", "");
          return {
            id: `prob-${slug}`,
            problemNumber: idx + 1,
            slug,
            title: data.title || slug,
            difficulty: data.difficulty || "Easy",
            timeLimit: data.timeLimit || data.time_limit || 1000,
            memoryLimit: data.memoryLimit || data.memory_limit || 256,
            _count: {
              testcases: (data.testcases || []).length,
              templates: Object.keys(data.templates || {}).length,
            },
          };
        } catch {
          return null;
        }
      }).filter(Boolean);
    }
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