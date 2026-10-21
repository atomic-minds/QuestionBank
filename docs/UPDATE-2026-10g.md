# Update: Language filter (Bengali / English)

What is new
1. A new "Language" dropdown with Bengali and English in three places:
   - the public site (Find questions and every subject / chapter page), with the number of questions in brackets, for example "Bengali (12)"
   - Admin > All questions
   - Admin > Print worksheet (the question paper), under "1. Which questions". Choose Bengali, press "Show matching questions", and only Bengali questions are listed for the paper.
2. The language is worked out by the database by itself. A question is Bengali when its question text (or its passage) contains Bengali letters. Otherwise it is English. Nothing needs to be typed in. All questions you already have are covered at once, and it follows the text if you edit it.
3. It combines with every other filter (subject, chapter, topic, type, exam, year and so on).
4. A question that mixes English words inside a Bengali sentence is Bengali. A question written only in English, with Bengali only in its answer or explanation, is English.

IMPORTANT: do step 1 (SQL) BEFORE step 2 (website files). If you upload the website first, search will show an error until the SQL is run.

Step 1. Add the new database part (SQL, 1 minute)
1. Supabase > SQL Editor > New query.
2. On your computer open `supabase/migrations/0009_language.sql` in Notepad. Select all, copy.
3. Paste in the SQL editor and press Run. It should say "Success. No rows returned". (Safe to run twice.)

Step 2. Update the website files (3 minutes)
1. Copy the files of the update folder into your main Question Bank folder (replace when asked). Do not copy web/config.js.
2. GitHub: Add file > Upload files, drag the update folder contents (keep the folders), Commit. Do NOT upload web/config.js.
3. Wait about 1 minute, open the site and press Ctrl + F5.

No Supabase function deploy and no secret change is needed.

Files in this update
- supabase/migrations/0009_language.sql (new, run in Step 1)
- web/js/api.js, web/js/views/public.js, web/js/views/admin-questions.js, web/js/views/admin-worksheet.js
- docs/SETUP-GUIDE.md, docs/UPDATE-2026-10g.md
- tests/sql/10_database.sql, tests/e2e/ui.py, scripts/test-sql.sh (tests only)
