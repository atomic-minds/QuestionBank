# Update: AI always writes answers, step-by-step solutions, proper maths, "Solve with AI"

What is new
1. The AI now ALWAYS writes an answer, also for Short answer, Long answer and Numerical questions. If the photo shows no answer, the AI works it out. You can edit everything afterwards.
2. Numerical questions get a worked solution in this order: Given, To find, Concept / formula, Steps, Answer. Short and Long answers get a model answer in points.
3. Maths and chemistry are drawn properly (fractions, powers, roots, integrals, subscripts, equations, reaction arrows) using KaTeX with chemistry support. The files are inside the site, nothing is loaded from the internet.
   - In any text box you can type maths between dollar signs: `$\frac{a}{b}$` inside a sentence, `$$x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}$$` on its own line, and chemistry like `$\ce{2H2 + O2 -> 2H2O}$`.
   - A dollar sign used for money (for example "Rs $5") is left alone. To force a plain dollar sign type `\$`.
   - The editor shows "How it will look" under the question. The printable worksheet also shows the maths.
4. Parts (a), (b) or (i), (ii) of one question now stay together as ONE question, and the answer covers every part.
5. New "Solve with AI" button:
   - In the editor (new or saved question): under the question text.
   - On the Review page: one button on every question, and "Solve with AI..." at the top for all questions that have no answer from your source (answers printed in your source are left alone).
   - On Admin > All questions: tick questions, press "Solve with AI...". The new answers REPLACE the saved ones. Published questions go live with the new answer, so move them to draft first if you want to check before anyone sees it.
   - It uses a stronger AI model than the one that reads photos (see step 4 below). Up to 5 questions go in one request and count as ONE of your daily AI uses.
6. "AI-solved: check" marker, ADMIN SCREENS ONLY. Any question whose answer or explanation was written by the AI is marked until you press "Mark as checked" (on the edit page, on the row in the list, or for many at once with the "Mark as checked" button). Readers on the public site never see this.
7. Not included (as agreed): AI-drawn diagrams. Add a picture of a figure the usual way.

How to update (about 15 minutes)

Step 1. Add the new database part (SQL)
1. Supabase > SQL Editor > New query.
2. On your computer open the file `supabase/migrations/0008_ai_check.sql` in Notepad. Select all, copy.
3. Paste in the SQL editor and press Run. It should say "Success. No rows returned". (Safe to run twice.)

Step 2. Upload the files to GitHub
1. GitHub: your repository > Add file > Upload files. Drag in the contents of the update folder (keep the folder names `web`, `supabase`, `docs`, `tests`, `scripts`). Do NOT upload `web/config.js`. Commit. Cloudflare publishes the site by itself.

Step 3. Deploy the functions (Windows PowerShell, inside your project folder)
```
npx.cmd supabase functions deploy extract-question
npx.cmd supabase functions deploy solve-questions
```
`solve-questions` is new. (`save-questions` did not change.)

Step 4. Choose the stronger model (optional but recommended)
1. On Google's pricing page (ai.google.dev/gemini-api/docs/pricing) look for a model that says Free of charge for the Free Tier. On 15 Oct 2026 the strongest free one listed was `gemini-3.8-flash`. The "Pro" models were NOT free, do not use them.
2. Run (replace the name with the exact code from the page):
```
npx.cmd supabase secrets set GEMINI_SOLVE_MODEL=gemini-3.8-flash
```
If you skip this step, Solve with AI uses your normal model (`GEMINI_MODEL`). Never link a billing account at Google.

Step 5. Check it
1. Open the site and refresh once (on a phone close and reopen the tab).
2. Admin > Add questions > From image. Read a photo of a numerical question. On the Review page the answer and the steps should already be there, marked "Answer worked out by AI".
3. Save it. On Admin > All questions you will see "AI-solved: check" next to it. Open it, read the answer, press "Mark as checked".

Good to know
* Everything the AI writes is a suggestion. Read it before publishing. The AI can be wrong, especially on long calculations.
* The daily limit (20) is shared by photo reading and Solve. When it is reached it says so, and you can still write answers by hand.
* If Google says its free limit is used up, the use is given back and nothing is charged.
