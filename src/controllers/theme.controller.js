import prisma from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";
import { getUserHeaderStats } from "../utils/userHeaderStats.js";
import { ensureStoreThemes, getStoreTheme } from "../data/storeThemes.js";

let themeCatalogSetup;

async function ensureThemeCatalog() {
  if (!themeCatalogSetup) {
    themeCatalogSetup = ensureStoreThemes(prisma).catch((error) => {
      themeCatalogSetup = null;
      throw error;
    });
  }
  await themeCatalogSetup;
}

export const getAllThemes = async (req, res, next) => {
  try {
    await ensureThemeCatalog();
    const themes = await prisma.theme.findMany({ orderBy: [{ price: 'asc' }] });
    const owned = await prisma.userTheme.findMany({ where: { userId: req.user.id } });
    const user = await prisma.user.findUnique({ 
      where: { id: req.user.id }, 
      include: { activeTheme: true }
    });
    
    const ownedSet = new Set(owned.map(o => o.themeId));
    const activeId = user?.activeTheme?.id || null;

    res.json({
      success: true,
      coins: user?.coins ?? 0,
      themes: themes.map(t => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        price: t.price,
        previewColor: t.previewColor,
        isDefault: t.isDefault,
        owned: t.isDefault || ownedSet.has(t.id),
        applied: activeId === t.id,
        canAfford: (user?.coins ?? 0) >= t.price
      }))
    });
  } catch (e) {
    next(e);
  }
};

export const buyTheme = async (req, res, next) => {
  try {
    const { slug } = req.params;
    const userId = req.user.id;

    const catalogTheme = getStoreTheme(slug);
    if (!catalogTheme) {
      throw new ApiError(404, "Theme not found", "NOT_FOUND");
    }
    await ensureThemeCatalog();
    const theme = await prisma.theme.findUnique({ where: { slug } });
    if (!theme) {
      throw new ApiError(404, "Theme not found", "NOT_FOUND");
    }

    const purchase = await prisma.$transaction(async (tx) => {
      const alreadyOwned = await tx.userTheme.findFirst({
        where: { userId, themeId: theme.id },
      });
      if (alreadyOwned) {
        throw new ApiError(400, "Already owned", "ALREADY_OWNED", {
          owned: true,
        });
      }

      const debit = await tx.user.updateMany({
        where: { id: userId, coins: { gte: theme.price } },
        data: {
          coins: { decrement: theme.price },
          activeThemeId: theme.id,
        },
      });
      if (debit.count === 0) {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { coins: true },
        });
        if (!user) {
          throw new ApiError(404, "User not found", "USER_NOT_FOUND");
        }
        throw new ApiError(
          400,
          "Not enough coins",
          "INSUFFICIENT_COINS",
          { required: theme.price, have: user.coins ?? 0 },
        );
      }

      await tx.userTheme.create({ data: { userId, themeId: theme.id } });
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: {
          rating: true,
          score: true,
          coins: true,
          streak: true,
          longestStreak: true,
        },
      });
      return user;
    });

    res.json({
      success: true,
      message: `Bought ${theme.name}`,
      theme: { slug: theme.slug, applied: true, owned: true },
      coins: purchase.coins,
      stats: getUserHeaderStats(purchase),
    });
  } catch (e) {
    if (e.code === "P2002") {
      return next(
        new ApiError(400, "Already owned", "ALREADY_OWNED", { owned: true }),
      );
    }
    next(e);
  }
};

export const applyTheme = async (req, res, next) => {
  try {
    const { slug } = req.body;
    if (!slug) {
      throw new ApiError(400, "slug required", "BAD_REQUEST");
    }

    if (!getStoreTheme(slug)) {
      throw new ApiError(404, "Theme not found", "NOT_FOUND");
    }
    await ensureThemeCatalog();
    const theme = await prisma.theme.findUnique({ where: { slug } });
    if (!theme) {
      throw new ApiError(404, "Theme not found", "NOT_FOUND");
    }

    const owned = await prisma.userTheme.findFirst({ where: { userId: req.user.id, themeId: theme.id } });
    if (!owned && !theme.isDefault) {
      throw new ApiError(403, "You don't own this theme, buy first", "FORBIDDEN");
    }

    await prisma.user.update({
      where: { id: req.user.id },
      data: { activeThemeId: theme.id },
    });

    res.json({ success: true, activeTheme: theme.slug, message: `${theme.name} applied` });
  } catch (e) {
    next(e);
  }
};

export const getMyThemeStatus = async (req, res, next) => {
  try {
    await ensureThemeCatalog();
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { activeTheme: true, ownedThemes: { include: { theme: true } } }
    });

    if (!user) {
      throw new ApiError(404, "User not found", "NOT_FOUND");
    }

    res.json({
      success: true,
      coins: user.coins,
      activeTheme: user.activeTheme?.slug || 'default',
      ownedThemes: (user.ownedThemes || []).map(o => o.theme.slug)
    });
  } catch (e) {
    next(e);
  }
};