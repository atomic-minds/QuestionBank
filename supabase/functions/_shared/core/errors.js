// One error type for everything that should reach the person as a clear message.
// `code` is a stable machine-readable string the UI switches on; `message` is for humans.

export class AppError extends Error {
  /**
   * @param {string} code      e.g. VALIDATION, FORBIDDEN, CONFLICT, DUPLICATE_EXACT, AI_QUOTA_EXHAUSTED
   * @param {string} message   safe to show to the user (never contains secrets)
   * @param {{status?: number, details?: any}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = opts.status ?? statusFor(code);
    this.details = opts.details;
  }
}

export function statusFor(code) {
  switch (code) {
    case 'UNAUTHENTICATED': return 401;
    case 'FORBIDDEN': return 403;
    case 'NOT_FOUND': return 404;
    case 'METHOD_NOT_ALLOWED': return 405;
    case 'CONFLICT': case 'DUPLICATE_EXACT': case 'DUPLICATE_ID': return 409;
    case 'PAYLOAD_TOO_LARGE': return 413;
    case 'UNSUPPORTED_MEDIA': return 415;
    case 'VALIDATION': case 'BAD_REQUEST': return 400;
    case 'RATE_LIMITED': case 'AI_QUOTA_EXHAUSTED': case 'AI_DAILY_LIMIT': return 429;
    case 'STORAGE_LIMIT': return 507;
    case 'AI_NOT_CONFIGURED': return 503;
    case 'AI_UNAVAILABLE': case 'AI_TIMEOUT': return 502;
    case 'AI_BAD_OUTPUT': case 'AI_BLOCKED': return 422;
    default: return 500;
  }
}

/**
 * Turn a PostgREST / Postgres error body into an AppError with a friendly message.
 * Our own database errors start with a QB_* tag (see supabase/migrations).
 */
export function appErrorFromDb(body, httpStatus = 400) {
  const raw = String(body?.message ?? body?.error_description ?? body?.error ?? 'Database error');
  const sqlstate = String(body?.code ?? '');
  const tagged = raw.match(/^(QB_[A-Z_]+):\s*(.*)$/s);
  if (tagged) {
    const [, tag, rest] = tagged;
    if (tag === 'QB_CONFLICT') return new AppError('CONFLICT', 'Someone else changed this question. Reload it and try again.', { status: 409 });
    if (tag === 'QB_NOT_FOUND') return new AppError('NOT_FOUND', 'That question no longer exists.', { status: 404 });
    if (tag === 'QB_FORBIDDEN') return new AppError('FORBIDDEN', 'Admin access is required.', { status: 403 });
    if (tag === 'QB_IMMUTABLE') return new AppError('VALIDATION', rest.replace(/^[a-z_ ]+: /, ''), { status: 400 });
    return new AppError('VALIDATION', rest, { status: 400 });
  }
  if (sqlstate === '23505' && /content_hash/.test(`${raw} ${body?.details ?? ''}`)) {
    return new AppError('DUPLICATE_EXACT', 'This exact question already exists in the bank.', { status: 409 });
  }
  if (sqlstate === '23505' && /public_id/.test(`${raw} ${body?.details ?? ''}`)) {
    return new AppError('DUPLICATE_ID', 'A question with this ID already exists.', { status: 409 });
  }
  if (sqlstate === '23505') return new AppError('VALIDATION', 'That value already exists.', { status: 409 });
  if (sqlstate === '23503') return new AppError('VALIDATION', 'A referenced subject, chapter, topic or exam no longer exists (or is still in use).', { status: 409 });
  if (sqlstate === '42501' || httpStatus === 403) return new AppError('FORBIDDEN', 'You do not have permission to do that.', { status: 403 });
  if (sqlstate === 'PGRST301' || httpStatus === 401) return new AppError('UNAUTHENTICATED', 'Your session has expired. Please sign in again.', { status: 401 });
  if (sqlstate === '23514') return new AppError('VALIDATION', 'A value is outside the allowed range.', { status: 400 });
  if (httpStatus === 429) return new AppError('RATE_LIMITED', 'Too many requests. Wait a moment and try again.', { status: 429 });
  if (httpStatus >= 500) return new AppError('INTERNAL', 'The database is temporarily unavailable. Try again shortly.', { status: 502 });
  return new AppError('VALIDATION', 'The request was rejected by the database.', { status: httpStatus >= 400 ? httpStatus : 400 });
}

/** Safe JSON shape for API error responses. */
export function errorBody(err) {
  if (err instanceof AppError) return { error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } };
  return { error: { code: 'INTERNAL', message: 'Something went wrong on the server.' } };
}
