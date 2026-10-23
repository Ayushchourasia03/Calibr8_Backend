import { ApiError } from '../utils/ApiError.js';

/**
 * Global error handling middleware.
 * Catches ApiError instances and generic errors,
 * returning a consistent JSON error shape.
 */
// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  console.error(`[API Error] ${req.method} ${req.url}:`, err.message || err);

  if (err instanceof ApiError) {
    return res.status(err.status).json({
      success: false,
      message: err.message,
    });
  }

  // Prisma unique constraint violation (P2002)
  if (err.code === 'P2002') {
    const field = err.meta?.target?.[0] ?? 'field';
    return res.status(409).json({
      success: false,
      message: `A record with that ${field} already exists.`,
    });
  }

  // Database connection or environment configuration errors
  if (
    err.message &&
    (err.message.includes('No database host') ||
      err.message.includes('connection string') ||
      err.message.includes('DATABASE_URL'))
  ) {
    return res.status(503).json({
      success: false,
      message: 'Database connection error: DATABASE_URL is not configured or unreachable.',
      detail: err.message,
    });
  }

  // Fallback: server error
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error.',
  });
};
