import dotenv from "dotenv";
dotenv.config();
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaPg } from "@prisma/adapter-pg";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { STORE_THEMES } from "../data/storeThemes.js";
import { TOPIC_CATALOG } from "../data/topicCatalog.js";

neonConfig.webSocketConstructor = ws;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STUDY_DIR = path.resolve(__dirname, "../../study-material");

// Initial Seed Data for fallback
const INITIAL_TOPICS = TOPIC_CATALOG.map((topic, index) => ({
  id: `top-${index + 1}`,
  ...topic,
}));

// In-Memory Database Store for robust zero-config execution
class InMemoryStore {
  constructor() {
    this.users = new Map();
    this.topics = new Map();
    this.userTopics = new Map();
    this.themes = new Map();
    this.userThemes = new Map();
    this.submissions = new Map();
    this.userProblemProgress = new Map();
    this.coinTransactions = new Map();
    this.dailyProblems = new Map();
    this.studySubjects = [];
    this.studyChapters = [];
    this.studyTopics = [];
    this.studyMCQs = [];

    // Seed topics
    INITIAL_TOPICS.forEach((t) => this.topics.set(t.id, { ...t }));
    // Seed themes
    STORE_THEMES.forEach((t) =>
      this.themes.set(`thm-${t.slug}`, { id: `thm-${t.slug}`, ...t }),
    );

    // Seed initial daily problems rotation across consecutive days
    const today = new Date();
    const fallbackProblems = [
      "two-sum",
      "add-two-numbers",
      "best-time-to-buy-and-sell-stock",
      "backspace-string-compare",
      "3sum",
    ];
    for (let offset = -2; offset <= 35; offset++) {
      const d = new Date(today.getTime() + offset * 86400000);
      const istDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(d);
      const problemId = fallbackProblems[Math.abs(offset + 2) % fallbackProblems.length];
      this.dailyProblems.set(`dp_${istDate}`, {
        id: `dp_${istDate}`,
        istDate,
        problemId,
        createdAt: new Date(),
      });
    }

    // Load study curriculum from local study-material folder
    this.initStudyMaterials();
  }

  initStudyMaterials() {
    if (!fs.existsSync(STUDY_DIR)) return;

    try {
      const subjectFolders = fs
        .readdirSync(STUDY_DIR)
        .filter((f) => fs.statSync(path.join(STUDY_DIR, f)).isDirectory());

      subjectFolders.forEach((sFolder, sIdx) => {
        const sPath = path.join(STUDY_DIR, sFolder);
        const sSlug = sFolder.replace(/^\d+-/, "").toLowerCase();
        const sName = sSlug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        const subjectId = `subj-${sSlug}`;

        const chapters = [];
        const chapterFolders = fs
          .readdirSync(sPath)
          .filter((f) => fs.statSync(path.join(sPath, f)).isDirectory());

        chapterFolders.forEach((cFolder, cIdx) => {
          const cPath = path.join(sPath, cFolder);
          const cSlug = cFolder.replace(/^\d+-/, "").toLowerCase();
          const cName = cSlug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
          const chapterId = `chap-${sSlug}-${cSlug}`;

          const topicFiles = fs.readdirSync(cPath).filter((f) => f.endsWith(".json"));
          const topics = [];

          topicFiles.forEach((tFile, tIdx) => {
            try {
              const raw = fs.readFileSync(path.join(cPath, tFile), "utf-8");
              const tData = JSON.parse(raw);
              const tSlug = tData.topic || tFile.replace(".json", "");
              const tName = tData.topicName || tData.name || tSlug.replace(/-/g, " ");
              const topicId = `topic-${tSlug}`;

              const mcqs = (tData.mcqs || []).map((m, mIdx) => ({
                id: `mcq-${tSlug}-${mIdx}`,
                topicId,
                question: m.question,
                options: m.options,
                correctIndex: m.correctIndex,
                explanation: m.explanation || "",
                difficulty: m.difficulty || "Easy",
                order: m.order ?? mIdx,
              }));

              const topicRecord = {
                id: topicId,
                slug: tSlug,
                name: tName,
                chapterId,
                order: tData.order ?? tIdx + 1,
                content: tData.content || "",
                isPublished: true,
                mcqs,
              };

              topics.push(topicRecord);
              this.studyTopics.push(topicRecord);
              mcqs.forEach((m) => this.studyMCQs.push(m));
            } catch (_) {}
          });

          const chapterRecord = {
            id: chapterId,
            slug: cSlug,
            name: cName,
            subjectId,
            order: cIdx + 1,
            topics,
            _count: { topics: topics.length },
          };

          chapters.push(chapterRecord);
          this.studyChapters.push(chapterRecord);
        });

        const subjectRecord = {
          id: subjectId,
          slug: sSlug,
          name: sName,
          order: sIdx + 1,
          chapters,
          _count: { chapters: chapters.length },
        };

        this.studySubjects.push(subjectRecord);
      });
    } catch (e) {
      console.warn("[InMemoryStore] Study material loading notice:", e.message);
    }
  }
}

