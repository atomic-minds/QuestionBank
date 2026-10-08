// A tiny client for Supabase's REST (PostgREST) and Auth (GoTrue) APIs, written with plain fetch
// so there is nothing to install. Used by the Edge Functions and by the browser (web/js/api.js).
//
// It only ever holds the PUBLIC anon/publishable key plus the signed-in person's own access token.
// Row-level security in the database decides what each person may read or write.
import { AppError, appErrorFromDb } from './errors.js';

/**
 * @param {{url: string, key: string, token?: string|null, fetchImpl?: typeof fetch}} cfg
 */
export function createRest(cfg) {
  const base = String(cfg.url).replace(/\/+$/, '');
  const doFetch = cfg.fetchImpl ?? ((...a) => fetch(...a));

  async function call(path, { method = 'GET', body, headers = {}, token = cfg.token, signal } = {}) {
    let res;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          // The public key always goes in `apikey`. Only a signed-in person's token goes in
          // `Authorization`: new-style publishable keys (sb_publishable_...) are not JWTs and are
          // rejected if sent as a bearer token.
          apikey: cfg.key,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch {
      throw new AppError('UNAVAILABLE', 'Could not reach the database. Check your connection and try again.', { status: 503 });
    }
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    if (!res.ok) throw appErrorFromDb(data ?? { message: text.slice(0, 200) }, res.status);
    return data;
  }

  const qs = (params) => {
    if (typeof params === 'string') return params ? `?${params}` : '';
    const s = new URLSearchParams(params ?? {}).toString();
    return s ? `?${s}` : '';
  };

  const api = {
    /** Same client, acting as a different signed-in person. */
    withToken: (token) => createRest({ ...cfg, token }),

    /** Call a database function: POST /rest/v1/rpc/<name> */
    rpc: (name, args = {}, opts) => call(`/rest/v1/rpc/${encodeURIComponent(name)}`, { method: 'POST', body: args, ...opts }),
    /** Read rows: params is a PostgREST query string or object, e.g. {select: '*', order: 'name'} */
    select: (table, params, opts) => call(`/rest/v1/${encodeURIComponent(table)}${qs(params)}`, opts),
    insert: (table, rows, opts) => call(`/rest/v1/${encodeURIComponent(table)}`, { method: 'POST', body: rows, headers: { prefer: 'return=representation' }, ...opts }),
    update: (table, filter, fields, opts) => call(`/rest/v1/${encodeURIComponent(table)}${qs(filter)}`, { method: 'PATCH', body: fields, headers: { prefer: 'return=representation' }, ...opts }),
    remove: (table, filter, opts) => call(`/rest/v1/${encodeURIComponent(table)}${qs(filter)}`, { method: 'DELETE', headers: { prefer: 'return=representation' }, ...opts }),

    auth: {
      async signIn(email, password) {
        try {
          return await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password }, token: null });
        } catch (e) {
          if (e instanceof AppError && e.code !== 'UNAVAILABLE') throw new AppError('UNAUTHENTICATED', 'Wrong email or password.', { status: 401 });
          throw e;
        }
      },
      refresh: (refreshToken) => call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: refreshToken }, token: null }),
      /** Verifies the token with the auth server (signature, expiry, revocation). */
      getUser: (token) => call('/auth/v1/user', { token }),
      signOut: (token) => call('/auth/v1/logout', { method: 'POST', body: {}, token }),
    },
  };
  return api;
}
