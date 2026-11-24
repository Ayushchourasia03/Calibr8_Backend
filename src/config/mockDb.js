import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { TOPIC_CATALOG } from "../data/topicCatalog.js";
import { STORE_THEMES } from "../data/storeThemes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");

const SUBJECT_DETAILS = {
  cn: {
    name: "Computer Networks",
    description: "Networking foundations, protocols, security, and performance.",
    icon: "🌐",
    order: 1,
  },
  dbms: {
    name: "Database Management Systems",
    description: "Relational data, SQL, transactions, storage, and internals.",
    icon: "🗄️",
    order: 2,
  },
  oops: {
    name: "Object-Oriented Programming",
    description: "OOP principles, SOLID design, and practical patterns.",
    icon: "🧩",
    order: 3,
  },
  os: {
    name: "Operating Systems",
    description: "Processes, memory, scheduling, file systems, and security.",
    icon: "⚙️",
    order: 4,
  },
  "system-design": {
    name: "System Design",
    description: "Scalability, architecture, reliability, and distributed systems.",
    icon: "🏗️",
    order: 5,
  },
};

function slugify(str) {
  return String(str || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function getOrderFromName(name) {
  const m = String(name).match(/^(\d+)-/);
  return m ? parseInt(m[1], 10) : 999;
}

function getSlugFromName(name) {
  return String(name).replace(/^\d+-/, "").toLowerCase();
}

function getNameFromSlug(slug) {
  return String(slug).replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

function clone(val) {
  if (val === null || val === undefined) return val;
  if (val instanceof Date) return new Date(val.getTime());
  if (Array.isArray(val)) return val.map(clone);
  if (typeof val === "object") {
    const out = {};
    for (const [k, v] of Object.entries(val)) out[k] = clone(v);
    return out;
  }
  return val;
}

function compareValues(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function sortRows(rows, orderBy) {
  if (!orderBy) return rows;
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      if (!spec || typeof spec !== "object") continue;
      for (const [field, dir] of Object.entries(spec)) {
        const cmp = compareValues(a[field], b[field]);
        if (cmp !== 0) return String(dir).toLowerCase() === "desc" ? -cmp : cmp;
      }
    }
    return 0;
  });
}

function matchCondition(val, cond) {
  if (cond === undefined) return true;
  if (cond === null || typeof cond !== "object" || cond instanceof Date || Array.isArray(cond)) {
    return val instanceof Date && cond instanceof Date
      ? val.getTime() === cond.getTime()
      : val === cond;
  }

  // Prisma filter operators
  const ops = ["equals", "in", "notIn", "not", "lt", "lte", "gt", "gte", "contains", "startsWith", "endsWith", "mode"];
  const hasOp = Object.keys(cond).some((k) => ops.includes(k));
  if (!hasOp) {
    return val === cond;
  }

  const insensitive = cond.mode === "insensitive";
  const norm = (x) => (insensitive && typeof x === "string" ? x.toLowerCase() : x);

  if ("equals" in cond) {
    if (norm(val) !== norm(cond.equals)) return false;
  }
  if ("in" in cond) {
    const list = Array.isArray(cond.in) ? cond.in.map(norm) : [];
    if (!list.includes(norm(val))) return false;
  }
  if ("notIn" in cond) {
    const list = Array.isArray(cond.notIn) ? cond.notIn.map(norm) : [];
    if (list.includes(norm(val))) return false;
  }
  if ("not" in cond) {
    if (cond.not === null) {
      if (val === null || val === undefined) return false;
    } else if (typeof cond.not === "object" && !(cond.not instanceof Date)) {
      if (matchCondition(val, cond.not)) return false;
    } else if (norm(val) === norm(cond.not)) {
      return false;
    }
  }
  if ("lt" in cond && !(compareValues(val, cond.lt) < 0)) return false;
  if ("lte" in cond && !(compareValues(val, cond.lte) <= 0)) return false;
  if ("gt" in cond && !(compareValues(val, cond.gt) > 0)) return false;
  if ("gte" in cond && !(compareValues(val, cond.gte) >= 0)) return false;
  if ("contains" in cond && !String(norm(val ?? "")).includes(String(norm(cond.contains)))) return false;
  if ("startsWith" in cond && !String(norm(val ?? "")).startsWith(String(norm(cond.startsWith)))) return false;
  if ("endsWith" in cond && !String(norm(val ?? "")).endsWith(String(norm(cond.endsWith)))) return false;

  return true;
}

export function createMockPrisma() {
  const tables = {
    user: [],
    topic: [],
    userTopic: [],
    socialAccount: [],
    theme: [],
    userTheme: [],
    problem: [],
    example: [],
    userProblemProgress: [],
    dsaTopic: [],
    testcase: [],
    codeTemplate: [],
    submission: [],
    studySubject: [],
    studyChapter: [],
    studyTopic: [],
    studyMCQ: [],
    coinTransaction: [],
    revokedToken: [],
    dailyProblem: [],
    dailyProblemCompletion: [],
    complexityProfile: [],
  };

  let problemSeq = 1;

  // 1. Seed Topic Catalog
  for (const t of TOPIC_CATALOG) {
    tables.topic.push({
      id: `topic-${t.slug}`,
      slug: t.slug,
      name: t.name,
      category: t.category,
    });
  }

  // 2. Seed Store Themes
  for (const theme of STORE_THEMES) {
    tables.theme.push({
      id: `theme-${theme.slug}`,
      slug: theme.slug,
      name: theme.name,
      price: theme.price,
      previewColor: theme.previewColor ?? null,
      cssVars: null,
      isDefault: Boolean(theme.isDefault),
      createdAt: new Date(),
    });
  }

  // 3. Seed Sample Leaderboard Users (no real credentials, allows leaderboard display)
  const sampleUsers = [
    {
      id: "seed-user-1",
      email: "aarav.sharma@calibr8.dev",
      phone: null,
      passwordHash: "$2a$12$invalidhashplaceholder000000000000000000000000000000",
      name: "Aarav Sharma",
      difficulty: "hard",
      rating: 1740,
      score: 1450,
      streak: 14,
      strictPercent: 92,
      tier: "Zenith I",
      college: "IIT Delhi",
      branch: "CSE",
      batch: "2026",
      state: "Delhi",
      country: "India",
      onboarded: true,
      preferredLanguage: "cpp",
      coins: 420,
      activeThemeId: "theme-default",
      lastStreakDate: new Date(),
      longestStreak: 18,
      lastLoginISTDate: null,
      tokenVersion: 0,
      createdAt: new Date(Date.now() - 30 * 86400_000),
      updatedAt: new Date(),
    },
    {
      id: "seed-user-2",
      email: "priya.nair@calibr8.dev",
      phone: null,
      passwordHash: "$2a$12$invalidhashplaceholder000000000000000000000000000000",
      name: "Priya Nair",
      difficulty: "medium",
      rating: 1420,
      score: 980,
      streak: 9,
      strictPercent: 85,
      tier: "Aurora III",
      college: "NIT Trichy",
      branch: "CSE",
      batch: "2026",
      state: "Tamil Nadu",
      country: "India",
      onboarded: true,
      preferredLanguage: "python",
      coins: 260,
      activeThemeId: "theme-default",
      lastStreakDate: new Date(),
      longestStreak: 12,
      lastLoginISTDate: null,
      tokenVersion: 0,
      createdAt: new Date(Date.now() - 25 * 86400_000),
      updatedAt: new Date(),
    },
    {
      id: "seed-user-3",
      email: "rohan.verma@calibr8.dev",
      phone: null,
      passwordHash: "$2a$12$invalidhashplaceholder000000000000000000000000000000",
      name: "Rohan Verma",
      difficulty: "easy",
      rating: 1080,
      score: 540,
      streak: 4,
      strictPercent: 78,
      tier: "Flux II",
      college: "BITS Pilani",
      branch: "ECE",
      batch: "2027",
      state: "Rajasthan",
      country: "India",
      onboarded: true,
      preferredLanguage: "javascript",
      coins: 150,
      activeThemeId: "theme-default",
      lastStreakDate: new Date(),
      longestStreak: 5,
      lastLoginISTDate: null,
      tokenVersion: 0,
      createdAt: new Date(Date.now() - 15 * 86400_000),
      updatedAt: new Date(),
    },
  ];
  tables.user.push(...sampleUsers);

  // 4. Seed Problems from /problems/*.json
  const problemsDir = path.join(ROOT_DIR, "problems");
  const dsaTopicBySlug = new Map();
  if (fs.existsSync(problemsDir)) {
    const files = fs.readdirSync(problemsDir).filter((f) => f.endsWith(".json")).sort();
    for (const file of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(problemsDir, file), "utf8"));
        const slug = raw.slug || path.basename(file, ".json").toLowerCase();
        const problemId = `prob-${slug}`;
        const topicName = raw.topic || (Array.isArray(raw.tags) ? raw.tags[0] : null) || "Array";
        const topicSlug = slugify(topicName);

        let dsaTopic = dsaTopicBySlug.get(topicSlug);
        if (!dsaTopic) {
          dsaTopic = {
            id: `dsatopic-${topicSlug}`,
            slug: topicSlug,
            name: topicName,
            order: dsaTopicBySlug.size + 1,
          };
          dsaTopicBySlug.set(topicSlug, dsaTopic);
          tables.dsaTopic.push(dsaTopic);
        }

        const tags =
          Array.isArray(raw.tags) && raw.tags.length > 0
            ? raw.tags.map(String)
            : raw.topic
              ? [String(raw.topic)]
              : [];

        tables.problem.push({
          id: problemId,
          problemNumber: problemSeq++,
          slug,
          title: raw.title || slug,
          description: raw.description || raw.title || "",
          difficulty: raw.difficulty || "Easy",
          solvedCount: 0,
          timeLimit: raw.timeLimit || raw.time_limit || 1000,
          memoryLimit: raw.memoryLimit || raw.memory_limit || 256,
          createdAt: new Date(),
          updatedAt: new Date(),
          dsaTopicId: dsaTopic.id,
          tags,
        });

        (raw.examples || []).forEach((ex, idx) => {
          tables.example.push({
            id: `ex-${slug}-${idx}`,
            problemId,
            order: ex.order ?? idx,
            input: String(ex.input ?? ""),
            output: String(ex.output ?? ""),
            explanation:
              ex.explanation != null && String(ex.explanation).trim() !== ""
                ? String(ex.explanation)
                : null,
            createdAt: new Date(),
          });
        });

        (raw.testcases || []).forEach((tc, idx) => {
          const input = tc.input ?? tc.stdinSmall ?? tc.stdin ?? "";
          const output = tc.output ?? tc.expectedSmall ?? tc.expected ?? "";
          const inputStr = typeof input === "object" ? JSON.stringify(input) : String(input);
          const outputStr = typeof output === "object" ? JSON.stringify(output) : String(output);
          tables.testcase.push({
            id: `tc-${slug}-${idx}`,
            problemId,
            testIndex: tc.testIndex ?? tc.index ?? idx,
            isVisible: tc.isVisible ?? tc.visible ?? true,
            stdinSmall: inputStr,
            expectedSmall: outputStr,
            sizeBytes: Buffer.byteLength(inputStr, "utf8"),
            r2Key: tc.r2Key || null,
          });
        });

        Object.entries(raw.templates || {}).forEach(([language, code]) => {
          tables.codeTemplate.push({
            id: `tmpl-${slug}-${language}`,
            problemId,
            language,
            code: typeof code === "object" && code !== null ? JSON.stringify(code) : String(code),
          });
        });
      } catch (err) {
        console.warn(`[MockDB] Failed loading problem ${file}:`, err.message);
      }
    }
  }

  // 5. Seed Study Material from /study-material/**/*.json
  const studyDir = path.join(ROOT_DIR, "study-material");
  if (fs.existsSync(studyDir)) {
    const subjectFolders = fs
      .readdirSync(studyDir)
      .filter((f) => fs.statSync(path.join(studyDir, f)).isDirectory())
      .sort();

    for (const subjectFolder of subjectFolders) {
      const subjectPath = path.join(studyDir, subjectFolder);
      const subjectSlug = getSlugFromName(subjectFolder);
      const details = SUBJECT_DETAILS[subjectSlug] || {};
      const subjectId = `subj-${subjectSlug}`;
      tables.studySubject.push({
        id: subjectId,
        slug: subjectSlug,
        name: details.name || getNameFromSlug(subjectSlug),
        description: details.description || null,
        icon: details.icon || null,
        order: details.order || getOrderFromName(subjectFolder),
        createdAt: new Date(),
      });

      const chapterFolders = fs
        .readdirSync(subjectPath)
        .filter((f) => fs.statSync(path.join(subjectPath, f)).isDirectory())
        .sort();

      for (const chapterFolder of chapterFolders) {
        const chapterPath = path.join(subjectPath, chapterFolder);
        const chapterSlug = getSlugFromName(chapterFolder);
        const chapterId = `chap-${subjectSlug}-${chapterSlug}`;
        tables.studyChapter.push({
          id: chapterId,
          slug: chapterSlug,
          name: getNameFromSlug(chapterSlug),
          subjectId,
          order: getOrderFromName(chapterFolder),
        });

        const topicFiles = fs
          .readdirSync(chapterPath)
          .filter((f) => f.endsWith(".json"))
          .sort();

        for (const topicFile of topicFiles) {
          try {
            const raw = JSON.parse(fs.readFileSync(path.join(chapterPath, topicFile), "utf8"));
            const topicSlug = raw.slug || getSlugFromName(path.basename(topicFile, ".json"));
            const topicId = raw.id || `st-${subjectSlug}-${chapterSlug}-${topicSlug}`;
            tables.studyTopic.push({
              id: topicId,
              slug: topicSlug,
              name: raw.name || getNameFromSlug(topicSlug),
              chapterId,
              order: raw.order ?? getOrderFromName(topicFile),
              content: raw.content || "",
              isPublished: raw.isPublished ?? true,
              createdAt: new Date(),
            });

            (raw.mcqs || []).forEach((mcq, idx) => {
              tables.studyMCQ.push({
                id: mcq.id || `mcq-${topicId}-${idx}`,
                topicId,
                question: mcq.question,
                options: mcq.options || [],
                correctIndex: mcq.correctIndex ?? 0,
                explanation: mcq.explanation || null,
                difficulty: mcq.difficulty || "Easy",
                order: mcq.order ?? idx + 1,
              });
            });
          } catch (err) {
            console.warn(`[MockDB] Failed loading study topic ${topicFile}:`, err.message);
          }
        }
      }
    }
  }

  // Relation resolver
  function hydrateRelation(modelName, row, relName, relSpec) {
    if (!relSpec) return undefined;

    const applySubQuery = (subModel, list) => {
      let items = list;
      if (relSpec && typeof relSpec === "object") {
        if (relSpec.where) items = items.filter((r) => matchesWhere(subModel, r, relSpec.where));
        if (relSpec.orderBy) items = sortRows(items, relSpec.orderBy);
        if (relSpec.skip) items = items.slice(relSpec.skip);
        if (relSpec.take !== undefined) items = items.slice(0, relSpec.take);
        return items.map((item) => projectRow(subModel, item, relSpec));
      }
      return items.map((item) => clone(item));
    };

    const applyOne = (subModel, item) => {
      if (!item) return null;
      if (relSpec && typeof relSpec === "object") return projectRow(subModel, item, relSpec);
      return clone(item);
    };

    switch (`${modelName}.${relName}`) {
      case "user.socialAccounts":
        return applySubQuery("socialAccount", tables.socialAccount.filter((r) => r.userId === row.id));
      case "user.topics":
        return applySubQuery("userTopic", tables.userTopic.filter((r) => r.userId === row.id));
      case "user.ownedThemes":
        return applySubQuery("userTheme", tables.userTheme.filter((r) => r.userId === row.id));
      case "user.activeTheme":
        return applyOne("theme", tables.theme.find((t) => t.id === row.activeThemeId));
      case "user.problemProgress":
        return applySubQuery("userProblemProgress", tables.userProblemProgress.filter((r) => r.userId === row.id));
      case "user.submissions":
        return applySubQuery("submission", tables.submission.filter((r) => r.userId === row.id));
      case "user.coinTransactions":
        return applySubQuery("coinTransaction", tables.coinTransaction.filter((r) => r.userId === row.id));
      case "user.dailyCompletions":
        return applySubQuery("dailyProblemCompletion", tables.dailyProblemCompletion.filter((r) => r.userId === row.id));
      case "userTopic.topic":
        return applyOne("topic", tables.topic.find((t) => t.id === row.topicId));
      case "userTopic.user":
        return applyOne("user", tables.user.find((u) => u.id === row.userId));
      case "userTheme.theme":
        return applyOne("theme", tables.theme.find((t) => t.id === row.themeId));
      case "problem.examples":
        return applySubQuery("example", tables.example.filter((r) => r.problemId === row.id));
      case "problem.testcases":
        return applySubQuery("testcase", tables.testcase.filter((r) => r.problemId === row.id));
      case "problem.templates":
        return applySubQuery("codeTemplate", tables.codeTemplate.filter((r) => r.problemId === row.id));
      case "problem.dsaTopic":
        return applyOne("dsaTopic", tables.dsaTopic.find((d) => d.id === row.dsaTopicId));
      case "problem.submissions":
        return applySubQuery("submission", tables.submission.filter((r) => r.problemId === row.id));
      case "submission.problem":
        return applyOne("problem", tables.problem.find((p) => p.id === row.problemId));
      case "submission.user":
        return applyOne("user", tables.user.find((u) => u.id === row.userId));
      case "submission.complexityProfile":
        return applyOne("complexityProfile", tables.complexityProfile.find((c) => c.submissionId === row.id));
      case "dailyProblem.problem":
        return applyOne("problem", tables.problem.find((p) => p.id === row.problemId));
      case "dailyProblem.completions":
        return applySubQuery("dailyProblemCompletion", tables.dailyProblemCompletion.filter((r) => r.dailyProblemId === row.id));
      case "studySubject.chapters":
        return applySubQuery("studyChapter", tables.studyChapter.filter((r) => r.subjectId === row.id));
      case "studyChapter.subject":
        return applyOne("studySubject", tables.studySubject.find((s) => s.id === row.subjectId));
      case "studyChapter.topics":
        return applySubQuery("studyTopic", tables.studyTopic.filter((r) => r.chapterId === row.id));
      case "studyTopic.mcqs":
        return applySubQuery("studyMCQ", tables.studyMCQ.filter((r) => r.topicId === row.id));
      case "studyTopic.chapter":
        return applyOne("studyChapter", tables.studyChapter.find((c) => c.id === row.chapterId));
      default:
        return undefined;
    }
  }

  function computeCount(modelName, row, countSpec) {
    const select = countSpec === true ? {} : countSpec?.select || {};
    const out = {};
    const check = (rel, fn) => {
      if (countSpec === true || select[rel]) out[rel] = fn();
    };
    if (modelName === "problem") {
      check("examples", () => tables.example.filter((r) => r.problemId === row.id).length);
      check("testcases", () => tables.testcase.filter((r) => r.problemId === row.id).length);
      check("templates", () => tables.codeTemplate.filter((r) => r.problemId === row.id).length);
      check("submissions", () => tables.submission.filter((r) => r.problemId === row.id).length);
    } else if (modelName === "studySubject") {
      check("chapters", () => tables.studyChapter.filter((r) => r.subjectId === row.id).length);
    } else if (modelName === "studyChapter") {
      check("topics", () => tables.studyTopic.filter((r) => r.chapterId === row.id).length);
    } else if (modelName === "studyTopic") {
      check("mcqs", () => tables.studyMCQ.filter((r) => r.topicId === row.id).length);
    }
    return out;
  }

  const RELATIONS = {
    user: new Set(["socialAccounts", "problemProgress", "ownedThemes", "topics", "submissions", "coinTransactions", "dailyCompletions", "activeTheme"]),
    userTopic: new Set(["topic", "user"]),
    userTheme: new Set(["theme", "user"]),
    problem: new Set(["templates", "dsaTopic", "testcases", "submissions", "userProgress", "dailyProblems", "examples"]),
    submission: new Set(["user", "problem", "complexityProfile"]),
    dailyProblem: new Set(["problem", "completions"]),
    studySubject: new Set(["chapters"]),
    studyChapter: new Set(["subject", "topics"]),
    studyTopic: new Set(["mcqs", "chapter"]),
  };

  function projectRow(modelName, row, args = {}) {
    if (!row) return null;
    const relSet = RELATIONS[modelName] || new Set();
    let result;

    if (args.select) {
      result = {};
      for (const [k, v] of Object.entries(args.select)) {
        if (!v) continue;
        if (k === "_count") {
          result._count = computeCount(modelName, row, v);
        } else if (relSet.has(k)) {
          result[k] = hydrateRelation(modelName, row, k, v);
        } else {
          result[k] = clone(row[k]);
        }
      }
    } else {
      result = clone(row);
      if (args.include) {
        for (const [k, v] of Object.entries(args.include)) {
          if (!v) continue;
          if (k === "_count") {
            result._count = computeCount(modelName, row, v);
          } else if (relSet.has(k)) {
            result[k] = hydrateRelation(modelName, row, k, v);
          }
        }
      }
    }
    return result;
  }

  function matchesWhere(modelName, row, where) {
    if (!where) return true;
    for (const [key, val] of Object.entries(where)) {
      if (val === undefined) continue;
      if (key === "AND") {
        const list = Array.isArray(val) ? val : [val];
        if (!list.every((sub) => matchesWhere(modelName, row, sub))) return false;
        continue;
      }
      if (key === "OR") {
        const list = Array.isArray(val) ? val : [val];
        if (!list.some((sub) => matchesWhere(modelName, row, sub))) return false;
        continue;
      }
      if (key === "NOT") {
        const list = Array.isArray(val) ? val : [val];
        if (list.some((sub) => matchesWhere(modelName, row, sub))) return false;
        continue;
      }

      // Compound unique keys
      if (
        typeof val === "object" &&
        val !== null &&
        !(val instanceof Date) &&
        !Array.isArray(val) &&
        key.includes("_") &&
        !(key in row)
      ) {
        const parts = key.split("_");
        if (parts.every((p) => p in val)) {
          if (!parts.every((p) => row[p] === val[p])) return false;
          continue;
        }
      }

      // Relation filters (e.g. testcases: { some: {} })
      if (RELATIONS[modelName]?.has(key) && typeof val === "object" && val !== null) {
        if ("some" in val) {
          const children = hydrateRelation(modelName, row, key, true) || [];
          if (!children.some((c) => matchesWhere(key, c, val.some))) return false;
          continue;
        }
        if ("every" in val) {
          const children = hydrateRelation(modelName, row, key, true) || [];
          if (!children.every((c) => matchesWhere(key, c, val.every))) return false;
          continue;
        }
        if ("none" in val) {
          const children = hydrateRelation(modelName, row, key, true) || [];
          if (children.some((c) => matchesWhere(key, c, val.none))) return false;
          continue;
        }
      }

      if (!matchCondition(row[key], val)) return false;
    }
    return true;
  }

  function applyUpdateData(modelName, row, data) {
    const now = new Date();
    for (const [key, val] of Object.entries(data)) {
      if (val === undefined) continue;
      if (val && typeof val === "object" && !(val instanceof Date) && !Array.isArray(val)) {
        if ("increment" in val) {
          row[key] = (Number(row[key]) || 0) + Number(val.increment);
          continue;
        }
        if ("decrement" in val) {
          row[key] = (Number(row[key]) || 0) - Number(val.decrement);
          continue;
        }
        if ("set" in val) {
          row[key] = clone(val.set);
          continue;
        }
      }
      row[key] = clone(val);
    }
    if ("updatedAt" in row || modelName === "user" || modelName === "problem" || modelName === "complexityProfile") {
      row.updatedAt = now;
    }
    return row;
  }

  function defaultRow(modelName, data) {
    const now = new Date();
    const base = { ...clone(data) };
    const idNeeded = !["userProblemProgress", "dailyProblemCompletion", "revokedToken"].includes(modelName);
    if (idNeeded && !base.id) {
      base.id = crypto.randomUUID();
    }
    if (modelName === "user") {
      return {
        phone: null,
        difficulty: null,
        rating: 800,
        score: 0,
        streak: 0,
        strictPercent: 0,
        tier: "Prism I",
        college: null,
        branch: null,
        batch: null,
        state: null,
        country: "India",
        onboarded: false,
        preferredLanguage: "cpp",
        coins: 100,
        activeThemeId: null,
        lastStreakDate: null,
        longestStreak: 0,
        lastLoginISTDate: null,
        tokenVersion: 0,
        createdAt: now,
        updatedAt: now,
        ...base,
      };
    }
    if (modelName === "problem") {
      return {
        problemNumber: problemSeq++,
        difficulty: "Easy",
        solvedCount: 0,
        timeLimit: 1000,
        memoryLimit: 256,
        tags: [],
        dsaTopicId: null,
        createdAt: now,
        updatedAt: now,
        ...base,
      };
    }
    if (modelName === "submission") {
      return {
        passedCount: 0,
        totalCount: 0,
        time: null,
        memory: null,
        tierReached: null,
        firstFailure: null,
        results: null,
        complexity: null,
        reward: null,
        dailyProblemReward: null,
        createdAt: now,
        ...base,
      };
    }
    if (modelName === "complexityProfile") {
      return {
        status: "PENDING",
        attempts: 0,
        nextAttemptAt: now,
        startedAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
        ...base,
      };
    }
    if (["coinTransaction", "revokedToken", "dailyProblem", "theme", "studySubject"].includes(modelName)) {
      return { createdAt: now, ...base };
    }
    if (modelName === "userTheme") return { purchasedAt: now, ...base };
    if (modelName === "socialAccount") return { connectedAt: now, ...base };
    if (modelName === "userProblemProgress") return { scoreAwarded: 0, coinsAwarded: 0, solvedAt: now, ...base };
    if (modelName === "dailyProblemCompletion") return { completedAt: now, ...base };
    return base;
  }

  function isDuplicate(modelName, row) {
    const rows = tables[modelName];
    if (modelName === "user") return rows.some((r) => r.email === row.email || (row.phone && r.phone === row.phone));
    if (modelName === "topic" || modelName === "theme" || modelName === "problem" || modelName === "dsaTopic" || modelName === "studySubject") {
      return rows.some((r) => r.slug === row.slug);
    }
    if (modelName === "dailyProblem") return rows.some((r) => r.istDate === row.istDate);
    if (modelName === "dailyProblemCompletion") return rows.some((r) => r.userId === row.userId && r.dailyProblemId === row.dailyProblemId);
    if (modelName === "userProblemProgress") return rows.some((r) => r.userId === row.userId && r.problemId === row.problemId);
    if (modelName === "userTopic") return rows.some((r) => r.userId === row.userId && r.topicId === row.topicId);
    if (modelName === "userTheme") return rows.some((r) => r.userId === row.userId && r.themeId === row.themeId);
    if (modelName === "socialAccount") {
      return rows.some(
        (r) =>
          (r.userId === row.userId && r.provider === row.provider) ||
          (r.provider === row.provider && r.providerUserId === row.providerUserId),
      );
    }
    if (modelName === "revokedToken") return rows.some((r) => r.jti === row.jti);
    if (modelName === "complexityProfile") return rows.some((r) => r.submissionId === row.submissionId);
    return false;
  }

  function createModelDelegate(modelName) {
    const rows = tables[modelName];

    return {
      async findUnique(args = {}) {
        const match = rows.find((r) => matchesWhere(modelName, r, args.where));
        return match ? projectRow(modelName, match, args) : null;
      },

      async findFirst(args = {}) {
        let matched = rows.filter((r) => matchesWhere(modelName, r, args.where));
        if (args.orderBy) matched = sortRows(matched, args.orderBy);
        if (args.skip) matched = matched.slice(args.skip);
        return matched[0] ? projectRow(modelName, matched[0], args) : null;
      },

      async findMany(args = {}) {
        let matched = rows.filter((r) => matchesWhere(modelName, r, args.where));
        if (args.orderBy) matched = sortRows(matched, args.orderBy);
        if (args.distinct) {
          const seen = new Set();
          const fields = Array.isArray(args.distinct) ? args.distinct : [args.distinct];
          matched = matched.filter((r) => {
            const k = fields.map((f) => r[f]).join("\u0000");
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        }
        if (args.skip) matched = matched.slice(args.skip);
        if (args.take !== undefined) matched = matched.slice(0, args.take);
        return matched.map((r) => projectRow(modelName, r, args));
      },

      async create(args = {}) {
        const row = defaultRow(modelName, args.data || {});
        if (isDuplicate(modelName, row)) {
          const err = new Error("Unique constraint failed");
          err.code = "P2002";
          throw err;
        }
        rows.push(row);
        return projectRow(modelName, row, args);
      },

      async createMany(args = {}) {
        const items = Array.isArray(args.data) ? args.data : [];
        let count = 0;
        for (const item of items) {
          const row = defaultRow(modelName, item);
          if (isDuplicate(modelName, row)) {
            if (args.skipDuplicates) continue;
            const err = new Error("Unique constraint failed");
            err.code = "P2002";
            throw err;
          }
          rows.push(row);
          count++;
        }
        return { count };
      },

      async update(args = {}) {
        const match = rows.find((r) => matchesWhere(modelName, r, args.where));
        if (!match) {
          const err = new Error("Record not found");
          err.code = "P2025";
          throw err;
        }
        applyUpdateData(modelName, match, args.data || {});
        return projectRow(modelName, match, args);
      },

      async updateMany(args = {}) {
        let count = 0;
        for (const r of rows) {
          if (matchesWhere(modelName, r, args.where)) {
            applyUpdateData(modelName, r, args.data || {});
            count++;
          }
        }
        return { count };
      },

      async upsert(args = {}) {
        const match = rows.find((r) => matchesWhere(modelName, r, args.where));
        if (match) {
          applyUpdateData(modelName, match, args.update || {});
          return projectRow(modelName, match, args);
        }
        const row = defaultRow(modelName, args.create || {});
        rows.push(row);
        return projectRow(modelName, row, args);
      },

      async delete(args = {}) {
        const idx = rows.findIndex((r) => matchesWhere(modelName, r, args.where));
        if (idx === -1) {
          const err = new Error("Record not found");
          err.code = "P2025";
          throw err;
        }
        const [removed] = rows.splice(idx, 1);
        return projectRow(modelName, removed, args);
      },

      async deleteMany(args = {}) {
        let count = 0;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (matchesWhere(modelName, rows[i], args.where)) {
            rows.splice(i, 1);
            count++;
          }
        }
        return { count };
      },

      async count(args = {}) {
        return rows.filter((r) => matchesWhere(modelName, r, args.where)).length;
      },

      async groupBy(args = {}) {
        const by = Array.isArray(args.by) ? args.by : [args.by];
        const matched = rows.filter((r) => matchesWhere(modelName, r, args.where));
        const groups = new Map();
        for (const r of matched) {
          const key = by.map((f) => String(r[f])).join("\u0000");
          let entry = groups.get(key);
          if (!entry) {
            entry = { _count: { _all: 0 } };
            for (const f of by) entry[f] = r[f];
            groups.set(key, entry);
          }
          entry._count._all++;
        }
        return [...groups.values()];
      },

      async aggregate(args = {}) {
        const matched = rows.filter((r) => matchesWhere(modelName, r, args.where));
        const result = {};
        if (args._sum) {
          result._sum = {};
          for (const field of Object.keys(args._sum)) {
            result._sum[field] = matched.reduce((acc, r) => acc + (Number(r[field]) || 0), 0);
          }
        }
        if (args._count) {
          result._count = { _all: matched.length };
        }
        return result;
      },
    };
  }

  const client = {
    __isMock: true,
    $connect: async () => {},
    $disconnect: async () => {},
    $transaction: async (fnOrArray) => {
      if (Array.isArray(fnOrArray)) return Promise.all(fnOrArray);
      return fnOrArray(client);
    },
    $queryRaw: async (strings, ...values) => {
      const sql = Array.isArray(strings) ? strings.join(" ") : String(strings || "");
      if (/^\s*SELECT\s+1\s*$/i.test(sql)) {
        return [{ "?column?": 1 }];
      }
      if (sql.includes("complexity_profiles")) {
        return [];
      }
      if (sql.includes('FROM "users"') && sql.includes('"rating"')) {
        const u = tables.user.find((x) => x.id === values[0]);
        return u ? [{ rating: u.rating }] : [];
      }
      throw new Error("MockDB: raw SQL fallback");
    },
  };

  for (const modelName of Object.keys(tables)) {
    client[modelName] = createModelDelegate(modelName);
  }

  return client;
}