const store = new InMemoryStore();

// Create Model Proxies that delegate to in-memory store
function createModelProxy(modelName) {
  return {
    async findUnique({ where, include, select } = {}) {
      if (modelName === "user") {
        for (const u of store.users.values()) {
          if (where.id && u.id === where.id) return formatUser(u, include, select);
          if (where.email && u.email.toLowerCase() === where.email.toLowerCase()) return formatUser(u, include, select);
        }
        return null;
      }
      if (modelName === "topic") {
        for (const t of store.topics.values()) {
          if (where.id && t.id === where.id) return { ...t };
          if (where.slug && t.slug === where.slug) return { ...t };
        }
        return null;
      }
      if (modelName === "userTopic") {
        if (where.userId_topicId) {
          const key = `${where.userId_topicId.userId}_${where.userId_topicId.topicId}`;
          return store.userTopics.get(key) || null;
        }
        return null;
      }
      if (modelName === "theme") {
        for (const t of store.themes.values()) {
          if (where.id && t.id === where.id) return { ...t };
          if (where.slug && t.slug === where.slug) return { ...t };
        }
        return null;
      }
      if (modelName === "userTheme") {
        for (const ownedTheme of store.userThemes.values()) {
          if (
            (!where.userId || ownedTheme.userId === where.userId) &&
            (!where.themeId || ownedTheme.themeId === where.themeId) &&
            (!where.id || ownedTheme.id === where.id)
          ) {
            return { ...ownedTheme };
          }
        }
        return null;
      }
      if (modelName === "submission") {
        return store.submissions.get(where.id) || null;
      }
      if (modelName === "coinTransaction") {
        if (where.id) return store.coinTransactions.get(where.id) || null;
        for (const ct of store.coinTransactions.values()) {
          if (where.userId_type_istDate_referenceId) {
            const c = where.userId_type_istDate_referenceId;
            if (ct.userId === c.userId && ct.type === c.type && ct.istDate === c.istDate && ct.referenceId === c.referenceId) {
              return { ...ct };
            }
          }
        }
        return null;
      }
      if (modelName === "dailyProblem") {
        if (where.id) return store.dailyProblems.get(where.id) || null;
        if (where.istDate) {
          for (const dp of store.dailyProblems.values()) {
            if (dp.istDate === where.istDate) return { ...dp };
          }
        }
        return null;
      }
      if (modelName === "studySubject") {
        return store.studySubjects.find((s) => s.slug === where.slug || s.id === where.id) || null;
      }
      if (modelName === "studyChapter") {
        return store.studyChapters.find((c) => c.id === where.id) || null;
      }
      if (modelName === "studyTopic") {
        return store.studyTopics.find((t) => t.slug === where.slug || t.id === where.id) || null;
      }
      return null;
    },

    async findFirst({ where = {}, include, select } = {}) {
      if (modelName === "user") {
        for (const u of store.users.values()) {
          if (where.email && u.email.toLowerCase() === where.email.toLowerCase()) {
            return formatUser(u, include, select);
          }
          if (where.id && u.id === where.id) {
            return formatUser(u, include, select);
          }
        }
        return store.users.size > 0 ? formatUser([...store.users.values()][0], include, select) : null;
      }
      if (modelName === "userTheme") {
        for (const ownedTheme of store.userThemes.values()) {
          if (
            (!where.userId || ownedTheme.userId === where.userId) &&
            (!where.themeId || ownedTheme.themeId === where.themeId)
          ) {
            return { ...ownedTheme };
          }
        }
        return null;
      }
      if (modelName === "studyTopic") {
        const found = store.studyTopics.find((t) => t.slug === where.slug || t.id === where.id);
        if (found) {
          const ch = store.studyChapters.find((c) => c.id === found.chapterId) || {};
          const sub = store.studySubjects.find((s) => s.id === ch.subjectId) || {};
          return {
            ...found,
            chapter: { ...ch, subject: sub },
          };
        }
        return null;
      }
      if (modelName === "coinTransaction") {
        for (const ct of store.coinTransactions.values()) {
          if (where.userId && ct.userId !== where.userId) continue;
          if (where.type && ct.type !== where.type) continue;
          if (where.istDate && ct.istDate !== where.istDate) continue;
          if (where.referenceId !== undefined && ct.referenceId !== where.referenceId) continue;
          return { ...ct };
        }
        return null;
      }
      if (modelName === "dailyProblem") {
        for (const dp of store.dailyProblems.values()) {
          if (where.istDate && dp.istDate !== where.istDate) continue;
          if (where.problemId && dp.problemId !== where.problemId) continue;
          return { ...dp };
        }
        return null;
      }
      return null;
    },

    async findMany({ where = {}, include, select, orderBy, take, skip } = {}) {
      if (modelName === "user") {
        return [...store.users.values()].map((u) => formatUser(u, include, select));
      }
      if (modelName === "topic") {
        let list = [...store.topics.values()];
        if (where.category) {
          const category =
            typeof where.category === "object"
              ? where.category.equals
              : where.category;
          const insensitive =
            typeof where.category === "object" &&
            where.category.mode === "insensitive";
          list = list.filter((topic) => {
            if (category === undefined) return true;
            return insensitive
              ? topic.category.toLowerCase() === String(category).toLowerCase()
              : topic.category === category;
          });
        }
        if (where.OR) {
          list = list.filter((topic) =>
            where.OR.some(
              (condition) =>
                condition.id?.in?.includes(topic.id) ||
                condition.slug?.in?.includes(topic.slug),
            ),
          );
        }
        if (orderBy?.name) {
          list.sort((a, b) =>
            orderBy.name === "desc"
              ? b.name.localeCompare(a.name)
              : a.name.localeCompare(b.name),
          );
        }
        return list;
      }
      if (modelName === "userTopic") {
        let list = [...store.userTopics.values()];
        if (where.userId) {
          list = list.filter((ut) => ut.userId === where.userId);
        }
        return list.map((ut) => ({
          ...ut,
          topic: store.topics.get(ut.topicId) || { slug: "dsa", name: "DSA", category: "DSA" },
        }));
      }
      if (modelName === "theme") {
        return [...store.themes.values()];
      }
      if (modelName === "userTheme") {
        let list = [...store.userThemes.values()];
        if (where.userId) list = list.filter((ut) => ut.userId === where.userId);
        if (where.themeId) list = list.filter((ut) => ut.themeId === where.themeId);
        return list;
      }
      if (modelName === "studySubject") {
        return store.studySubjects;
      }
      if (modelName === "studyChapter") {
        let list = store.studyChapters;
        if (where.subjectId) list = list.filter((c) => c.subjectId === where.subjectId);
        return list;
      }
      if (modelName === "studyTopic") {
        let list = store.studyTopics;
        if (where.chapterId) list = list.filter((t) => t.chapterId === where.chapterId);
        return list;
      }
      if (modelName === "studyMCQ") {
        let list = store.studyMCQs;
        if (where.topicId) list = list.filter((m) => m.topicId === where.topicId);
        return list;
      }
      if (modelName === "submission") {
        return [...store.submissions.values()];
      }
      if (modelName === "userProblemProgress") {
        return [...store.userProblemProgress.values()].filter(
          (progress) => !where.userId || progress.userId === where.userId,
        );
      }
      if (modelName === "coinTransaction") {
        let list = [...store.coinTransactions.values()];
        if (where.userId) list = list.filter((ct) => ct.userId === where.userId);
        if (where.type) list = list.filter((ct) => ct.type === where.type);
        if (where.istDate) list = list.filter((ct) => ct.istDate === where.istDate);
        if (orderBy?.createdAt === "desc") {
          list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        } else if (orderBy?.createdAt === "asc") {
          list.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        }
        if (skip) list = list.slice(skip);
        if (take) list = list.slice(0, take);
        return list;
      }
      if (modelName === "dailyProblem") {
        let list = [...store.dailyProblems.values()];
        if (where.istDate) list = list.filter((dp) => dp.istDate === where.istDate);
        if (orderBy?.istDate === "asc") list.sort((a, b) => a.istDate.localeCompare(b.istDate));
        if (take) list = list.slice(0, take);
        return list;
      }
      return [];
    },

    async create({ data, include } = {}) {
      if (modelName === "user") {
        const id = data.id || `usr-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        const user = {
          id,
          email: data.email,
          passwordHash: data.passwordHash,
          name: data.name,
          difficulty: data.difficulty ?? "Easy",
          rating: data.rating ?? 800,
          coins: data.coins ?? 100,
          score: data.score ?? 0,
          streak: data.streak ?? 0,
          strictPercent: 0,
          tier: "Prism I",
          longestStreak: data.longestStreak ?? 0,
          lastStreakDate: data.lastStreakDate ?? null,
          lastLoginISTDate: data.lastLoginISTDate ?? null,
          onboarded: false,
          preferredLanguage: data.preferredLanguage || "cpp",
          createdAt: new Date(),
          updatedAt: new Date(),
          socialAccounts: [],
          topics: [],
          activeThemeId: "thm-default",
        };
        store.users.set(id, user);
        return formatUser(user, include);
      }
      if (modelName === "submission") {
        const id = data.id || `sub_${Date.now()}`;
        const sub = { id, ...data, createdAt: new Date() };
        store.submissions.set(id, sub);
        return sub;
      }
      if (modelName === "userTheme") {
        const existing = [...store.userThemes.values()].find(
          (ownedTheme) =>
            ownedTheme.userId === data.userId &&
            ownedTheme.themeId === data.themeId,
        );
        if (existing) {
          const error = new Error("Unique constraint failed on user theme ownership");
          error.code = "P2002";
          throw error;
        }
        const id = `ut-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const ut = { id, ...data, purchasedAt: new Date() };
        store.userThemes.set(id, ut);
        return ut;
      }
      if (modelName === "coinTransaction") {
        const id = data.id || `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const ct = {
          id,
          userId: data.userId,
          amount: data.amount,
          type: data.type,
          referenceId: data.referenceId ?? null,
          istDate: data.istDate,
          balanceAfter: data.balanceAfter,
          createdAt: data.createdAt || new Date(),
        };
        store.coinTransactions.set(id, ct);
        return { ...ct };
      }
      if (modelName === "dailyProblem") {
        const id = data.id || `dp_${data.istDate}`;
        const dp = {
          id,
          istDate: data.istDate,
          problemId: data.problemId,
          createdAt: data.createdAt || new Date(),
        };
        store.dailyProblems.set(id, dp);
        return { ...dp };
      }
      return { id: `item-${Date.now()}`, ...data };
    },

    async createMany({ data = [], skipDuplicates = false } = {}) {
      if (modelName === "userTopic") {
        let count = 0;
        for (const record of data) {
          const key = `${record.userId}_${record.topicId}`;
          if (skipDuplicates && store.userTopics.has(key)) continue;
          store.userTopics.set(key, {
            id: `ut-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            ...record,
          });
          count += 1;
        }
        return { count };
      }
      if (modelName !== "userProblemProgress") return { count: 0 };
      let count = 0;
      for (const record of data) {
        const key = `${record.userId}_${record.problemId}`;
        if (skipDuplicates && store.userProblemProgress.has(key)) continue;
        store.userProblemProgress.set(key, { ...record });
        count += 1;
      }
      return { count };
    },

    async update({ where, data, include } = {}) {
      if (modelName === "user") {
        for (const u of store.users.values()) {
          if (where.id && u.id === where.id) {
            for (const [key, value] of Object.entries(data)) {
              if (value && typeof value === "object" && "increment" in value) {
                u[key] = (u[key] || 0) + value.increment;
              } else {
                u[key] = value;
              }
            }
            u.updatedAt = new Date();
            return formatUser(u, include);
          }
        }
      }
      if (modelName === "submission") {
        const sub = store.submissions.get(where.id);
        if (sub) {
          Object.assign(sub, data);
          return sub;
        }
      }
      return { ...data };
    },

    async updateMany({ where = {}, data = {} } = {}) {
      if (modelName !== "user") return { count: 0 };
      let count = 0;
      for (const user of store.users.values()) {
        if (where.id && user.id !== where.id) continue;
        if (
          where.coins?.gte !== undefined &&
          user.coins < where.coins.gte
        ) {
          continue;
        }
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === "object" && "increment" in value) {
            user[key] = (user[key] || 0) + value.increment;
          } else if (value && typeof value === "object" && "decrement" in value) {
            user[key] = (user[key] || 0) - value.decrement;
          } else {
            user[key] = value;
          }
        }
        user.updatedAt = new Date();
        count += 1;
      }
      return { count };
    },

    async upsert({ where, update, create: createData } = {}) {
      if (modelName === "theme") {
        const existing = [...store.themes.values()].find(
          (theme) => theme.slug === where.slug || theme.id === where.id,
        );
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }
        const theme = {
          id: createData.id || `thm-${createData.slug}`,
          ...createData,
        };
        store.themes.set(theme.id, theme);
        return { ...theme };
      }
      if (modelName === "userTopic") {
        const key = where.userId_topicId
          ? `${where.userId_topicId.userId}_${where.userId_topicId.topicId}`
          : `ut_${Date.now()}`;
        let existing = store.userTopics.get(key);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        } else {
          const rec = { id: `ut-${Date.now()}`, ...createData };
          store.userTopics.set(key, rec);
          return rec;
        }
      }
      if (modelName === "topic") {
        let existing = null;
        for (const t of store.topics.values()) {
          if (where.slug && t.slug === where.slug) {
            existing = t;
            break;
          }
        }
        if (existing) {
          Object.assign(existing, update);
          return existing;
        } else {
          const rec = { id: `top-${Date.now()}`, ...createData };
          store.topics.set(rec.id, rec);
          return rec;
        }
      }
      if (modelName === "dailyProblem") {
        let existing = null;
        for (const dp of store.dailyProblems.values()) {
          if (where.istDate && dp.istDate === where.istDate) {
            existing = dp;
            break;
          }
        }
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        } else {
          const id = createData.id || `dp_${createData.istDate}`;
          const dp = { id, ...createData, createdAt: new Date() };
          store.dailyProblems.set(id, dp);
          return { ...dp };
        }
      }
      return { ...createData };
    },

    async deleteMany({ where = {} } = {}) {
      if (modelName === "userTopic") {
        let count = 0;
        for (const [key, record] of store.userTopics.entries()) {
          if (where.userId && record.userId !== where.userId) continue;
          if (where.topicId && record.topicId !== where.topicId) continue;
          store.userTopics.delete(key);
          count += 1;
        }
        return { count };
      }
      return { count: 0 };
    },

    async delete() {
      return {};
    },

    async count({ where = {} } = {}) {
      if (modelName === "user") return store.users.size;
      if (modelName === "topic") return store.topics.size;
      if (modelName === "userProblemProgress") {
        return [...store.userProblemProgress.values()].filter(
          (progress) => !where.userId || progress.userId === where.userId,
        ).length;
      }
      return 0;
    },
  };
}

