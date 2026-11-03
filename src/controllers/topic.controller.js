import prisma from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";
import { listAllProblems } from "../utils/problemResolver.js";

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
    let topics = [];
    try {
      topics = await prisma.dsaTopic.findMany({
        orderBy: { order: "asc" },
      });
    } catch {}

    const problems = await listAllProblems();

    if (!topics || topics.length === 0) {
      const categoryMap = new Map();
      const defaultCategories = [
        { slug: "arrays", name: "Array", order: 1 },
        { slug: "linked-list", name: "Linked List", order: 2 },
        { slug: "strings", name: "String", order: 3 },
        { slug: "math", name: "Math", order: 4 },
        { slug: "two-pointers", name: "Two Pointers", order: 5 },
        { slug: "sliding-window", name: "Sliding Window", order: 6 },
        { slug: "stack", name: "Stack", order: 7 },
        { slug: "binary-search", name: "Binary Search", order: 8 },
        { slug: "trees", name: "Trees", order: 9 },
        { slug: "graphs", name: "Graphs", order: 10 },
        { slug: "dynamic-programming", name: "Dynamic Programming", order: 11 },
      ];
      defaultCategories.forEach((d) => categoryMap.set(d.slug, { id: `dsa-${d.slug}`, ...d }));

      problems.forEach((p) => {
        if (!p.topicSlug) return;
        if (!categoryMap.has(p.topicSlug)) {
          categoryMap.set(p.topicSlug, {
            id: `dsa-${p.topicSlug}`,
            slug: p.topicSlug,
            name: p.topic || p.topicSlug,
            order: categoryMap.size + 1,
          });
        }
      });
      topics = [...categoryMap.values()];
    }

    const data = topics.map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      order: t.order,
      totalProblems: problems.filter(
        (problem) =>
          problem.topicSlug === t.slug ||
          String(problem.topic).toLowerCase() === t.name.toLowerCase() ||
          (t.slug === "arrays" && String(problem.topic).toLowerCase().includes("array")),
      ).length,
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

    let topic = null;
    try {
      topic = await prisma.dsaTopic.findUnique({ where: { slug } });
    } catch {}

    if (!topic) {
      const cleanSlug = String(slug).toLowerCase().trim();
      const prettyName = cleanSlug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      topic = {
        id: `dsa-${cleanSlug}`,
        slug: cleanSlug,
        name: cleanSlug === "arrays" ? "Array" : prettyName,
      };
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

    let problems = [];
    try {
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
        },
      });
    } catch {}

    if (problems.length === 0) {
      const catalog = await listAllProblems({
        difficulty,
        search,
      });
      problems = catalog
        .filter((p) => {
          if (p.topicSlug === topic.slug) return true;
          if (String(p.topic).toLowerCase() === String(topic.name).toLowerCase()) return true;
          if (topic.slug === "arrays" && String(p.topic).toLowerCase().includes("array")) return true;
          return false;
        })
        .map((problem) => ({
          id: problem.id,
          problemNumber: problem.problemNumber,
          slug: problem.slug,
          title: problem.title,
          difficulty: problem.difficulty,
          tags: problem.tags,
        }));
    }

    res.status(200).json({
      topic: { id: topic.id, slug: topic.slug, name: topic.name },
      count: problems.length,
      problems,
    });
  } catch (err) {
    next(err);
  }
};