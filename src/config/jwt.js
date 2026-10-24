import dotenv from 'dotenv';
dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';

// Refuse to start in production if JWT_SECRET is missing
if (isProduction && (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim().length === 0)) {
  console.error('FATAL: JWT_SECRET must be explicitly set in production environment.');
  process.exit(1);
}

// Refuse to start in production if OAUTH_STATE_SECRET is missing (kept separate from JWT_SECRET)
if (isProduction && (!process.env.OAUTH_STATE_SECRET || process.env.OAUTH_STATE_SECRET.trim().length === 0)) {
  console.error('FATAL: OAUTH_STATE_SECRET must be explicitly set in production environment.');
  process.exit(1);
}

// Development fallback only (in dev mode)
export const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_jwt_calibr8_do_not_use_in_prod';
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1d'; // Short expiry (1 day)

// OAUTH_STATE_SECRET is strictly kept separate from JWT_SECRET
export const OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'dev_oauth_state_secret_calibr8_distinct_separate';
