import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import prisma from '../src/config/db.js';

function mapProblemPayload(data, slug) {
  const timeLimit = data.timeLimit || data.time_limit || 1000;
  const memoryLimit = data.memoryLimit || data.memory_limit || 256;
  const tags =
    Array.isArray(data.tags) && data.tags.length > 0
      ? data.tags.map(String)
      : data.topic
        ? [String(data.topic)]
        : [];

  const examples = (data.examples || []).map((ex, idx) => ({
    order: ex.order ?? idx,
    input: String(ex.input ?? ''),
    output: String(ex.output ?? ''),
    explanation:
      ex.explanation != null && String(ex.explanation).trim() !== ''
        ? String(ex.explanation)
        : null,
  }));

  const testcases = (data.testcases || []).map((tc, idx) => {
    const input = tc.input ?? tc.stdinSmall ?? tc.stdin ?? tc.stdin_small ?? '';
    const output = tc.output ?? tc.expectedSmall ?? tc.expected ?? tc.expected_small ?? '';
    const inputStr = typeof input === 'object' ? JSON.stringify(input) : String(input);
    const outputStr = typeof output === 'object' ? JSON.stringify(output) : String(output);
    return {
      testIndex: tc.testIndex ?? tc.index ?? idx,
      isVisible: tc.isVisible ?? tc.visible ?? true,
      stdinSmall: inputStr,
      expectedSmall: outputStr,
      sizeBytes: Buffer.byteLength(inputStr, 'utf8'),
      r2Key: tc.r2Key || null,
    };
  });

  const templates = Object.entries(data.templates || {}).map(([lang, code]) => ({
    language: lang,
    code: typeof code === 'object' && code !== null ? JSON.stringify(code) : String(code),
  }));

  return {
    title: data.title || slug,
    description: data.description || data.title || 'No description',
    difficulty: data.difficulty || 'Easy',
    timeLimit,
    memoryLimit,
    tags,
    examples,
    testcases,
    templates,
  };
}

async function uploadProblem(jsonPath, forceUpdate = false, testcasesOnly = false) {
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const data = JSON.parse(raw);
  const slug = data.slug || path.basename(jsonPath, '.json');
  const payload = mapProblemPayload(data, slug);

  const existing = await prisma.problem.findUnique({
    where: { slug },
    include: { _count: { select: { examples: true, testcases: true, templates: true } } },
  });

  if (testcasesOnly) {
    if (!existing) {
      console.log(`⏭️  SKIP ${slug} - not in DB (--testcases-only never creates problems)`);
      return { status: 'skipped', slug };
    }
    // One write: old testcases are deleted and new ones inserted atomically.
    const updated = await prisma.problem.update({
      where: { id: existing.id },
      data: { testcases: { deleteMany: {}, createMany: { data: payload.testcases } } },
      include: { _count: { select: { testcases: true } } },
    });
    console.log(
      `🔄 TESTCASES ${updated.slug} (#${updated.problemNumber}) - ${existing._count.testcases} -> ${updated._count.testcases} TCs (other fields untouched)`,
    );
    return { status: 'updated', slug: updated.slug };
  }

  if (existing) {
    if (forceUpdate) {
      const updated = await prisma.problem.update({
        where: { id: existing.id },
        data: {
          title: payload.title,
          description: payload.description,
          difficulty: payload.difficulty,
          timeLimit: payload.timeLimit,
          memoryLimit: payload.memoryLimit,
          tags: payload.tags,
          examples: { deleteMany: {}, create: payload.examples },
          testcases: { deleteMany: {}, create: payload.testcases },
          templates: { deleteMany: {}, create: payload.templates },
        },
        include: { _count: { select: { examples: true, testcases: true, templates: true } } },
      });
      console.log(
        `🔄 UPDATED ${updated.slug} (#${updated.problemNumber}) - ${updated._count.examples} examples, ${updated._count.testcases} TCs, ${updated._count.templates} templates`,
      );
      return { status: 'updated', slug: updated.slug };
    }

    if (existing._count.examples === 0 && payload.examples.length > 0) {
      await prisma.example.createMany({
        data: payload.examples.map((ex) => ({
          problemId: existing.id,
          ...ex,
        })),
      });
      console.log(
        `🔄 BACKFILLED ${slug} (#${existing.problemNumber}) - added ${payload.examples.length} examples`,
      );
      return { status: 'updated', slug };
    }

    console.log(`⏭️  SKIP ${slug} - already exists in DB (use --update to overwrite)`);
    return { status: 'skipped', slug };
  }

  const created = await prisma.problem.create({
    data: {
      slug,
      title: payload.title,
      description: payload.description,
      difficulty: payload.difficulty,
      timeLimit: payload.timeLimit,
      memoryLimit: payload.memoryLimit,
      tags: payload.tags,
      examples: { create: payload.examples },
      testcases: { create: payload.testcases },
      templates: { create: payload.templates },
    },
    include: { _count: { select: { examples: true, testcases: true, templates: true } } },
  });

  console.log(
    `✅ NEW ${created.slug} (#${created.problemNumber}) - ${created._count.examples} examples, ${created._count.testcases} TCs, ${created._count.templates} templates`,
  );
  return { status: 'added', slug: created.slug };
}

