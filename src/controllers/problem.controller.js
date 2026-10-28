import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import prisma from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";
import { getUserTemplate } from "../utils/codeBuilder.js";

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
          String(p.id) === String(slugOrId),
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
        const files = fs
          .readdirSync(PROBLEMS_DIR)
          .filter((f) => f.endsWith(".json"));
        const baseSlug = targetSlug.replace(/-\d+$/, "");

        let matchFile = files.find(
          (f) =>
            f.replace(".json", "").toLowerCase() === targetSlug ||
            f.replace(".json", "").toLowerCase() === baseSlug ||
            f.replace(/-\d+\.json$/, "").toLowerCase() === baseSlug,
        );

        if (!matchFile) {
          for (const file of files) {
            try {
              const raw = fs.readFileSync(
                path.join(PROBLEMS_DIR, file),
                "utf-8",
              );
              const d = JSON.parse(raw);
              if (
                d.slug?.toLowerCase() === targetSlug ||
                d.slug?.toLowerCase() === baseSlug ||
                file.toLowerCase().includes(baseSlug)
              ) {
                matchFile = file;
                break;
              }
            } catch (_) {}
          }
        }

        if (matchFile) {
          const raw = fs.readFileSync(
            path.join(PROBLEMS_DIR, matchFile),
            "utf-8",
          );
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
      const files = fs
        .readdirSync(PROBLEMS_DIR)
        .filter((f) => f.endsWith(".json"))
        .sort();
      problems = files
        .map((file, idx) => {
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
        })
        .filter(Boolean);
    }
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
        p.title.toLowerCase().includes(q) ||
        p.slug.toLowerCase().includes(q) ||
        String(p.problemNumber).includes(q),
    );
  }

  return problems;
}

export const getAllProblems = async (req, res, next) => {
  try {
    const data = await listAllProblems(req.query);
    res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  } catch (err) {
    next(err);
  }
};

export const getProblemBySlug = async (req, res, next) => {
  try {
    const problem = await resolveProblem(req.params.slug);
    if (!problem) {
      throw new ApiError(
        404,
        `Problem '${req.params.slug}' not found.`,
        "NOT_FOUND",
      );
    }

    const rawTemplates = problem.templatesMap || {};
    const userTemplates = {};
    for (const lang of Object.keys(rawTemplates)) {
      userTemplates[lang] = getUserTemplate(problem, lang);
    }

    const visibleTestcases = (problem.testcases || [])
      .filter((testcase) => testcase.isVisible === true)
      .map((testcase) => ({
        testIndex: testcase.testIndex,
        isVisible: true,
        input: testcase.stdinSmall ?? testcase.input ?? "",
        output: testcase.expectedSmall ?? testcase.output ?? "",
        stdinSmall: testcase.stdinSmall ?? testcase.input ?? "",
        expectedSmall: testcase.expectedSmall ?? testcase.output ?? "",
      }));

    res.status(200).json({
      success: true,
      data: {
        id: problem.id,
        problemNumber: problem.problemNumber,
        slug: problem.slug,
        title: problem.title,
        description: problem.description,
        difficulty: problem.difficulty,
        timeLimit: problem.timeLimit,
        memoryLimit: problem.memoryLimit,
        testcases: visibleTestcases,
        templates: userTemplates,
        userTemplates,
        templatesArray: problem.templates || [],
      },
    });
  } catch (err) {
    next(err);
  }
};

export const getProblemStarterTemplate = async (req, res, next) => {
  try {
    const problem = await resolveProblem(req.params.slug);
    if (!problem) {
      throw new ApiError(
        404,
        `Problem '${req.params.slug}' not found.`,
        "NOT_FOUND",
      );
    }

    const language = String(req.query.language || "")
      .trim()
      .toLowerCase();
    
    if (!language) {
      const userTemplates = {};
      for (const lang of Object.keys(problem.templatesMap || {})) {
        userTemplates[lang] = getUserTemplate(problem, lang);
      }
      return res
        .status(200)
        .json({ success: true, data: { slug: problem.slug, templates: userTemplates } });
    }

    const template = getUserTemplate(problem, language);
    if (!template) {
      throw new ApiError(
        404,
        `No ${language} template found for this problem.`,
        "NOT_FOUND",
      );
    }

    res.status(200).json({
      success: true,
      data: { slug: problem.slug, language, template },
    });
  } catch (err) {
    next(err);
  }
};

export const addProblem = async (req, res, next) => {
  try {
    if (req.user?.role !== "admin") {
      throw new ApiError(
        403,
        "Admin privileges required to create problems.",
        "FORBIDDEN",
      );
    }

    const {
      slug,
      title,
      description,
      difficulty = "Easy",
      timeLimit = 1000,
      memoryLimit = 256,
      testcases = [],
      templates = {},
    } = req.body;

    if (!slug || !title) {
      throw new ApiError(
        400,
        "slug and title are required for a problem.",
        "MISSING_FIELDS",
      );
    }

    const existing = await prisma.problem.findUnique({ where: { slug } });
    if (existing) {
      throw new ApiError(
        409,
        `Problem with slug '${slug}' already exists.`,
        "CONFLICT",
      );
    }

    const formattedTestcases = testcases.map((testcase, index) => {
      const input = String(testcase.stdinSmall ?? testcase.input ?? "");
      return {
        testIndex: testcase.testIndex ?? index,
        isVisible: Boolean(testcase.isVisible),
        stdinSmall: input,
        expectedSmall: String(testcase.expectedSmall ?? testcase.output ?? ""),
        sizeBytes: Buffer.byteLength(input, "utf-8"),
        r2Key: testcase.r2Key || null,
      };
    });

    const formattedTemplates = Array.isArray(templates)
      ? templates
      : Object.entries(templates).map(([language, code]) => ({
          language,
          code: String(code),
        }));

    const created = await prisma.problem.create({
      data: {
        slug,
        title,
        description: description || title,
        difficulty,
        timeLimit,
        memoryLimit,
        testcases: { create: formattedTestcases },
        templates: { create: formattedTemplates },
      },
      include: {
        testcases: true,
        templates: true,
        _count: { select: { testcases: true, templates: true } },
      },
    });

    res.status(201).json({ success: true, data: created });
  } catch (err) {
    next(err);
  }
};
