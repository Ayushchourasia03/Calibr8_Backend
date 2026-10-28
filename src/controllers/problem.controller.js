import prisma from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";
import { getUserTemplate } from "../utils/codeBuilder.js";
import { resolveProblem, listAllProblems } from "../utils/problemResolver.js";

export { resolveProblem, listAllProblems };

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