const args = process.argv.slice(2);
const forceUpdate = args.includes('--update') || args.includes('--force');
const testcasesOnly = args.includes('--testcases-only');
const target = args.find((a) => !a.startsWith('--'));

if (!target) {
  console.log('Usage: node scripts/upload-problem.js ./problems [--update | --testcases-only]');
  process.exit(1);
}

const results = { added: 0, updated: 0, skipped: 0 };

try {
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    const files = fs.readdirSync(target).filter((f) => f.endsWith('.json')).sort();
    console.log(`📂 Found ${files.length} JSON files in ${target}\n`);
    for (const f of files) {
      const fullPath = path.join(target, f);
      const res = await uploadProblem(fullPath, forceUpdate, testcasesOnly);
      results[res.status]++;
    }
  } else {
    const res = await uploadProblem(target, forceUpdate, testcasesOnly);
    results[res.status]++;
  }
} finally {
  await prisma.$disconnect();
}

console.log(
  `\n🎉 DONE - Added: ${results.added}, Updated: ${results.updated}, Skipped: ${results.skipped}`,
);

// ==============================================================================
// SCRIPT DOCUMENTATION & USAGE GUIDE
// ==============================================================================
/**
 * WHAT IS THE NEED FOR THIS SCRIPT:
 * ---------------------------------
 * 1. Incremental Problem, Example & Testcase Ingestion:
 *    Reads problem JSON files from `./problems` (including metadata, LeetCode-style
 *    `examples`, `testcases`, and structured `templates`) and persists them into
 *    PostgreSQL via Prisma.
 *
 * 2. Safe Backfill & Optional Full Sync:
 *    - If a problem does not exist, creates it with examples, testcases, and templates.
 *    - If a problem exists with 0 examples, automatically backfills `examples`.
 *    - Pass `--update` (or `--force`) to replace examples, testcases, and templates.
 *    - Pass `--testcases-only` to replace only the testcases of an existing problem
 *      (examples, templates, tags, description, limits are left as they are in the DB).
 *
 * HOW TO USE THIS SCRIPT:
 * -----------------------
 * 1. Upload/backfill all JSON problem files in `./problems`:
 *    $ node scripts/upload-problem.js ./problems
 *
 * 2. Force-update all existing problems with latest examples, TCs, and templates:
 *    $ node scripts/upload-problem.js ./problems --update
 *
 * 3. Upload a single problem JSON file:
 *    $ node scripts/upload-problem.js ./problems/two-sum.json
 *
 * 4. Replace only the testcases of one problem (e.g. after regenerating them):
 *    $ node scripts/upload-problem.js ./problems/two-sum.json --testcases-only
 */