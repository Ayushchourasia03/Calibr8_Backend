import { ApiError } from "../utils/ApiError.js";
import { getUserTemplate } from "../utils/codeBuilder.js";
import { resolveProblem, listAllProblems } from "../utils/problemResolver.js";

export { resolveProblem, listAllProblems };

export const getAllProblems = async (req, res, next) => {
  try {
    if (req.query.status && !["solved", "todo"].includes(req.query.status)) {
      throw new ApiError(
        400,
        "Status must be either 'solved' or 'todo'.",
        "INVALID_STATUS",
      );
    }

    const data = await listAllProblems({
      ...req.query,
      userId: req.user?.id,
    });
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
