import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import prisma from '../src/config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function seedProblems() {
  const problemsDir = path.resolve(__dirname, '../problems');
  const forceUpdate = process.argv.includes('--update') || process.argv.includes('--force');

  if (!fs.existsSync(problemsDir)) {
    console.error(`❌ Problems directory not found at: ${problemsDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(problemsDir).filter((f) => f.endsWith('.json')).sort();
  console.log(`📂 Found ${files.length} problem JSON files to seed into database\n`);

  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const file of files) {
    try {
      const fullPath = path.join(problemsDir, file);
      const raw = fs.readFileSync(fullPath, 'utf8');
      const data = JSON.parse(raw);
      const slug = data.slug || path.basename(file, '.json').toLowerCase();

      const timeLimit = data.timeLimit || data.time_limit || 1000;
      const memoryLimit = data.memoryLimit || data.memory_limit || 256;
      const tags = Array.isArray(data.tags) ? data.tags.map(String) : [];

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
        const input = tc.input ?? tc.stdinSmall ?? tc.stdin ?? '';
        const output = tc.output ?? tc.expectedSmall ?? tc.expected ?? '';
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

      const existing = await prisma.problem.findUnique({
        where: { slug },
        include: { _count: { select: { examples: true, testcases: true, templates: true } } },
      });

      if (existing) {
        if (forceUpdate) {
          const synced = await prisma.problem.update({
            where: { id: existing.id },
            data: {
              title: data.title || slug,
              description: data.description || data.title || 'No description',
              difficulty: data.difficulty || 'Easy',
              timeLimit,
              memoryLimit,
              tags,
              examples: { deleteMany: {}, create: examples },
              testcases: { deleteMany: {}, create: testcases },
              templates: { deleteMany: {}, create: templates },
            },
            include: { _count: { select: { examples: true, testcases: true, templates: true } } },
          });
          console.log(
            `🔄 Updated #${synced.problemNumber} ${synced.slug} (${synced._count.examples} examples, ${synced._count.testcases} TCs, ${synced._count.templates} templates)`,
          );
          updated++;
        } else if (existing._count.examples === 0 && examples.length > 0) {
          await prisma.example.createMany({
            data: examples.map((ex) => ({
              problemId: existing.id,
              ...ex,
            })),
          });
          console.log(
            `🔄 Backfilled ${examples.length} examples for #${existing.problemNumber} ${existing.slug}`,
          );
          updated++;
        } else {
          console.log(`⏭️  SKIP ${slug} - already exists in database`);
          skipped++;
        }
        continue;
      }

      const created = await prisma.problem.create({
        data: {
          slug,
          title: data.title || slug,
          description: data.description || data.title || 'No description',
          difficulty: data.difficulty || 'Easy',
          timeLimit,
          memoryLimit,
          tags,
          examples: { create: examples },
          testcases: { create: testcases },
          templates: { create: templates },
        },
        include: {
          _count: { select: { examples: true, testcases: true, templates: true } },
        },
      });

      console.log(
        `✅ Created #${created.problemNumber} ${created.slug} (${created._count.examples} examples, ${created._count.testcases} TCs, ${created._count.templates} templates)`,
      );
      added++;
    } catch (err) {
      console.error(`❌ Failed to process ${file}:`, err.message);
    }
  }

  console.log(
    `\n🎉 Problem Seeding Finished — Added: ${added}, Updated: ${updated}, Skipped: ${skipped}`,
  );
}

seedProblems()
  .catch((e) => {
    console.error('❌ Seeding problems failed:', e.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
