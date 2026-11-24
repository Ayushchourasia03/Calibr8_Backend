import crypto from "crypto";
import jwt from "jsonwebtoken";
import prisma from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";
import { OAUTH_STATE_SECRET } from "../config/jwt.js";

// Bound every outbound GitHub call so a slow upstream cannot hang the callback.
const GITHUB_TIMEOUT_MS = 10_000;
const LINK_CODE_TTL_MS = 2 * 60 * 1000;
const isProduction = process.env.NODE_ENV === "production";

function safeHttpsUrl(value, maxLen = 500) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:") return null;
    const normalized = parsed.toString();
    return normalized.length <= maxLen ? normalized : null;
  } catch {
    return null;
  }
}

/**
 * Validates frontend redirect URL against an allow-list to prevent open redirect vulnerabilities.
 */
function getSafeFrontendRedirect(targetUrl) {
  const configured = (process.env.FRONTEND_URL || (isProduction ? "" : "http://localhost:5173"))
    .split(",")
    .map((u) => u.trim().replace(/\/+$/, ""))
    .filter(Boolean);

  const allowedOrigins = [
    ...configured,
    ...(isProduction ? [] : ["http://localhost:5173", "http://127.0.0.1:5173"]),
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

function oauthConfig(providerName) {
  if (providerName !== "github") return null;
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const backendUrl = process.env.BACKEND_URL || (isProduction ? "" : "http://localhost:3000");
  if (!clientId || !clientSecret || !backendUrl) return null;
  return {
    clientId,
    clientSecret,
    redirectUri: `${backendUrl.replace(/\/+$/, "")}/api/social/${providerName}/callback`,
  };
}

// ---- one-time link codes ---------------------------------------------------
// The OAuth callback is a browser navigation and carries no Calibr8
// credentials, so it cannot tell whose browser completed the GitHub step. It
// therefore never links an account itself: it hands the fetched profile to
// the frontend as an encrypted, short-lived code, and the signed-in frontend
// completes the link. The completing user must be the user who started the
// flow. This defeats login/link CSRF: a victim sent an attacker's authorize
// URL lands back in their OWN session, which does not match the state's user.

const linkKey = Buffer.from(
  crypto.hkdfSync(
    "sha256",
    OAUTH_STATE_SECRET,
    Buffer.from("calibr8-oauth-link-salt"),
    Buffer.from("aes-256-gcm"),
    32,
  ),
);

function sealLinkCode(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", linkKey, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

function openLinkCode(code) {
  try {
    const raw = Buffer.from(String(code), "base64url");
    if (raw.length < 29 || raw.length > 8192) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", linkKey, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    const payload = JSON.parse(json);
    if (!payload || typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// Codes are single-use within this process (best effort; they also expire).
const usedLinkCodes = new Map(); // nonce -> expiry
setInterval(() => {
  const now = Date.now();
  for (const [nonce, exp] of usedLinkCodes) if (exp < now) usedLinkCodes.delete(nonce);
}, 60_000).unref?.();

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
    const config = oauthConfig(providerName);
    if (!config) {
      throw new ApiError(503, "GitHub linking is not configured.", "OAUTH_NOT_CONFIGURED");
    }

    // Uses OAUTH_STATE_SECRET strictly kept separate from JWT_SECRET
    const state = jwt.sign(
      { userId: req.user.id, provider: providerName, nonce: crypto.randomUUID() },
      OAUTH_STATE_SECRET,
      { expiresIn: "10m", algorithm: "HS256" },
    );

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
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
 * OAuth redirect callback handler. Fetches the provider profile and redirects
 * to the frontend with ?link_code=<code>&provider=<name>; the frontend then
 * calls POST /api/social/:provider/complete. Never links by itself.
 * SECURITY:
 * 1. Uses short error codes (CANCELLED, EXPIRED, etc.) instead of raw error messages.
 * 2. Enforces allow-list on redirect destination to prevent open redirect vulnerabilities.
 */
export const handleCallback = async (req, res) => {
  const safeFrontend = getSafeFrontendRedirect(process.env.FRONTEND_URL);
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");

  try {
    const { provider } = req.params;
    const { code, state, error } = req.query;

    if (error || !code || !state) {
      return res.redirect(`${safeFrontend}/?link_error=CANCELLED`);
    }

    let payload;
    try {
      // Verify with OAUTH_STATE_SECRET
      payload = jwt.verify(String(state), OAUTH_STATE_SECRET, { algorithms: ["HS256"] });
    } catch {
      return res.redirect(`${safeFrontend}/?link_error=EXPIRED`);
    }

    const providerName = String(provider).toLowerCase();
    if (providerName !== "github" || payload.provider !== providerName) {
      return res.redirect(`${safeFrontend}/?link_error=UNKNOWN_PROVIDER`);
    }

    const config = oauthConfig(providerName);
    if (!config) {
      return res.redirect(`${safeFrontend}/?link_error=CONFIGURATION`);
    }

    // Fetch GitHub Profile
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: String(code),
        redirect_uri: config.redirectUri,
      }),
    });
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
      await fetch("https://api.github.com/user", { headers, signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) })
    ).json();
    if (!gh.id) {
      return res.redirect(`${safeFrontend}/?link_error=AUTH_FAILED`);
    }

    let email = gh.email;
    if (!email) {
      const emails = await (
        await fetch("https://api.github.com/user/emails", { headers, signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) })
      ).json();
      email = Array.isArray(emails)
        ? emails.find((e) => e.primary && e.verified)?.email
        : null;
    }

    const clip = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);
    const profile = {
      providerUserId: String(gh.id),
      username: clip(gh.login, 100),
      name: clip(gh.name || gh.login, 100),
      email: clip(email, 254),
      avatarUrl: safeHttpsUrl(gh.avatar_url, 500),
      profileUrl: safeHttpsUrl(gh.html_url, 500),
      bio: clip(gh.bio, 500),
      headline: null,
      stats: {
        publicRepos: Number(gh.public_repos) || 0,
        followers: Number(gh.followers) || 0,
        following: Number(gh.following) || 0,
      },
    };

    const linkCode = sealLinkCode({
      uid: payload.userId,
      provider: providerName,
      profile,
      nonce: crypto.randomUUID(),
      exp: Date.now() + LINK_CODE_TTL_MS,
    });
    res.redirect(`${safeFrontend}/?link_code=${encodeURIComponent(linkCode)}&provider=${providerName}`);
  } catch (err) {
    console.error("[OAuth Callback Error]", err.message);
    res.redirect(`${safeFrontend}/?link_error=SERVER_ERROR`);
  }
};

