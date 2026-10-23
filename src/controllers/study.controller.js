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
 * Returns all topics belonging to a specific chapter.
 */
export const getTopicsByChapter = async (req, res, next) => {
  try {
    const { chapterId } = req.params;
    const topics = await prisma.studyTopic.findMany({
      where: { chapterId },
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
 * Returns study content, markdown, and MCQs for a specific topic.
 */
export const getTopicBySlug = async (req, res, next) => {
  try {
    const { topicSlug } = req.params;
    const topic = await prisma.studyTopic.findFirst({
      where: { slug: topicSlug },
      include: {
        mcqs: {
          orderBy: { order: "asc" },
          select: {
            id: true,
            question: true,
            options: true,
            difficulty: true,
            order: true,
            explanation: true,
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
 * Evaluates submitted MCQ answers and returns score breakdown.
 */
export const submitMCQs = async (req, res, next) => {
  try {
    const { topicSlug } = req.params;
    const { answers = {} } = req.body;

    const topic = await prisma.studyTopic.findFirst({
      where: { slug: topicSlug },
      include: { mcqs: true },
    });
    if (!topic) {
      throw new ApiError(404, "Topic not found.");
    }

    let score = 0;
    const result = (topic.mcqs || []).map((mcq) => {
      const userAns = answers[mcq.id];
      const isCorrect = userAns === mcq.correctIndex;
      if (isCorrect) score++;
      return {
        mcqId: mcq.id,
        isCorrect,
        correctIndex: mcq.correctIndex,
        explanation: mcq.explanation,
      };
    });

    res.status(200).json({ score, total: (topic.mcqs || []).length, result });
  } catch (e) {
    next(e);
  }
};