function formatUser(u, include, select) {
  const user = { ...u };
  user.socialAccounts = user.socialAccounts || [];
  user.topics = [...store.userTopics.values()]
    .filter((ut) => ut.userId === u.id)
    .map((ut) => ({
      ...ut,
      topic: store.topics.get(ut.topicId) || { slug: "dsa", name: "DSA", category: "DSA" },
    }));
  if (include?.activeTheme) {
    user.activeTheme = store.themes.get(u.activeThemeId) || null;
  }
  if (include?.ownedThemes) {
    user.ownedThemes = [...store.userThemes.values()]
      .filter((ownedTheme) => ownedTheme.userId === u.id)
      .map((ownedTheme) => ({
        ...ownedTheme,
        theme: store.themes.get(ownedTheme.themeId) || null,
      }))
      .filter((ownedTheme) => ownedTheme.theme);
  }

  if (select) {
    const sel = {};
    for (const k of Object.keys(select)) {
      if (select[k]) sel[k] = user[k];
    }
    return sel;
  }
  return user;
}

// Build Prisma client or resilient fallback proxy
let realPrisma = null;

if (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("localhost:5432")) {
  try {
    let adapter;
    if (process.env.DATABASE_URL.includes("neon.tech")) {
      adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL });
    } else {
      adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
    }
    realPrisma = new PrismaClient({ adapter });
  } catch (err) {
    console.warn("[Prisma] Client init notice:", err.message);
  }
}