/**
 * POST /api/social/:provider/complete  { code }
 * Completes linking for the signed-in user (Protected). The user must be the
 * one who started the flow (GET /link-url).
 */
export const completeLink = async (req, res, next) => {
  try {
    const providerName = String(req.params.provider).toLowerCase();
    const payload = openLinkCode(req.body?.code);
    if (!payload || payload.provider !== providerName) {
      throw new ApiError(400, "This link request is invalid or has expired. Please try again.", "LINK_CODE_INVALID");
    }
    if (payload.uid !== req.user.id) {
      throw new ApiError(403, "This link request was started by a different account.", "LINK_ACCOUNT_MISMATCH");
    }
    if (!payload.nonce || usedLinkCodes.has(payload.nonce)) {
      throw new ApiError(400, "This link request was already used.", "LINK_CODE_INVALID");
    }
    usedLinkCodes.set(payload.nonce, payload.exp);

    const { profile } = payload;
    const consumeAndLink = async (store) => {
      if (store.revokedToken?.create) {
        try {
          await store.revokedToken.create({
            data: {
              jti: `oauth-nonce:${payload.nonce}`,
              userId: req.user.id,
              expiresAt: new Date(payload.exp),
            },
          });
        } catch (nonceErr) {
          if (nonceErr?.code === "P2002") {
            throw new ApiError(400, "This link request was already used.", "LINK_CODE_INVALID");
          }
          if (nonceErr?.code !== "P2021") throw nonceErr;
        }
      }

      const existing = await store.socialAccount.findUnique({
        where: {
          provider_providerUserId: {
            provider: providerName,
            providerUserId: profile.providerUserId,
          },
        },
        select: { userId: true },
      });
      if (existing && existing.userId !== req.user.id) {
        throw new ApiError(409, "This GitHub account is already linked to another Calibr8 account.", "ALREADY_LINKED");
      }

      return store.socialAccount.upsert({
        where: {
          userId_provider: {
            userId: req.user.id,
            provider: providerName,
          },
        },
        create: {
          userId: req.user.id,
          provider: providerName,
          ...profile,
        },
        update: {
          ...profile,
          connectedAt: new Date(),
        },
      });
    };

    const account =
      typeof prisma.$transaction === "function"
        ? await prisma.$transaction((tx) => consumeAndLink(tx))
        : await consumeAndLink(prisma);

    res.status(200).json({ success: true, linked: providerName, account });
  } catch (err) {
    if (err?.code === "P2002") {
      return next(new ApiError(409, "This GitHub account is already linked to another Calibr8 account.", "ALREADY_LINKED"));
    }
    next(err);
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
