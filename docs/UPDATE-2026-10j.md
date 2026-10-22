# Update: Needs checking list, bulk edit, page numbers

What is new
1. **Needs checking** (All questions page). A new tab, "Needs checking (N)", lists every question whose answer an AI wrote and that you have not yet marked as checked. The same number is on the Dashboard ("answers to check", with a link). Open a question, read it, then press "Mark as checked" (one by one, or tick several and use "Mark as checked" at the bottom). The public site never sees any of this.
2. **Answers from another AI (Paste JSON).** The Paste JSON tab has a new tick box: "The answers in this file were written by an AI". It is ticked by default. When you save, those questions get the "AI-solved: check" marker and appear under Needs checking. Untick it when you know the answers are correct (for example you typed them yourself).
3. **Edit selected…** (All questions page, at the bottom). Tick several questions, press "Edit selected…", and change any of: difficulty, marks, tags to add, tags to remove, or move them to another subject, chapter and topic. Boxes you leave alone are not touched. You see a summary and confirm before anything is saved. A question that would end up with more than 12 tags is skipped and reported.
4. **Worksheet:** the printed pages now have page numbers at the bottom (Chrome and Edge). The worksheet, "Print or save as PDF" and the answer key on its own page already existed.

DO THIS FIRST: 1 minute of SQL (safe to run twice)
1. Supabase > SQL Editor > New query.
2. On your computer open `supabase/migrations/0010_needs_check.sql` in Notepad. Select all, copy.
3. Paste in the SQL editor and press Run. It should say "Success. No rows returned".
Do this BEFORE uploading the website files. If you upload first, the question lists show an error until the SQL is run.

THEN: update the website (3 minutes)
1. Copy the files of the update folder into your main Question Bank folder (replace when asked). Do not copy web/config.js.
2. GitHub: Add file > Upload files, drag the update folder contents (keep the folders), Commit. Do NOT upload web/config.js.
3. Wait about 1 minute, open the site and press Ctrl + F5 once.
4. Test: Add questions > Paste JSON > paste one question with an answer > Check and preview > save as draft. Then All questions > Needs checking: it is there. Tick it, press "Edit selected…", set Difficulty to Hard, Apply, Confirm.

No secret change. No Supabase function deploy (no npx.cmd step) is needed.

Files in this update
- supabase/migrations/0010_needs_check.sql (new, run first)
- web/js/views/bulk-edit.js (new), admin-questions.js, admin-add.js, admin.js
- web/js/api.js, web/css/app.css
- scripts/test-sql.sh, tests/ (tests only), README.md, docs/SETUP-GUIDE.md, docs/UPDATE-2026-10j.md (this note)
