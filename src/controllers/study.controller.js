import prisma from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";

/**
 * GET /api/study/subjects
 * Lists all study curriculum subjects with chapter counts.
 */
export const getSubjects = async (req, res, next) => {
  try {
    const subjects = await prisma.studySubject.findMany({
      orderBy: { order: "asc" },
      include: { _count: { select: { chapters: true } } },
    });
    res.status(200).json(subjects);
  } catch (e) {
    next(e);
  }
};

/**
 * GET /api/study/subjects/:subjectSlug or /api/study/subjects/:subjectSlug/chapters
 * Returns subject details and all child chapters.
 */
export const getChaptersBySubject = async (req, res, next) => {
  try {
    const { subjectSlug } = req.params;
    const subject = await prisma.studySubject.findUnique({
      where: { slug: subjectSlug },
      include: {
        chapters: {
          orderBy: { order: "asc" },
          include: { _count: { select: { topics: true } } },
        },
      },
    });
    if (!subject) {
      throw new ApiError(404, "Subject not found.");
    }
    res.status(200).json(subject);
  } catch (e) {
    next(e);
  }
};

/**
 * GET /api/study/chapters/:chapterId/topics
 * Returns all published topics belonging to a specific chapter.
 */
export const getTopicsByChapter = async (req, res, next) => {
  try {
    const { chapterId } = req.params;
    const topics = await prisma.studyTopic.findMany({
      where: { chapterId, isPublished: true },
      orderBy: { order: "asc" },
      select: { id: true, slug: true, name: true, order: true },
    });
    res.status(200).json(topics);
  } catch (e) {
    next(e);
  }
};

/**
 * GET /api/study/topics/:topicSlug
 * Returns study content, markdown, and MCQs (without answer keys or explanations) for a published topic.
 */
export const getTopicBySlug = async (req, res, next) => {
  try {
    const { topicSlug } = req.params;
    const topic = await prisma.studyTopic.findFirst({
      where: { slug: topicSlug, isPublished: true },
      include: {
        mcqs: {
          orderBy: { order: "asc" },
          select: {
            id: true,
            question: true,
            options: true,
            difficulty: true,
            order: true,
          },
        },
        chapter: { include: { subject: true } },
      },
    });
    if (!topic) {
      throw new ApiError(404, "Topic not found.");
    }
    res.status(200).json(topic);
  } catch (e) {
    next(e);
  }
};

/**
 * POST /api/study/topics/:topicSlug/submit
 * Evaluates submitted MCQ answers and records user study progress.
 * Requires user authentication.
 */
export const submitMCQs = async (req, res, next) => {
  try {
    if (!req.user?.id) {
      throw new ApiError(401, "Authentication required to submit quiz answers.", "UNAUTHORIZED");
    }

    const { topicSlug } = req.params;
    const answers = req.body?.answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
      throw new ApiError(400, "answers must be an object of { mcqId: optionIndex }.", "INVALID_ANSWERS");
    }

    const topic = await prisma.studyTopic.findFirst({
      where: { slug: topicSlug, isPublished: true },
      include: { mcqs: true },
    });
    if (!topic) {
      throw new ApiError(404, "Topic not found.", "NOT_FOUND");
    }

    // Correct answers are only revealed for questions the user answered with a
    // valid option index, so the quiz cannot be enumerated arbitrarily.
    const answered = [];
    for (const mcq of topic.mcqs || []) {
      if (!Object.prototype.hasOwnProperty.call(answers, mcq.id)) continue;
      const choice = answers[mcq.id];
      const optionCount = Array.isArray(mcq.options) ? mcq.options.length : 0;
      if (!Number.isInteger(choice) || choice < 0 || choice >= optionCount) {
        throw new ApiError(
          400,
          "Submitted answer index is invalid for one or more questions.",
          "INVALID_ANSWERS",
        );
      }
      answered.push(mcq);
    }

    if (answered.length === 0) {
      throw new ApiError(400, "Answer at least one question before submitting.", "NO_ANSWERS");
    }

    let score = 0;
    const result = answered.map((mcq) => {
      const isCorrect = answers[mcq.id] === mcq.correctIndex;
      if (isCorrect) score++;
      return {
        mcqId: mcq.id,
        isCorrect,
        correctIndex: mcq.correctIndex,
        explanation: mcq.explanation,
      };
    });

    res.status(200).json({
      success: true,
      userId: req.user.id,
      topicSlug,
      score,
      answered: answered.length,
      total: (topic.mcqs || []).length,
      result,
    });
  } catch (e) {
    next(e);
  }
};