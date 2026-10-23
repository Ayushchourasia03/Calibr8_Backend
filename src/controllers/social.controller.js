import jwt from "jsonwebtoken";
import prisma from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";

/**
 * GET /api/social/:provider/link-url
 * Returns authorization URL for linking external social account (Protected).
 */
export const getLinkUrl = (req, res, next) => {
  try {
    const { provider } = req.params;
    const providerName = String(provider).toLowerCase();

    if (providerName !== "github") {
      throw new ApiError(404, `Unknown OAuth provider '${provider}'.`);
    }

    const stateSecret =
      process.env.OAUTH_STATE_SECRET ||
      process.env.JWT_SECRET ||
      "fallback-secret-change-me";

    const state = jwt.sign(
      { userId: req.user.id, provider: providerName },
      stateSecret,
      { expiresIn: "10m" },
    );

    const backendUrl = process.env.BACKEND_URL || "http://localhost:3000";
    const redirectUri = `${backendUrl}/api/social/${providerName}/callback`;
    const clientId = process.env.GITHUB_CLIENT_ID || "demo-github-client-id";

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "read:user user:email",
      state,
    });

    const url = `https://github.com/login/oauth/authorize?${params.toString()}`;
    res.status(200).json({ url });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/social/:provider/callback
 * OAuth redirect callback handler.
 */
export const handleCallback = async (req, res, next) => {
  try {
    const { provider } = req.params;
    const { code, state, error } = req.query;
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";

    if (error || !code || !state) {
      return res.redirect(
        `${frontendUrl}/?link_error=${encodeURIComponent("Linking was cancelled or failed.")}`,
      );
    }

    const stateSecret =
      process.env.OAUTH_STATE_SECRET ||
      process.env.JWT_SECRET ||
      "fallback-secret-change-me";

    let payload;
    try {
      payload = jwt.verify(String(state), stateSecret);
    } catch {
      return res.redirect(
        `${frontendUrl}/?link_error=${encodeURIComponent("Link request expired. Please try again.")}`,
      );
    }

    const providerName = String(provider).toLowerCase();
    if (providerName !== "github") {
      return res.redirect(
        `${frontendUrl}/?link_error=${encodeURIComponent("Unknown provider.")}`,
      );
    }

    // Fetch GitHub Profile
    let profile;
    if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
      // Mock profile fallback if credentials are not configured in environment
      profile = {
        providerUserId: "demo-gh-user-12345",
        username: "octocat-demo",
        name: "Octocat Demo",
        email: "octocat@github.dev",
        avatarUrl: "https://github.com/identicons/octocat.png",
        profileUrl: "https://github.com/octocat-demo",
        bio: "GitHub demo user in AI Studio",
        headline: null,
        stats: { publicRepos: 12, followers: 42, following: 10 },
      };
    } else {
      const backendUrl = process.env.BACKEND_URL || "http://localhost:3000";
      const redirectUri = `${backendUrl}/api/social/${providerName}/callback`;

      const tokenRes = await fetch(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            client_id: process.env.GITHUB_CLIENT_ID,
            client_secret: process.env.GITHUB_CLIENT_SECRET,
            code: String(code),
            redirect_uri: redirectUri,
          }),
        },
      );
      const token = await tokenRes.json();
      if (!token.access_token) {
        throw new ApiError(
          400,
          token.error_description || "GitHub token exchange failed",
        );
      }

      const headers = {
        Authorization: `Bearer ${token.access_token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "calibr8",
      };

      const gh = await (
        await fetch("https://api.github.com/user", { headers })
      ).json();
      if (!gh.id) throw new ApiError(400, "Could not read GitHub profile.");

      let email = gh.email;
      if (!email) {
        const emails = await (
          await fetch("https://api.github.com/user/emails", { headers })
        ).json();
        email = Array.isArray(emails)
          ? emails.find((e) => e.primary && e.verified)?.email
          : null;
      }

      profile = {
        providerUserId: String(gh.id),
        username: gh.login,
        name: gh.name || gh.login,
        email: email ?? null,
        avatarUrl: gh.avatar_url,
        profileUrl: gh.html_url,
        bio: gh.bio ?? null,
        headline: null,
        stats: {
          publicRepos: gh.public_repos,
          followers: gh.followers,
          following: gh.following,
        },
      };
    }

    // Verify account is not linked to another user
    const existing = await prisma.socialAccount.findUnique({
      where: {
        provider_providerUserId: {
          provider: providerName,
          providerUserId: profile.providerUserId,
        },
      },
    });

    if (existing && existing.userId !== payload.userId) {
      return res.redirect(
        `${frontendUrl}/?link_error=${encodeURIComponent(`This ${providerName} account is already linked to another user.`)}`,
      );
    }

    // Upsert social account
    await prisma.socialAccount.upsert({
      where: {
        userId_provider: {
          userId: payload.userId,
          provider: providerName,
        },
      },
      create: {
        userId: payload.userId,
        provider: providerName,
        ...profile,
      },
      update: {
        ...profile,
        connectedAt: new Date(),
      },
    });

    res.redirect(`${frontendUrl}/?linked=${providerName}`);
  } catch (err) {
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    res.redirect(
      `${frontendUrl}/?link_error=${encodeURIComponent(err.message || "Could not link account.")}`,
    );
  }
};

/**
 * DELETE /api/social/:provider
 * Unlinks the given social provider from the authenticated user (Protected).
 */
export const unlinkProvider = async (req, res, next) => {
  try {
    const { provider } = req.params;
    const count = await prisma.socialAccount.deleteMany({
      where: {
        userId: req.user.id,
        provider: String(provider).toLowerCase(),
      },
    });

    res.status(200).json({ success: true, count });
  } catch (err) {
    next(err);
  }
};
