# Update: "Create these topics" button on the Review page

What is new
1. When your JSON file (or a scan) names a topic that is not in your Taxonomy yet, the yellow box on the Review drafts page now lists each missing topic, the chapter it will go under, and how many questions use it. Below it is a button: "Create these N topics".
2. Nothing is created until you press the button. Check the spelling in the list first.
3. After you press it, every missing topic is added once under its chapter, and every question that asked for it is linked to it. The "no topic was set" notes disappear and the questions stay Ready. Then press "Save N selected" as usual.
4. Spellings that differ only by capitals, spaces or punctuation ("Atomic Models" and "atomic  models") count as the same topic and are created once.
5. If the topic already exists (for example you added it in Taxonomy after importing), it is linked automatically and is not offered again.
6. Subjects and chapters are still NOT created for you. A wrong chapter would scatter your questions, so those stay manual under Taxonomy.
7. If a hidden topic with the same name already exists, the button explains this instead of making a copy. Show that topic again under Taxonomy, then press the button again.

No database change. No secret change. No Supabase deploy. Only the website files change.

How to update (about 3 minutes)
1. Copy the files of the update folder into your main Question Bank folder (replace when asked). Do not copy web/config.js.
2. GitHub: Add file > Upload files, drag the update folder contents, Commit. (Do NOT upload web/config.js.) Cloudflare publishes the site by itself in about a minute.
3. Open the site and refresh the page once (Ctrl + F5).
4. Test: Add questions > Paste JSON > import your 45 questions again. The yellow box should show the topics with a "Create these 4 topics" button.

Files in this update
- web/js/views/topic-fix.js (new)
- web/js/views/admin-review.js
- web/css/app.css
- tests/core/topic-fix.test.js (new, tests only)
- tests/e2e/ui.py (tests only)
- docs/UPDATE-2026-10f.md (this note)
