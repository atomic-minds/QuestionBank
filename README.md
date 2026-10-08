# Question Bank

A real, working question bank that runs on **free tiers only (₹0 per month, no card, no billing account)**.

```
 photo / JSON / typing        validation + duplicate check        admin review         database           public site
┌────────────────────┐   ┌───────────────────────────────┐   ┌───────────────┐   ┌───────────┐   ┌────────────────┐
│ Image → Gemini AI  │ → │ strict structured JSON,       │ → │ editable      │ → │ Postgres  │ → │ browse, search,│
│ (image is discarded)│  │ checked against your taxonomy │   │ review screen │   │ (truth)   │   │ Show Answer,   │
└────────────────────┘   └───────────────────────────────┘   └───────────────┘   └───────────┘   │ export         │
                                                                                                  └────────────────┘
```

* The **database is the source of truth**. The AI never writes to it; an admin approves every question.
* **Images are never stored.** They are shrunk in your browser, sent once to the AI, and dropped.
* The AI is optional. *Paste JSON* (from any AI or by hand) and *Write one* work with no AI at all.

New here? Follow **[docs/SETUP-GUIDE.md](docs/SETUP-GUIDE.md)**: a step-by-step guide for beginners.

## Features

* Question types: MCQ, short answer, long answer, numerical, assertion-reason, true/false, fill in the blank, case-based, match the following.
* Subject → Chapter → Topic master data, editable by admins. The AI and the importer file questions only into names that exist there; near-misses are shown as suggestions, never assigned silently.
* General and exam classification, with any number of exams (CBSE, JEE Main, …), year and paper per appearance.
* Import: paste or upload JSON (single, list, or the formats in [docs/EXPORT-FORMAT.md](docs/EXPORT-FORMAT.md)); up to 100 per paste; every item is validated alone, errors are listed per item, and the valid ones can be approved selectively.
* Duplicates: exact duplicates are blocked; near duplicates are flagged with similarity and a link, and need an explicit "this is different" confirmation.
* Lifecycle: draft → review → published → archived. Only published questions are public.
* Public site: responsive, light/dark; browse by subject → chapter → topic → type → exam/general; global search (text, tags, or an ID like `QB-CHEM-000123`); filters (subject, chapter, topic, type, exam, year, difficulty, marks, tags); *Show answer* with explanation; shareable links.
* Export: Atomic Minds JSON (versioned, keeps the bank ID), readable plain text, full backup/restore; by filter or by hand-picked list.
* Security: admin sign-in, an admin allow-list enforced **inside the database**, row-level security on every table, no secrets in the website, upload checks, size caps, a daily AI cap.

## Architecture and why

| Layer | Choice | Why |
| --- | --- | --- |
| Website | Plain HTML/CSS/JavaScript (no build step) on **Cloudflare Workers static assets** | Nothing to compile or install; static assets are free and cannot generate compute charges; deploys from Git. |
| Database + login | **Supabase Free** (Postgres, email + password Auth) | Real relational data, full-text and fuzzy search (`pg_trgm`), and row-level security, all in one free product. |
| Server code | Two **Supabase Edge Functions** (`extract-question`, `save-questions`) | The only places that need a secret (the AI key) or multi-step checks. |
| AI | **Google Gemini** free tier, behind a small provider interface | Reads images. The key lives only in Supabase secrets. |
| Code hosting | GitHub (free) | Cloudflare deploys from it; a scheduled job keeps Supabase awake. |

Deviation from the brief, on purpose: there is **no npm dependency at all**. The validator, importer, exporter and clients are small hand-written modules that run unchanged in the browser, in Deno (Supabase) and in Node (tests). The shared code lives in `supabase/functions/_shared/core/` and is copied to `web/js/core/` by `npm run sync:core`; a test fails if the two drift apart. This keeps the free-tier deployment simple and removes supply-chain risk.

Firestore or MongoDB were considered and rejected: this data is relational (subject → chapter → topic, questions ↔ exams), needs filtering and text search, and needs per-row access rules, which Postgres gives for free.

### Service and cost table

| Service | Purpose | Plan | Monthly cost | Requires billing? |
| --- | --- | --- | --- | --- |
| Cloudflare Workers (static assets) | Hosts the website | Free | ₹0 | No |
| Supabase | Database, login, two functions | Free | ₹0 | No |
| Google AI Studio / Gemini API | Reads images (optional) | Free tier | ₹0 | No — **never link a billing account** |
| GitHub | Code + keep-alive job | Free | ₹0 | No |
| **Total** | | | **₹0** | **No** |

