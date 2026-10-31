import prisma from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";

export const getAllThemes = async (req, res, next) => {
  try {
    const themes = await prisma.theme.findMany({ orderBy: [{ price: "asc" }] });
    const owned = await prisma.userTheme.findMany({
      where: { userId: req.user.id },
    });
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { activeTheme: true },
    });

    const ownedSet = new Set(owned.map((o) => o.themeId));
    const activeId = user?.activeTheme?.id || null;

    res.json({
      success: true,
      coins: user?.coins ?? 0,
      themes: themes.map((t) => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        price: t.price,
        previewColor: t.previewColor,
        isDefault: t.isDefault,
        owned: ownedSet.has(t.id),
        applied: activeId === t.id,
        canAfford: (user?.coins ?? 0) >= t.price,
      })),
    });
  } catch (e) {
    next(e);
  }
};

export const buyTheme = async (req, res, next) => {
  try {
    const { slug } = req.params;
    const userId = req.user.id;

    const theme = await prisma.theme.findUnique({ where: { slug } });
    if (!theme) {
      throw new ApiError(404, "Theme not found", "NOT_FOUND");
    }

    const remainingCoins = await prisma.$transaction(async (tx) => {
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
        data: { coins: { decrement: theme.price } },
      });
      if (debit.count !== 1) {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { coins: true },
        });
        throw new ApiError(400, "Not enough coins", "INSUFFICIENT_COINS", {
          required: theme.price,
          have: user?.coins ?? 0,
        });
      }

      await tx.userTheme.create({ data: { userId, themeId: theme.id } });
      await tx.user.update({
        where: { id: userId },
        data: { activeTheme: { connect: { id: theme.id } } },
      });

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { coins: true },
      });
      return user.coins;
    });

    res.json({
      success: true,
      message: `Bought ${theme.name}`,
      theme: { slug: theme.slug, applied: true, owned: true },
      coins: remainingCoins,
    });
  } catch (e) {
    next(e);
  }
};

export const applyTheme = async (req, res, next) => {
  try {
    const { slug } = req.body;
    if (!slug) {
      throw new ApiError(400, "slug required", "BAD_REQUEST");
    }

    const theme = await prisma.theme.findUnique({ where: { slug } });
    if (!theme) {
      throw new ApiError(404, "Theme not found", "NOT_FOUND");
    }

    const owned = await prisma.userTheme.findFirst({
      where: { userId: req.user.id, themeId: theme.id },
    });
    if (!owned) {
      throw new ApiError(
        403,
        "You don't own this theme, buy first",
        "FORBIDDEN",
      );
    }

    await prisma.user.update({
      where: { id: req.user.id },
      data: { activeTheme: { connect: { id: theme.id } } },
    });

    res.json({
      success: true,
      activeTheme: theme.slug,
      message: `${theme.name} applied`,
    });
  } catch (e) {
    next(e);
  }
};

export const getMyThemeStatus = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { activeTheme: true, ownedThemes: { include: { theme: true } } },
    });

    if (!user) {
      throw new ApiError(404, "User not found", "NOT_FOUND");
    }

    res.json({
      success: true,
      coins: user.coins,
      activeTheme: user.activeTheme?.slug || "default",
      ownedThemes: (user.ownedThemes || []).map((o) => o.theme.slug),
    });
  } catch (e) {
    next(e);
  }
};
