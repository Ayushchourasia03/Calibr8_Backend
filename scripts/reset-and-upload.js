import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import prisma from '../src/config/db.js';

console.log('🔥 Step 1: Deleting all old problems, examples, testcases & resetting...');

try {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "problems", "examples", "testcases", "code_templates", "submissions" RESTART IDENTITY CASCADE;`,
  );
  console.log('✅ Tables cleaned (problems, examples, testcases, code_templates, submissions)');
} catch (e) {
  console.log('⚠️  TRUNCATE failed, trying DELETE...');
  await prisma.$executeRawUnsafe(
    `DELETE FROM "examples"; DELETE FROM "testcases"; DELETE FROM "code_templates"; DELETE FROM "problems";`,
  );
  console.log('✅ Deleted via DELETE');
}

const problemsDir = './problems';
const files = fs.readdirSync(problemsDir).filter((f) => f.endsWith('.json')).sort();
console.log(`\n📂 Found ${files.length} problems:`, files);

for (const file of files) {
  const fullPath = path.join(problemsDir, file);
  const raw = fs.readFileSync(fullPath, 'utf8');
  const p = JSON.parse(raw);
  const slug = p.slug || file.replace('.json', '');
  console.log(`\nPushing ${slug}...`);

  const timeLimit = p.timeLimit || p.time_limit || 1000;
  const memoryLimit = p.memoryLimit || p.memory_limit || 256;
  const tags = Array.isArray(p.tags) ? p.tags.map(String) : [];

  const examples = (p.examples || []).map((ex, idx) => ({
    order: ex.order ?? idx,
    input: String(ex.input ?? ''),
    output: String(ex.output ?? ''),
    explanation:
      ex.explanation != null && String(ex.explanation).trim() !== ''
        ? String(ex.explanation)
        : null,
  }));

  const testcases = (p.testcases || []).map((tc, idx) => {
    const input = tc.input ?? tc.stdinSmall ?? tc.stdin ?? tc.stdin_small ?? '';
    const output = tc.output ?? tc.expectedSmall ?? tc.expected ?? tc.expected_small ?? '';
    const inputStr = typeof input === 'object' ? JSON.stringify(input) : String(input);
    const outputStr = typeof output === 'object' ? JSON.stringify(output) : String(output);
    return {
      testIndex: tc.testIndex ?? tc.index ?? idx,
      isVisible: tc.isVisible ?? true,
      stdinSmall: inputStr,
      expectedSmall: outputStr,
      sizeBytes: Buffer.byteLength(inputStr, 'utf8'),
      r2Key: tc.r2Key || null,
    };
  });

  const templates = Object.entries(p.templates || {}).map(([lang, code]) => ({
    language: lang,
    code: typeof code === 'object' && code !== null ? JSON.stringify(code) : String(code),
  }));

  try {
    const created = await prisma.problem.create({
      data: {
        slug,
        title: p.title || slug,
        description: p.description || p.title || 'No description',
        difficulty: p.difficulty || 'Easy',
        timeLimit,
        memoryLimit,
        tags,
        examples: { create: examples },
        testcases: { create: testcases },
        templates: { create: templates },
      },
    });
    console.log(
      `✅ #${created.problemNumber} - ${created.slug} (${examples.length} examples, ${testcases.length} TCs, ${templates.length} templates)`,
    );
  } catch (e) {
    console.error(`❌ Failed ${file}:`, e.message);
  }
}

const all = await prisma.problem.findMany({
  orderBy: { problemNumber: 'asc' },
  select: {
    problemNumber: true,
    slug: true,
    title: true,
    _count: { select: { examples: true, testcases: true, templates: true } },
  },
});
console.log('\n🎉 FINAL LIST:');
console.table(
  all.map((item) => ({
    problemNumber: item.problemNumber,
    slug: item.slug,
    title: item.title,
    examples: item._count.examples,
    testcases: item._count.testcases,
    templates: item._count.templates,
  })),
);

await prisma.$disconnect();

// ==============================================================================
// SCRIPT DOCUMENTATION & USAGE GUIDE
// ==============================================================================
/**
 * WHAT IS THE NEED FOR THIS SCRIPT:
 * ---------------------------------
 * 1. Clean Slate Seeding / Database Reset:
 *    Truncates problems, examples, testcases, code_templates, and submissions tables
 *    and resets auto-incrementing problem numbers.
 *
 * 2. Complete Fresh Import of the Problem Catalogue:
 *    Iterates through all JSON problem files in `./problems/` in sorted order and
 *    creates each problem with its `examples`, `testcases`, and `templates`.
 *
 * ⚠️ WARNING:
 * -----------
 * This script is DESTRUCTIVE. It wipes existing problem data, examples, testcases,
 * and submissions from the connected database.
 *
 * HOW TO USE THIS SCRIPT:
 * -----------------------
 * $ node scripts/reset-and-upload.js
 */