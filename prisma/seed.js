import prisma from "../src/config/db.js";
import { STORE_THEMES } from "../src/data/storeThemes.js";
import { TOPIC_CATALOG } from "../src/data/topicCatalog.js";

async function main() {
  console.log(`🌱 Seeding ${TOPIC_CATALOG.length} topics...`);
  for (const t of TOPIC_CATALOG) {
    await prisma.topic.upsert({
      where: { slug: t.slug },
      update: { name: t.name, category: t.category },
      create: t,
    });
    console.log(`  ✅ [${t.category}] ${t.slug} - ${t.name}`);
  }
  console.log(`🌱 Seeding ${STORE_THEMES.length} themes...`);
  for (const theme of STORE_THEMES) {
    await prisma.theme.upsert({
      where: { slug: theme.slug },
      update: {
        name: theme.name,
        price: theme.price,
        previewColor: theme.previewColor,
        isDefault: theme.isDefault,
      },
      create: theme,
    });
  }
  console.log(`\n🎉 Successfully seeded ${TOPIC_CATALOG.length} topics and ${STORE_THEMES.length} themes.`);
}

main()
  .catch((e) => {
    console.error("❌ Seeding failed:", e.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
