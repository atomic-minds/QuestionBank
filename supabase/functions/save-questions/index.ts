// Supabase Edge Function: validate, de-duplicate and save questions (the main write path).
import { handleSave } from '../_shared/handlers/save.js';
import { route } from '../_shared/handlers/http.js';

const handler = route(handleSave);
Deno.serve((req: Request) => handler(req, { env: (name: string) => Deno.env.get(name), fetchImpl: fetch }));
