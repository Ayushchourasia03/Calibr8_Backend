import { ApiError } from '../utils/ApiError.js';

/**
 * Global error handling middleware.
 * Catches ApiError instances and generic errors,
 * returning a strictly uniform JSON error shape:
 * {
 *   success: false,
 *   code: string,
 *   message: string,
 *   details?: any
 * }
 */
// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  // Never log raw tokens or passwords
  const sanitizedMessage = (err.message || 'Error').replace(/Bearer\s+[A-Za-z0-9-_.]+/gi, 'Bearer [REDACTED]');
  console.error(`[API Error] ${req.method} ${req.url}:`, sanitizedMessage);

  if (err instanceof ApiError) {
    const payload = {
      success: false,
      code: err.code || ApiError.defaultCode(err.status),
      message: err.message,
    };
    if (err.details !== undefined && err.details !== null) {
      payload.details = err.details;
    }
    return res.status(err.status).json(payload);
  }

  // Prisma unique constraint violation (P2002)
  if (err.code === 'P2002') {
    const field = err.meta?.target?.[0] ?? 'field';
    return res.status(409).json({
      success: false,
      code: 'CONFLICT',
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
      code: 'DATABASE_UNAVAILABLE',
      message: 'Database connection error: DATABASE_URL is not configured or unreachable.',
      details: err.message,
    });
  }

  const status = err.status || (err.name === 'ValidationError' ? 400 : 500);
  const code = err.code || ApiError.defaultCode(status);

  const payload = {
    success: false,
    code,
    message: err.message || 'Internal server error.',
  };
  if (err.details) {
    payload.details = err.details;
  }

  res.status(status).json(payload);
};
