// Supabase Edge Function: write answers and worked solutions for questions (text only).
// All logic lives in ../_shared so it can be tested with plain Node.
import { handleSolve } from '../_shared/handlers/solve.js';
import { route } from '../_shared/handlers/http.js';

const handler = route(handleSolve);
Deno.serve((req: Request) => handler(req, { env: (name: string) => Deno.env.get(name), fetchImpl: fetch }));
