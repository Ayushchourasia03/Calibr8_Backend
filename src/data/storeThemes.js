export const STORE_THEMES = [
  { slug: "default", name: "Default", price: 0, previewColor: "#2F7BFF", isDefault: true },
  { slug: "orbit", name: "Orbit", price: 450, previewColor: "#35E6FF", isDefault: false },
  { slug: "frost", name: "Frost", price: 400, previewColor: "#EEF0FA", isDefault: false },
  { slug: "editorial", name: "Editorial", price: 400, previewColor: "#F7F4EE", isDefault: false },
  { slug: "mono", name: "Monochrome", price: 350, previewColor: "#161616", isDefault: false },
  { slug: "pearl", name: "Pearl", price: 350, previewColor: "#ECECEE", isDefault: false },
  { slug: "arcade", name: "Arcade", price: 800, previewColor: "#FF2E97", isDefault: false },
  { slug: "racer", name: "Racer", price: 800, previewColor: "#FF1E1E", isDefault: false },
  { slug: "anime", name: "Sakura Manga", price: 700, previewColor: "#FF4F8B", isDefault: false },
  { slug: "comic", name: "Hero Comic", price: 700, previewColor: "#E5232B", isDefault: false },
  { slug: "storybook", name: "Storybook Kingdom", price: 700, previewColor: "#C9922E", isDefault: false },
];

export async function ensureStoreThemes(prisma) {
  await Promise.all(
    STORE_THEMES.map((theme) =>
      prisma.theme.upsert({
        where: { slug: theme.slug },
        update: {
          name: theme.name,
          price: theme.price,
          previewColor: theme.previewColor,
          isDefault: theme.isDefault,
        },
        create: theme,
      }),
    ),
  );
}

export function getStoreTheme(slug) {
  return STORE_THEMES.find((theme) => theme.slug === slug) || null;
}
