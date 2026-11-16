import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import prisma from "../config/db.js";
import { getUserTemplate } from "./codeBuilder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const problemsDir = path.resolve(__dirname, "../../problems");
const pendingProblemLoads = new Map();

function readBundledProblemTopic(slug) {
  if (!slug) return null;
  try {
    const filePath = path.join(problemsDir, `${slug}.json`);
    if (!fs.existsSync(filePath)) return null;
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return raw.topic || (Array.isArray(raw.tags) ? raw.tags[0] : null) || null;
  } catch {
    return null;
  }
}

/**
 * Resolves a problem by slug, ID, or problemNumber directly from PostgreSQL via Prisma.
 */
export async function resolveProblem(slugOrId) {
  if (!slugOrId) return null;
  const key = String(slugOrId).trim().toLowerCase();

  const pending = pendingProblemLoads.get(key);
  if (pending) return pending;

  const load = resolveProblemUncached(slugOrId);
  pendingProblemLoads.set(key, load);
  try {
    return await load;
  } finally {
    pendingProblemLoads.delete(key);
  }
}

async function resolveProblemUncached(slugOrId) {
  const isNum = /^\d+$/.test(String(slugOrId));
  const queryStr = String(slugOrId).trim().toLowerCase();

  const include = {
    examples: { orderBy: { order: "asc" } },
    testcases: { orderBy: { testIndex: "asc" } },
    templates: true,
  };

  let problem = null;

  if (isNum) {
    problem = await prisma.problem.findUnique({
      where: { problemNumber: Number(slugOrId) },
      include,
    });
  } else {
    problem = await prisma.problem.findUnique({
      where: { slug: queryStr },
      include,
    });
  }

  if (!problem && !isNum) {
    const baseSlug = queryStr.replace(/-\d+$/, "");
    problem = await prisma.problem.findFirst({
      where: {
        OR: [
          { slug: queryStr },
          ...(baseSlug === queryStr ? [] : [{ slug: baseSlug }]),
          { id: String(slugOrId) },
        ],
      },
      include,
    });
  }

  if (problem) {
    if (Array.isArray(problem.templates)) {
      problem.templatesMap = problem.templates.reduce((acc, t) => {
        let tmplObj = t.code;
        if (t.header || t.footer) {
          tmplObj = {
            userTemplate: t.code,
            header: t.header || "",
            footer: t.footer || "",
          };
        } else if (typeof t.code === "string" && t.code.trim().startsWith("{")) {
          try {
            const parsed = JSON.parse(t.code.trim());
            if (
              parsed &&
              typeof parsed === "object" &&
              (parsed.userTemplate !== undefined ||
                parsed.header !== undefined ||
                parsed.footer !== undefined)
            ) {
              tmplObj = parsed;
            }
          } catch {
            // Keep raw template string if not valid JSON
          }
        }
        acc[t.language] = tmplObj;
        return acc;
      }, {});
    } else {
      problem.templatesMap = problem.templates || {};
    }

    problem.userTemplates = {};
    Object.keys(problem.templatesMap).forEach((lang) => {
      problem.userTemplates[lang] = getUserTemplate(problem, lang);
    });
  }

  return problem;
}

/**
 * Lists problems from PostgreSQL with optional catalog filters and user solve status.
 */
export async function listAllProblems({
  difficulty,
  search,
  topic,
  status,
  userId,
} = {}) {
  const where = {};
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
      tags: true,
      solvedCount: true,
      createdAt: true,
      dsaTopic: { select: { name: true, slug: true } },
      timeLimit: true,
      memoryLimit: true,
      _count: { select: { examples: true, testcases: true, templates: true } },
    },
  });

  const submissionsByProblem = new Map();
  let solvedProblemIds = new Set();
  const problemIds = problems.map(({ id }) => id);

  if (problemIds.length > 0) {
    const [submissionGroups, solvedSubmissions] = await Promise.all([
      prisma.submission.groupBy({
        by: ["problemId", "status"],
        where: { problemId: { in: problemIds } },
        _count: { _all: true },
      }),
      userId
        ? prisma.submission.groupBy({
            by: ["problemId"],
            where: {
              userId,
              problemId: { in: problemIds },
              status: { equals: "ACCEPTED", mode: "insensitive" },
              totalCount: { gt: 0 },
            },
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);

    for (const group of submissionGroups) {
      const current = submissionsByProblem.get(group.problemId) || {
        accepted: 0,
        total: 0,
      };
      current.total += group._count._all;
      if (String(group.status).toUpperCase() === "ACCEPTED") {
        current.accepted += group._count._all;
      }
      submissionsByProblem.set(group.problemId, current);
    }

    if (userId) {
      solvedProblemIds = new Set(
        solvedSubmissions.map(({ problemId }) => problemId),
      );
    }
  }

  problems = problems.map((problem) => {
    const stats = submissionsByProblem.get(problem.id);
    const resolvedTopic =
      problem.dsaTopic?.name ||
      problem.tags?.[0] ||
      readBundledProblemTopic(problem.slug) ||
      "Other";
    const tags =
      Array.isArray(problem.tags) && problem.tags.length > 0
        ? problem.tags
        : resolvedTopic !== "Other"
          ? [resolvedTopic]
          : [];
    return {
      ...problem,
      topic: resolvedTopic,
      topicSlug:
        problem.dsaTopic?.slug ||
        String(resolvedTopic)
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, ""),
      tags,
      isSolved: solvedProblemIds.has(problem.id),
      acceptanceRate:
        stats?.total > 0
          ? Math.round((stats.accepted / stats.total) * 1000) / 10
          : null,
      points: pointsForDifficulty(problem.difficulty),
    };
  });

  if (search && search.trim()) {
    const q = search.trim().toLowerCase();
    problems = problems.filter(
      (p) =>
        String(p.title || "")
          .toLowerCase()
          .includes(q) ||
        String(p.slug || "")
          .toLowerCase()
          .includes(q) ||
        String(p.problemNumber).includes(q) ||
        String(p.topic || "")
          .toLowerCase()
          .includes(q) ||
        String(p.difficulty || "")
          .toLowerCase()
          .includes(q) ||
        (p.tags || []).some((tag) => String(tag).toLowerCase().includes(q)),
    );
  }

  if (topic) {
    const selectedTopic = String(topic).trim().toLowerCase();
    problems = problems.filter(
      (p) =>
        String(p.topic || "")
          .trim()
          .toLowerCase() === selectedTopic,
    );
  }

  if (status === "solved") {
    problems = problems.filter((p) => p.isSolved);
  } else if (status === "todo") {
    problems = problems.filter((p) => !p.isSolved);
  } else if (status) {
    throw new Error(`Unsupported problem status filter: ${status}`);
  }

  return problems;
}

function pointsForDifficulty(difficulty) {
  const normalized = String(difficulty || "").toLowerCase();
  if (normalized === "medium") return 25;
  if (normalized === "hard") return 50;
  return 10;
}
