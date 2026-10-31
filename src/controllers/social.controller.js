import jwt from "jsonwebtoken";
import prisma from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";
import { OAUTH_STATE_SECRET } from "../config/jwt.js";

/**
 * Validates frontend redirect URL against an allow-list to prevent open redirect vulnerabilities.
 */
function getSafeFrontendRedirect(targetUrl, req) {
  const configured = (process.env.FRONTEND_URL || "http://localhost:5173")
    .split(",")
    .map((u) => u.trim().replace(/\/+$/, ""))
    .filter(Boolean);

  const allowedOrigins = [
    ...configured,
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ];

  if (targetUrl) {
    try {
      const parsed = new URL(targetUrl);
      const isAllowed = allowedOrigins.some((origin) => {
        try {
          return new URL(origin).origin === parsed.origin;
        } catch {
          return false;
        }
      });
      if (isAllowed) {
        return parsed.origin;
      }
    } catch {
      // Invalid URL
    }
  }

  return allowedOrigins[0] || "http://localhost:5173";
}

/**
 * GET /api/social/:provider/link-url
 * Returns authorization URL for linking external social account (Protected).
 */
export const getLinkUrl = (req, res, next) => {
  try {
    const { provider } = req.params;
    const providerName = String(provider).toLowerCase();

    if (providerName !== "github") {
      throw new ApiError(
        404,
        `Unknown OAuth provider '${provider}'.`,
        "UNKNOWN_PROVIDER",
      );
    }

    // Uses OAUTH_STATE_SECRET strictly kept separate from JWT_SECRET
    const state = jwt.sign(
      { userId: req.user.id, provider: providerName },
      OAUTH_STATE_SECRET,
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
 * SECURITY:
 * 1. Uses short error codes (CANCELLED, EXPIRED, etc.) instead of raw error messages.
 * 2. Enforces allow-list on redirect destination to prevent open redirect vulnerabilities.
 */
export const handleCallback = async (req, res, next) => {
  const safeFrontend = getSafeFrontendRedirect(
    req.query.redirect_uri || process.env.FRONTEND_URL,
    req,
  );

  try {
    const { provider } = req.params;
    const { code, state, error } = req.query;

    if (error || !code || !state) {
      return res.redirect(`${safeFrontend}/?link_error=CANCELLED`);
    }

    let payload;
    try {
      // Verify with OAUTH_STATE_SECRET
      payload = jwt.verify(String(state), OAUTH_STATE_SECRET);
    } catch {
      return res.redirect(`${safeFrontend}/?link_error=EXPIRED`);
    }

    const providerName = String(provider).toLowerCase();
    if (providerName !== "github") {
      return res.redirect(`${safeFrontend}/?link_error=UNKNOWN_PROVIDER`);
    }

    if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
      return res.redirect(`${safeFrontend}/?link_error=CONFIGURATION`);
    }

    // Fetch GitHub Profile
    let profile;
    {
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
        return res.redirect(`${safeFrontend}/?link_error=AUTH_FAILED`);
      }

      const headers = {
        Authorization: `Bearer ${token.access_token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "calibr8",
      };

      const gh = await (
        await fetch("https://api.github.com/user", { headers })
      ).json();
      if (!gh.id) {
        return res.redirect(`${safeFrontend}/?link_error=AUTH_FAILED`);
      }

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
      return res.redirect(`${safeFrontend}/?link_error=ALREADY_LINKED`);
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

    res.redirect(`${safeFrontend}/?linked=${providerName}`);
  } catch (err) {
    console.error("[OAuth Callback Error]", err.message);
    res.redirect(`${safeFrontend}/?link_error=SERVER_ERROR`);
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
