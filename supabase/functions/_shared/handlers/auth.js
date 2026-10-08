// Who is calling? Edge Functions run with verify_jwt = false so that we control the whole check:
//   1. the bearer token must be accepted by the Supabase Auth server (valid, unexpired, not revoked)
//   2. that person must be listed in public.admin_users (checked by the database, not by us)
// Every later database call is made WITH the person's token, so row-level security stays in force.
import { AppError } from '../core/errors.js';
import { createRest } from '../core/rest.js';

/**
 * The PUBLIC key the function uses to talk to the database as "anonymous / the signed-in person".
 * Supabase is replacing the old "anon" key with "publishable" keys, so look for the new one first:
 *   1. QB_PUBLISHABLE_KEY          a secret you may set yourself (names cannot start with SUPABASE_)
 *   2. SUPABASE_PUBLISHABLE_KEYS   injected by Supabase: a JSON object such as {"default":"sb_publishable_..."}
 *   3. SUPABASE_ANON_KEY           legacy, injected by Supabase until it is retired
 * Never the service-role / secret key: nothing here needs to bypass row-level security.
 */
export function publicKey(env) {
  const own = env('QB_PUBLISHABLE_KEY');
  if (own) return own.trim();
  const dict = env('SUPABASE_PUBLISHABLE_KEYS');
  if (dict) {
    try {
      const o = JSON.parse(dict);
      const v = typeof o === 'string' ? o : (o?.default ?? Object.values(o ?? {}).find((x) => typeof x === 'string'));
      if (typeof v === 'string' && v) return v;
    } catch { /* fall through to the legacy key */ }
  }
  return env('SUPABASE_ANON_KEY') ?? null;
}

export function makeDb(env, fetchImpl) {
  const url = env('SUPABASE_URL');
  const key = publicKey(env);
  if (!url || !key) throw new AppError('INTERNAL', 'The server is missing its database settings.');
  return createRest({ url, key, fetchImpl });
}

/** @returns {Promise<{db: ReturnType<typeof createRest>, user: {id:string, email?:string}}>} */
export async function requireAdmin(req, env, fetchImpl) {
  const header = req.headers.get('authorization') ?? '';
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new AppError('UNAUTHENTICATED', 'Please sign in.');

  const anon = makeDb(env, fetchImpl);
  let user;
  try { user = await anon.auth.getUser(token); } catch (e) {
    if (e instanceof AppError && e.code === 'UNAVAILABLE') throw e;
    throw new AppError('UNAUTHENTICATED', 'Your session has expired. Please sign in again.');
  }
  if (!user?.id) throw new AppError('UNAUTHENTICATED', 'Please sign in.');

  const db = anon.withToken(token);
  const isAdmin = await db.rpc('is_admin');
  if (isAdmin !== true) throw new AppError('FORBIDDEN', 'This account is not an admin.');
  return { db, user };
}
