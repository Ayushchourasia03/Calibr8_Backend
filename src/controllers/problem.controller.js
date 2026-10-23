import prisma from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";

/**
 * GET /api/problems
 * Lists all problems with optional search and difficulty filtering.
 */
export const getAllProblems = async (req, res, next) => {
  try {
    const { difficulty, search } = req.query;

    let where = {};
    if (difficulty) {
      where.difficulty = { equals: difficulty, mode: "insensitive" };
    }

    let problems = await prisma.problem.findMany({
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

    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      problems = problems.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.slug.toLowerCase().includes(q) ||
          String(p.problemNumber).includes(q),
      );
    }

    res.status(200).json({
      success: true,
      count: problems.length,
      data: problems,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/problems/:slug
 * Fetches problem details with testcases and starter code templates.
 */
export const getProblemBySlug = async (req, res, next) => {
  try {
    const { slug } = req.params;
    const isNumber = /^\d+$/.test(String(slug));

    const where = isNumber
      ? { problemNumber: Number(slug) }
      : { slug: String(slug).toLowerCase() };

    let problem = await prisma.problem.findUnique({
      where,
      include: {
        testcases: {
          orderBy: { testIndex: "asc" },
        },
        templates: true,
      },
    });

    // If not found by exact slug, attempt fallback lookup
    if (!problem && !isNumber) {
      const all = await prisma.problem.findMany({
        include: {
          testcases: { orderBy: { testIndex: "asc" } },
          templates: true,
        },
      });
      problem = all.find(
        (p) =>
          p.slug.toLowerCase() === String(slug).toLowerCase() ||
          p.slug.replace(/-\d+$/, "").toLowerCase() ===
            String(slug).toLowerCase(),
      );
    }

    if (!problem) {
      throw new ApiError(404, `Problem '${slug}' not found.`);
    }

    const formatted = {
      id: problem.id,
      problemNumber: problem.problemNumber,
      slug: problem.slug,
      title: problem.title,
      description: problem.description,
      difficulty: problem.difficulty,
      timeLimit: problem.timeLimit,
      memoryLimit: problem.memoryLimit,
      testcases: (problem.testcases || []).map((tc) => ({
        testIndex: tc.testIndex,
        isVisible: tc.isVisible,
        input: tc.stdinSmall,
        output: tc.expectedSmall,
        stdinSmall: tc.stdinSmall,
        expectedSmall: tc.expectedSmall,
      })),
      templates: (problem.templates || []).reduce((acc, t) => {
        acc[t.language] = t.code;
        return acc;
      }, {}),
      templatesArray: problem.templates || [],
    };

    res.status(200).json({ success: true, data: formatted });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/problems
 * Creates a new coding problem with testcases and starter templates.
 */
export const addProblem = async (req, res, next) => {
  try {
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
      throw new ApiError(400, "slug and title are required for a problem.");
    }

    const existing = await prisma.problem.findUnique({ where: { slug } });
    if (existing) {
      throw new ApiError(409, `Problem with slug '${slug}' already exists.`);
    }

    const formattedTestcases = testcases.map((tc, idx) => ({
      testIndex: tc.testIndex ?? idx,
      isVisible: tc.isVisible ?? true,
      stdinSmall: String(tc.stdinSmall ?? tc.input ?? ""),
      expectedSmall: String(tc.expectedSmall ?? tc.output ?? ""),
      sizeBytes: Buffer.byteLength(
        String(tc.stdinSmall ?? tc.input ?? ""),
        "utf-8",
      ),
      r2Key: tc.r2Key || null,
    }));

    const formattedTemplates = Array.isArray(templates)
      ? templates
      : Object.entries(templates).map(([lang, code]) => ({
          language: lang,
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
