import prisma from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";

const onboardingTopics = {
  "dsa-arrays": "Arrays",
  "dsa-strings": "Strings",
  "dsa-recursion": "Recursion",
  "dsa-graphs": "Graphs",
  "dsa-sliding-window": "Sliding Window",
  "dsa-dp": "DP",
  "dsa-graphs-dp": "DSA - Graphs & DP",
  "dsa-trees": "Trees",
  "dsa-linked-list": "Linked List",
  "dsa-stack-queue": "DSA - Stack & Queue",
};

/**
 * POST /api/onboarding or PUT /api/onboarding/levels
 * Completes the authenticated user's onboarding calibration and sets topic difficulty levels.
 */
export const onboard = async (req, res, next) => {
  try {
    const userId = req.user.id;
    let { difficulty, topicIds, topicSelections, topicLevels, beginner } =
      req.body;

    // Difficulty normalization and score lookup maps
    const difficultyNormalize = {
      easy: "easy",
      beginner: "easy",
      medium: "medium",
      mid: "medium",
      intermediate: "medium",
      hard: "hard",
      advanced: "hard",
    };
    const ratingMap = {
      easy: 800,
      medium: 1200,
      hard: 1600,
    };

    // 1-Click beginner preset
    if (beginner === true) {
      difficulty = "easy";
      topicIds = "all";
    }

    // Support topicLevels alias from dashboard [{ topicId, level }]
    if (Array.isArray(topicLevels) && topicLevels.length > 0) {
      topicSelections = topicLevels.map((item) => ({
        topicId: item.topicId,
        difficulty: item.level || item.difficulty || "easy",
      }));
    }

    let resolvedTopicIdentifiers = [];
    const levelByTopicIdentifier = new Map();

    if (Array.isArray(topicSelections) && topicSelections.length > 0) {
      resolvedTopicIdentifiers = topicSelections.map((item) => {
        const id = typeof item === "string" ? item : item.topicId;
        const diff =
          typeof item === "object"
            ? item.difficulty || item.level || "easy"
            : "easy";
        levelByTopicIdentifier.set(id, diff);
        return id;
      });
    } else if (Array.isArray(topicIds)) {
      resolvedTopicIdentifiers = [...topicIds];
    }

    // If user requested "all" topics or provided difficulty without topicIds, select all topics
    if (
      topicIds === "all" ||
      (difficulty && resolvedTopicIdentifiers.length === 0)
    ) {
      const allTopics = await prisma.topic.findMany();
      resolvedTopicIdentifiers = allTopics.map((topic) => topic.id);
    }

    // Validate that at least 1 topic is selected
    if (
      !Array.isArray(resolvedTopicIdentifiers) ||
      resolvedTopicIdentifiers.length < 1
    ) {
      throw new ApiError(400, "Please select at least 1 topic.");
    }

    const uniqueTopicIdentifiers = [...new Set(resolvedTopicIdentifiers)];
    const existingTopics = await prisma.topic.findMany({
      where: {
        OR: [
          { id: { in: uniqueTopicIdentifiers } },
          { slug: { in: uniqueTopicIdentifiers } },
        ],
      },
    });
    const topicByIdentifier = new Map();
    existingTopics.forEach((topic) => {
      topicByIdentifier.set(topic.id, topic);
      topicByIdentifier.set(topic.slug, topic);
    });

    for (const identifier of uniqueTopicIdentifiers) {
      const name = onboardingTopics[identifier];
      if (name && !topicByIdentifier.has(identifier)) {
        const topic = await prisma.topic.upsert({
          where: { slug: identifier },
          update: { name, category: "DSA" },
          create: { slug: identifier, name, category: "DSA" },
        });
        topicByIdentifier.set(topic.id, topic);
        topicByIdentifier.set(topic.slug, topic);
      }
    }

    const topics = uniqueTopicIdentifiers.map((identifier) =>
      topicByIdentifier.get(identifier),
    );
    if (topics.some((topic) => !topic)) {
      throw new ApiError(400, "One or more topic IDs are invalid.");
    }

    const resolvedTopicIds = topics.map((topic) => topic.id);
    const levelByTopicId = new Map(
      topics.map((topic, index) => [
        topic.id,
        levelByTopicIdentifier.get(uniqueTopicIdentifiers[index]),
      ]),
    );

    // Calculate rating and difficulty
    let rating = 800;
    let normalizedDifficulty = "easy";

    if (levelByTopicId.size > 0) {
      let totalScore = 0;
      for (const [, level] of levelByTopicId.entries()) {
        const norm = difficultyNormalize[String(level).toLowerCase()] || "easy";
        totalScore += ratingMap[norm] || 800;
      }
      rating = Math.round(totalScore / levelByTopicId.size);
      if (rating >= 1400) normalizedDifficulty = "hard";
      else if (rating >= 1000) normalizedDifficulty = "medium";
      else normalizedDifficulty = "easy";
    } else {
      const rawDifficulty = (difficulty || "easy").toLowerCase();
      normalizedDifficulty = difficultyNormalize[rawDifficulty];
      if (!normalizedDifficulty) {
        throw new ApiError(
          400,
          "difficulty must be one of: easy (beginner), medium (mid), hard (advanced).",
        );
      }
      rating = ratingMap[normalizedDifficulty] || 800;
    }

    // Persist changes in a single database transaction
    const updatedUser = await prisma.$transaction(async (tx) => {
      // 1. Update user fields
      await tx.user.update({
        where: { id: userId },
        data: { difficulty: normalizedDifficulty, rating, onboarded: true },
      });

      // 2. Remove existing topic associations
      await tx.userTopic.deleteMany({ where: { userId } });

      // 3. Insert newly calibrated topic selections
      await tx.userTopic.createMany({
        data: resolvedTopicIds.map((topicId) => ({
          userId,
          topicId,
          level: levelByTopicId.get(topicId) || normalizedDifficulty || "easy",
        })),
      });

      // 4. Return updated user profile
      return tx.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          name: true,
          difficulty: true,
          rating: true,
          onboarded: true,
          preferredLanguage: true,
          createdAt: true,
          updatedAt: true,
          topics: {
            include: {
              topic: true,
            },
          },
        },
      });
    });

    res.status(200).json({ success: true, user: updatedUser });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/onboarding/status
 * Returns onboarding calibration status and selected topics for the authenticated user.
 */
export const getStatus = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        name: true,
        difficulty: true,
        rating: true,
        onboarded: true,
        preferredLanguage: true,
        topics: {
          include: {
            topic: true,
          },
        },
      },
    });

    if (!user) {
      throw new ApiError(404, "User not found.");
    }

    res.status(200).json({ success: true, user });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/onboarding/language
 * Updates preferred programming language during or after onboarding.
 */
export const updateLanguage = async (req, res, next) => {
  try {
    const { language } = req.body;
    const allowed = ["cpp", "c", "java", "python", "javascript"];
    const normalized = String(language || "")
      .trim()
      .toLowerCase();

    if (!allowed.includes(normalized)) {
      throw new ApiError(
        400,
        `Invalid language. Allowed options: ${allowed.join(", ")}`,
      );
    }

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: { preferredLanguage: normalized },
      select: {
        id: true,
        preferredLanguage: true,
      },
    });

    res.status(200).json({
      success: true,
      language: updated.preferredLanguage,
    });
  } catch (err) {
    next(err);
  }
};
