// Supabase Edge Function: read an image with AI and return reviewable drafts.
// All logic lives in ../_shared so it can be tested with plain Node.
import { handleExtract } from '../_shared/handlers/extract.js';
import { route } from '../_shared/handlers/http.js';

const handler = route(handleExtract);
Deno.serve((req: Request) => handler(req, { env: (name: string) => Deno.env.get(name), fetchImpl: fetch }));
