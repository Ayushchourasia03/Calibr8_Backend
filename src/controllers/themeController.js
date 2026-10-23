import prisma from "../config/db.js";

export const getAllThemes = async (req, res) => {
  try {
    const themes = await prisma.theme.findMany({ orderBy: [{ price: 'asc' }] });
    const owned = await prisma.userTheme.findMany({ where: { userId: req.user.id } });
    const user = await prisma.user.findUnique({ 
      where: { id: req.user.id }, 
      include: { activeTheme: true }
    });
    
    const ownedSet = new Set(owned.map(o => o.themeId));
    const activeId = user.activeTheme?.id || null;

    res.json({
      success: true,
      coins: user.coins,
      themes: themes.map(t => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        price: t.price,
        previewColor: t.previewColor,
        isDefault: t.isDefault,
        owned: ownedSet.has(t.id),
        applied: activeId === t.id,
        canAfford: user.coins >= t.price
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const buyTheme = async (req, res) => {
  try {
    const { slug } = req.params;
    const userId = req.user.id;

    const theme = await prisma.theme.findUnique({ where: { slug } });
    if (!theme) return res.status(404).json({ error: "Theme not found" });

    const alreadyOwned = await prisma.userTheme.findFirst({ where: { userId, themeId: theme.id } });
    if (alreadyOwned) return res.status(400).json({ error: "Already owned", owned: true });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (user.coins < theme.price) {
      return res.status(400).json({ error: "Not enough coins", required: theme.price, have: user.coins });
    }

    // Fixed transaction - no transaction table
    await prisma.$transaction([
      prisma.user.update({ where: { id: userId }, data: { coins: { decrement: theme.price } } }),
      prisma.userTheme.create({ data: { userId, themeId: theme.id } }),
    ]);

    // Auto-apply - using relation connect
    await prisma.user.update({ 
      where: { id: userId }, 
      data: { activeTheme: { connect: { id: theme.id } } } 
    });

    res.json({
      success: true,
      message: `Bought ${theme.name}`,
      theme: { slug: theme.slug, applied: true, owned: true },
      coins: user.coins - theme.price
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const applyTheme = async (req, res) => {
  try {
    const { slug } = req.body;
    if (!slug) return res.status(400).json({ error: "slug required" });

    const theme = await prisma.theme.findUnique({ where: { slug } });
    if (!theme) return res.status(404).json({ error: "Theme not found" });

    const owned = await prisma.userTheme.findFirst({ where: { userId: req.user.id, themeId: theme.id } });
    if (!owned) return res.status(403).json({ error: "You don't own this theme, buy first" });

    // FIXED - use relation
    await prisma.user.update({
      where: { id: req.user.id },
      data: { activeTheme: { connect: { id: theme.id } } }
    });

    res.json({ success: true, activeTheme: theme.slug, message: `${theme.name} applied` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const getMyThemeStatus = async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { activeTheme: true, ownedThemes: { include: { theme: true } } }
  });
  res.json({
    coins: user.coins,
    activeTheme: user.activeTheme?.slug || 'default',
    ownedThemes: user.ownedThemes.map(o => o.theme.slug)
  });
};