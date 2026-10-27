import prisma from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";

/**
 * GET /api/topics
 * Returns all available topics, optionally filtered by category query (?category=dsa or ?category=core).
 */
export const getAllTopics = async (req, res, next) => {
  try {
    const rawCategory = Array.isArray(req.query.category)
      ? req.query.category[0]
      : req.query.category;

    // Fetch all topics ordered by name
    const all = await prisma.topic.findMany({
      orderBy: { name: "asc" },
    });

    // Split topics into DSA and Core
    const dsaTopics = all.filter(
      (t) => t.category && t.category.toUpperCase() === "DSA",
    );
    const coreTopics = all.filter(
      (t) => !t.category || t.category.toUpperCase() !== "DSA",
    );

    // Apply category filter if requested
    let returnTopics = all;
    if (rawCategory) {
      const target = String(rawCategory).trim().toLowerCase();
      if (target === "dsa") {
        returnTopics = dsaTopics;
      } else if (target === "core") {
        returnTopics = coreTopics;
      }
    }

    res.status(200).json({
      message: "Topics fetched successfully",
      success: true,
      count: returnTopics.length,
      topics: returnTopics,
      // dsaTopics,
      // coreTopics,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/topics/dsa
 * Returns specifically DSA topics.
 */
export const getDsaTopics = async (req, res, next) => {
  try {
    const dsaTopics = await prisma.topic.findMany({
      where: { category: { equals: "DSA", mode: "insensitive" } },
      orderBy: { name: "asc" },
    });

    res.status(200).json({
      success: true,
      count: dsaTopics.length,
      topics: dsaTopics,
      dsaTopics,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/topics/:identifier
 * Returns a specific topic by its ID or slug.
 */
export const getTopicDetail = async (req, res, next) => {
  try {
    const { identifier } = req.params;

    // Try finding topic by ID
    let topic = await prisma.topic.findUnique({
      where: { id: identifier },
    });

    // If not found by ID, try finding by unique slug
    if (!topic) {
      topic = await prisma.topic.findUnique({
        where: { slug: identifier },
      });
    }

    if (!topic) {
      throw new ApiError(404, `Topic '${identifier}' not found.`);
    }

    res.status(200).json({ success: true, topic });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/topics/dsa/categories or /api/topics/categories
 * Returns all structured DSA topic categories with their problem counts.
 */
export const getAllDsaTopics = async (req, res, next) => {
  try {
    const topics = await prisma.dsaTopic.findMany({
      orderBy: { order: "asc" },
      include: {
        _count: { select: { problems: true } },
      },
    });

    const data = topics.map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      order: t.order,
      totalProblems: t._count.problems,
    }));

    res.status(200).json(data);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/topics/dsa/:slug/problems
 * Returns problem definitions grouped by a specific DSA topic category slug.
 */
export const getProblemsByDsaTopic = async (req, res, next) => {
  try {
    const { slug } = req.params;
    const { difficulty, search } = req.query;

    const topic = await prisma.dsaTopic.findUnique({ where: { slug } });
    if (!topic) {
      throw new ApiError(404, `Topic '${slug}' not found.`);
    }

    const where = { dsaTopicId: topic.id };
    if (difficulty) {
      where.difficulty = { equals: difficulty, mode: "insensitive" };
    }
    if (search && search.trim()) {
      where.OR = [
        { title: { contains: search.trim(), mode: "insensitive" } },
        { slug: { contains: search.trim(), mode: "insensitive" } },
      ];
    }

    const problems = await prisma.problem.findMany({
      where,
      orderBy: { problemNumber: "asc" },
      select: {
        id: true,
        problemNumber: true,
        slug: true,
        title: true,
        difficulty: true,
        tags: true,
      },
    });

    res.status(200).json({
      topic: { id: topic.id, slug: topic.slug, name: topic.name },
      count: problems.length,
      problems,
    });
  } catch (err) {
    next(err);
  }
};