### Free-tier limits and what the app does about them

| Limit (from each provider's documentation, Oct 2026) | Protection in this project |
| --- | --- |
| Supabase Free: 500 MB database, 1 GB storage, 5 GB egress, 500,000 function calls/month | Questions are small text; images are not stored; public reads are paginated (20/page, hard cap 50); nothing polls; exports are built from 500-row pages; creation pauses at `DB_SOFT_LIMIT_MB` (default 450) while editing still works. |
| Supabase Free projects pause when idle | `.github/workflows/keepalive.yml` pings every 3 days. A paused project can be restored from the dashboard. |
| Supabase Free has no automatic backups | *Full backup* export and `npx supabase db dump`; the dashboard reminds you. |
| Gemini free tier: per-project requests/minute, tokens/minute and requests/day; 429 when exceeded, no charge without billing | `AI_DAILY_LIMIT` counted in the database (default 20); a 429 becomes a clear message and the *Paste JSON* fallback. |
| Cloudflare Workers static assets | The site is static files with no Worker script. Cloudflare documents static-asset requests as free and unlimited, and nothing here runs compute, so there is nothing to bill. Check Cloudflare's current limits page if in doubt. |

**Quota exhausted never costs money** as long as you never enable billing on the Google key (the setup guide says how to make sure): the app shows a message and you wait or use JSON import.

## Configuration

Public settings go in `web/config.js` (safe to publish):

| Setting | Meaning |
| --- | --- |
| `supabaseUrl` | `https://<ref>.supabase.co` |
| `supabasePublishableKey` | the `sb_publishable_…` key (the older `anon` key also works) |
| `siteName`, `copyright` | shown in the header and footer (`© year copyright`); default `AyanP_Chem` |

Secrets for the functions (`npx supabase secrets set …`, see `.env.example`):

| Variable | Required | Meaning |
| --- | --- | --- |
| `GEMINI_API_KEY` | for AI | Gemini key from Google AI Studio |
| `GEMINI_MODEL` | for AI | exact model code; no default on purpose |
| `AI_PROVIDER` | no | `gemini` (default) |
| `AI_DAILY_LIMIT` | no | image reads per day (default 20, clamped to 0–1000) |
| `ALLOWED_ORIGINS` | no | comma-separated site origins, default `*` |
| `DB_SOFT_LIMIT_MB` | no | pause new questions at this size (default 450) |
| `QB_PUBLISHABLE_KEY` | no | only if Supabase stops injecting its own keys |

Supabase injects `SUPABASE_URL` and the public key (`SUPABASE_PUBLISHABLE_KEYS`, or legacy `SUPABASE_ANON_KEY`) into the functions itself. **The functions never use the secret/service-role key**; they act with the signed-in admin's own token, so row-level security always applies.

## Database and migrations

`supabase/migrations/` holds five ordered files. Run them in the Supabase SQL editor (or `npx supabase db push` after `link`):

1. `0001_schema.sql` tables, constraints, triggers (public ID, content hash, search vector)
2. `0002_security.sql` admin list, row-level security policies
3. `0003_api.sql` the functions the website calls (search, facets, save, duplicates, stats, AI quota) and their grants
4. `0004_reference_data.sql` question types
5. `0005_starter_taxonomy.sql` optional starter subjects, chapters, exams

Key rules enforced by the database itself: the public ID `QB-<SUBJECT>-000123` is immutable and never reused; chapters belong to one subject and topics to one chapter (composite foreign keys); an exact-duplicate guard (hash of the normalised question and options) ignores archived rows; edits use optimistic concurrency (`version`) so two admins cannot silently overwrite each other; the public can only ever read published rows, through audited functions.

## Security model

* **Nothing secret in the browser.** `web/config.js` holds only the project URL and a publishable key.
* **Reads:** anonymous visitors call read-only database functions that return *published* questions only (max 50 per request). Everything shown on a public question page, including its optional *Source* note, is public by design. Direct table access for visitors is denied.
* **Writes:** only a signed-in user listed in `admin_users` can change anything; the database checks it on every statement. Saves go through the `save-questions` function (validation + duplicate check); deleting an archived question and editing subjects/chapters/topics/exams are direct admin-only writes protected by the same row-level security. You switch public sign-ups off in the Supabase dashboard (setup guide, step 2c); even if one succeeded, that account would have no rights.
* **Functions:** verify the caller with Supabase Auth, then act as that caller. Upload checks: size ≤ 3 MB, type allow-list (JPEG/PNG/WebP), real file signature checked (not just the name). Request body caps; ≤ 50 questions per save.
* **Rendering:** all text is HTML-escaped before display (tested with script/image payloads); a strict Content-Security-Policy (`web/_headers`) blocks inline scripts.
* **Rate limiting:** AI reads are capped per day in the database; all writes need an admin; public reads are paginated and capped. There is no per-visitor request limiter on the free tier of Supabase; if you ever see abuse, add a free Cloudflare rate-limiting rule in front of the site.
* **Prompt injection:** text inside a photographed page is treated as data. The AI can only return JSON in a fixed schema, which is validated, and a human reviews it before anything is saved.

## Testing

```
npm run test:core   # 87 tests: validation, importer, exporters, AI connector, function handlers, shared-code parity
npm run test:sql    # 165 checks on a real throw-away PostgreSQL: schema, security, RLS, public ID, duplicates, search, quota
npm run test:e2e    # 101 browser checks: real site + real database + real function code, with fake Supabase gateway and fake Gemini
```

`test:sql` needs PostgreSQL server binaries (with `pg_trgm`, `pgcrypto`); `test:e2e` also needs Python `playwright` with Chromium. The browser tests cover creation, JSON and bulk import (including malformed JSON and a mixed valid/invalid batch), the AI workflow (success, quota exhausted, garbled output), duplicate handling, publishing, public browsing and filtering, search, Show Answer (mouse and keyboard), taxonomy management, all exports, backup and restore round trip, XSS payloads, upload restrictions, anonymous-access denial, expired-session refresh, no horizontal scrolling at phone/tablet/desktop widths, dark mode, and absence of script/CSP errors.

**What has not been tested:** the real Supabase and Google services (they need your accounts). The fake gateway reproduces their documented behaviour (including that publishable keys must not be sent as bearer tokens), but the first deployment is the first live run, which is why the setup guide ends with a first-run checklist.

## Extension points

* **Another AI provider:** add a file under `supabase/functions/_shared/core/ai/` with a factory returning `{ id, model, extract({ image, system, userText, schema }) → { json } }` (see `provider.js` and `gemini.js`), list it in `registry.js`, set `AI_PROVIDER`. The adapter, validation and review screen do not change. Google also offers a newer *Interactions API*; the current connector uses `generateContent`, which Google documents as fully supported.
* **More question types:** add a row in `0004_reference_data.sql` and an entry in `core/constants.js`; the editor adapts by *kind* (choice, text, numeric, match).
* **More export formats:** add a function next to `core/export.js` and a button in `admin-export.js`.
* **Several exams, subjects, languages:** all master data is editable in the app.

## Known limitations (honest list)

* Gemini's free tier may use submitted images for product improvement and human review; the app says so before every upload.
* Fuzzy duplicate detection compares text similarity; two questions that differ in one number can look "similar" and need your judgement (that is what the confirmation is for).
* Questions are text. Diagrams/figures are not stored (by design); mention them in the question text or add a link in *Source*.
* One admin level: every admin can do everything.
* Backups through the website: up to 1000 questions per file can be restored through the review screen (4 MB); the export refuses to produce a backup larger than that (or an export of more than 20,000 questions) rather than silently cutting it, and tells you to export one subject at a time. A complete database copy is `npx supabase db dump`.
* Hardening backlog: request-size limits for the two functions rely on the declared size first (only admins can reach them); `SECURITY DEFINER` functions pin `search_path` to `public` (adding `pg_temp` last would be a further belt-and-braces step).

## Layout

```
web/                    the website (index.html, config.js, css/, js/)
supabase/migrations/    database
supabase/functions/     two Edge Functions + _shared/ (core logic, handlers)
tests/                  core (Node), sql (Postgres), e2e (browser)
docs/                   SETUP-GUIDE.md, EXPORT-FORMAT.md
wrangler.jsonc          Cloudflare static-assets config
.github/workflows/      keep-alive job
```
