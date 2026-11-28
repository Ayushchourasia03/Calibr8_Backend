import { ApiError } from "../utils/ApiError.js";
import { allowLogLine, sanitizeLogText } from "../utils/logLimiter.js";

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
  const requestId = req.id ? ` [${req.id}]` : "";
  const status = err instanceof ApiError ? err.status : err.status || err.statusCode;
  // Unexpected (5xx) errors are logged with their stack for diagnosis; the
  // client only ever sees a generic message.
  // The request line (morgan, src/app.js) carries this code; client errors
  // are not logged a second time here (SA-L9 round 2).
  if (res.locals) res.locals.errorCode = err?.code || err?.type || err?.name;
  if (!status || status >= 500) {
    // Within the per-minute 5xx budget (src/utils/logLimiter.js); checked
    // before the stack is formatted. Prisma messages embed the query
    // arguments (user data): log the class and code only for those.
    if (allowLogLine("5xx")) {
      const detail = String(err?.name || "").startsWith("PrismaClient")
        ? `${err.name} ${err.code || ""}`
        : err?.stack || err;
      console.error(`[API Error]${sanitizeLogText(requestId, 80)} ${req.method} ${sanitizeLogText(req.path)}:`, detail);
    }
  }

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

  // Body parser errors (express.json / urlencoded)
  // FV-9: too many urlencoded parameters is its own error, not "code too large".
  if (err.type === "parameters.too.many") {
    return res.status(413).json({
      success: false,
      code: "TOO_MANY_PARAMETERS",
      message: "Request has too many parameters.",
    });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({
      success: false,
      code: "PAYLOAD_TOO_LARGE",
      message: "Request body is too large.",
    });
  }
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({
      success: false,
      code: "INVALID_JSON",
      message: "Request body is not valid JSON.",
    });
  }

  // Prisma unique constraint violation (P2002)
  if (err.code === "P2002") {
    return res.status(409).json({
      success: false,
      code: "CONFLICT",
      message: "A record with these details already exists.",
    });
  }

  // Malformed input reaching a query (e.g. wrong type for a filter)
  if (err.name === "PrismaClientValidationError") {
    return res.status(400).json({
      success: false,
      code: "BAD_REQUEST",
      message: "Invalid request parameters.",
    });
  }

  // Database connection or environment configuration errors
  if (
    err.name === "PrismaClientInitializationError" ||
    ["P1000", "P1001", "P1002", "P1003", "P1008", "P1017", "P2024"].includes(err.code) ||
    (err.message &&
      (err.message.includes("No database host") ||
        err.message.includes("connection string") ||
        err.message.includes("DATABASE_URL")))
  ) {
    return res.status(503).json({
      success: false,
      code: "DATABASE_UNAVAILABLE",
      message: "Database service is unavailable.",
    });
  }

  const finalStatus = status || (err.name === "ValidationError" ? 400 : 500);
  const code = typeof err.code === "string" && finalStatus < 500 ? err.code : ApiError.defaultCode(finalStatus);
  const message =
    finalStatus >= 500 ? "Internal server error." : err.message || "Request failed.";

  const payload = {
    success: false,
    code,
    message,
  };
  if (finalStatus < 500 && err.details) {
    payload.details = err.details;
  }

  res.status(finalStatus).json(payload);
};
