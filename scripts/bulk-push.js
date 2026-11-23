import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import prisma from '../src/config/db.js';
import { requireDestructiveConfirmation } from './lib/dbGuard.js';

requireDestructiveConfirmation('delete and re-create every problem found in problems/');

const files = process.argv.slice(2);
if (files.length === 0) {
  console.log('Usage: node scripts/bulk-push.js ./problems/file1.json');
  process.exit(1);
}

try {
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    const p = JSON.parse(raw);
    const slug = p.slug || path.basename(file, '.json');
    console.log(`\nPushing ${slug}...`);

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
      const input = tc.input ?? tc.stdinSmall ?? tc.stdin ?? '';
      const output = tc.output ?? tc.expectedSmall ?? tc.expected ?? '';
      const inputStr = typeof input === 'object' ? JSON.stringify(input) : String(input);
      const outputStr = typeof output === 'object' ? JSON.stringify(output) : String(output);
      return {
        testIndex: tc.testIndex ?? idx,
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

    const createData = {
      slug,
      title: p.title || slug,
      description: p.description || p.title || 'No description',
      difficulty: p.difficulty || 'Easy',
      timeLimit: p.timeLimit || 1000,
      memoryLimit: p.memoryLimit || 256,
      tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
      examples: { create: examples },
      testcases: { create: testcases },
      templates: { create: templates },
    };

    const includeCounts = {
      _count: { select: { examples: true, testcases: true, templates: true } },
    };

    try {
      const created = await prisma.problem.create({
        data: createData,
        include: includeCounts,
      });
      console.log(
        `✅ Created ${created.slug} (#${created.problemNumber}) with ${created._count.examples} examples, ${created._count.testcases} TCs, ${created._count.templates} templates`,
      );
    } catch (e) {
      if (e.code === 'P2002') {
        console.log(`⚠️  ${slug} exists, deleting and re-creating...`);
        try {
          await prisma.problem.delete({ where: { slug } });
        } catch (deleteErr) {
          // daily_problems references it (ON DELETE RESTRICT): deleting would
          // erase daily history and users' completions.
          if (deleteErr.code !== 'P2003') throw deleteErr;
          console.error(
            `❌ Skipped ${slug}: it has been a daily problem, so it cannot be deleted. ` +
              `Update it in place with: node scripts/upload-problem.js <file> --update (or --testcases-only)`,
          );
          continue;
        }
        const created = await prisma.problem.create({
          data: createData,
          include: includeCounts,
        });
        console.log(
          `✅ Re-created ${created.slug} (#${created.problemNumber}) with ${created._count.examples} examples, ${created._count.testcases} TCs, ${created._count.templates} templates`,
        );
      } else {
        console.error(e.message);
      }
    }
  }
} finally {
  await prisma.$disconnect();
}