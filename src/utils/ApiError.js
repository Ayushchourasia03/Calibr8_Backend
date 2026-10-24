export class ApiError extends Error {
  /**
   * @param {number} status  HTTP status code
   * @param {string} message Human-readable error message
   * @param {string} [code] Standard error code (e.g. BAD_REQUEST, UNAUTHORIZED)
   * @param {any} [details] Optional detailed error info
   */
  constructor(status, message, code = null, details = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status || 500;
    this.code = code || ApiError.defaultCode(status);
    if (details !== null && details !== undefined) {
      this.details = details;
    }
  }

  static defaultCode(status) {
    switch (status) {
      case 400:
        return 'BAD_REQUEST';
      case 401:
        return 'UNAUTHORIZED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'NOT_FOUND';
      case 409:
        return 'CONFLICT';
      case 413:
        return 'CODE_TOO_LARGE';
      case 422:
        return 'UNPROCESSABLE_ENTITY';
      case 429:
        return 'RATE_LIMITED';
      case 503:
        return 'JUDGE_UNAVAILABLE';
      default:
        return 'INTERNAL_ERROR';
    }
  }
}
