# Update: clean-up and safer JSON paste

What is new
1. Pasting JSON from ChatGPT, Gemini or any other AI now works even when the AI forgot to double a backslash (for example \ce{H2O}, \alpha, \( ... \)) or left a raw line break or tab inside a text. These are repaired automatically and the preview tells you so. Before, the whole paste was rejected with "Bad escaped character".
2. After a site update you no longer need Ctrl + F5. Your browser now checks for new site files every time (it still re-uses a file when nothing changed, so pages stay fast).
3. Six pieces of unused code were removed (nothing you can see changes).

No database change. No secret change. No Supabase deploy is needed. Only the website files change.

How to update (about 3 minutes)
1. Copy the files of the update folder into your main Question Bank folder (replace when asked). Do not copy web/config.js.
2. GitHub: Add file > Upload files, drag the update folder contents, Commit. (Do NOT upload web/config.js.) Cloudflare publishes the site by itself in about a minute.
3. Open the site and refresh once (Ctrl + F5) this one last time.
4. Test: Add questions > Paste JSON > paste {"questions":[{"type":"short_answer","question":"Name $\ce{H2O}$","answer":"water","subject":"Chemistry","chapter":"<any chapter>"}]} and press Check and preview. It should open the review page instead of showing an error.

Files in this update
- supabase/functions/_shared/core/importer.js, ai/schema.js, ai/adapt.js, validate.js (source of the shared code)
- web/js/core/importer.js, ai/schema.js, ai/adapt.js, validate.js (copies used by the website)
- web/js/dom.js, web/js/api.js
- web/_headers
- tests/core/importer.test.js (tests only)
- docs/UPDATE-2026-10i.md (this note)