const fallbackProxy = new Proxy(
  {},
  {
    get(target, prop) {
      if (prop === "$connect") return async () => {};
      if (prop === "$disconnect") return async () => {};
      if (prop === "$transaction") {
        if (realPrisma) {
          return realPrisma.$transaction.bind(realPrisma);
        }
        return async (transaction) => {
          if (typeof transaction !== "function") return Promise.all(transaction);
          const result = fallbackTransactionQueue.then(() =>
            transaction(fallbackProxy),
          );
          fallbackTransactionQueue = result.then(
            () => undefined,
            () => undefined,
          );
          return result;
        };
      }

      if (realPrisma && typeof realPrisma[prop] !== "undefined") {
        const realProp = realPrisma[prop];
        if (typeof realProp === "function") {
          return realProp.bind(realPrisma);
        }
        // Wrap model calls with try-catch fallback
        const modelFallback = createModelProxy(String(prop));
        return new Proxy(realProp, {
          get(modelTarget, method) {
            const originalMethod = modelTarget[method];
            if (typeof originalMethod !== "function") return modelFallback[method];

            return async (...args) => {
              try {
                return await originalMethod.apply(modelTarget, args);
              } catch (dbErr) {
                // If database server is offline (P1001, connect failure), use fallback store
                const fallbackMethod = modelFallback[method];
                if (typeof fallbackMethod === "function") {
                  return await fallbackMethod.apply(modelFallback, args);
                }
                throw dbErr;
              }
            };
          },
        });
      }

      return createModelProxy(String(prop));
    },
  }
);

let fallbackTransactionQueue = Promise.resolve();

export default fallbackProxy;
