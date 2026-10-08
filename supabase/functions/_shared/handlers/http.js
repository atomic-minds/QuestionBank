// HTTP helpers shared by the Edge Functions.
import { AppError, errorBody } from '../core/errors.js';

/** @param {(name:string)=>string|undefined} env */
export function corsHeaders(req, env) {
  const allowed = (env('ALLOWED_ORIGINS') ?? '*').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get('origin');
  // Authentication uses a bearer token (no cookies), so "*" is safe; list your site to tighten it.
  const allow = allowed.includes('*') ? '*' : (origin && allowed.includes(origin) ? origin : null);
  return {
    ...(allow ? { 'access-control-allow-origin': allow } : {}),
    'access-control-allow-headers': 'authorization, content-type, x-client-info, apikey',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

export function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors },
  });
}

/**
 * Wrap a handler with CORS, method checks and uniform error output. Unexpected errors are logged
 * on the server (without request bodies) and returned as a generic message.
 */
export function route(handler, { log = console.error } = {}) {
  return async (req, deps) => {
    const cors = corsHeaders(req, deps.env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (req.method !== 'POST') throw new AppError('METHOD_NOT_ALLOWED', 'Use POST.');
      const result = await handler(req, deps);
      return json(result, 200, cors);
    } catch (e) {
      if (!(e instanceof AppError)) log('unhandled error:', e?.name, e?.message);
      const err = e instanceof AppError ? e : new AppError('INTERNAL', 'Something went wrong on the server.');
      return json(errorBody(err), err.status, cors);
    }
  };
}

export async function readJson(req, maxBytes) {
  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > maxBytes) throw new AppError('PAYLOAD_TOO_LARGE', 'That request is too large.');
  const type = req.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) throw new AppError('UNSUPPORTED_MEDIA', 'Send JSON.');
  const text = await req.text();
  if (text.length > maxBytes) throw new AppError('PAYLOAD_TOO_LARGE', 'That request is too large.');
  try { return JSON.parse(text); } catch { throw new AppError('BAD_REQUEST', 'The request body is not valid JSON.'); }
}
