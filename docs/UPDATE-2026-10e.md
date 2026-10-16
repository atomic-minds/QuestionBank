# Update: no separate Explanation for Short/Long answers, formulas drawn in lists

What is new
1. For Short answer and Long answer questions the AI now writes ONLY the Answer (the model answer in points). It no longer adds a separate Explanation, because the answer already is the explanation. (An explanation that is printed in your photo is still kept. Numerical, MCQ and other types still get an explanation.)
2. In Review drafts and Admin > All questions the question text now shows formulas properly (for example [Co(NH3)5SO4]Cl), instead of raw text like $\ce{...}$. Long questions show the first few lines only; open Edit to see everything.
3. The question number printed on the paper (for example "19." or "Q.5") is no longer copied into the question text. The app numbers the questions itself (Question 1, Question 2 ... in the review list). Part labels such as (a), (b), (i), (ii) stay. This also removes a leading number from the text if the AI still adds one.
4. A forgotten closing dollar sign from the AI, for example `(a) $\ce{A + B ->}`, is now closed automatically, and one stray dollar sign can no longer break the next line. Formulas are also drawn at the same size as the text around them.
5. A very long formula that cannot break (for example a cell diagram Sn(s) | Sn2+ || H+ | H2(g) | Pt(s)) used to make the whole page wider than a phone. Now it scrolls sideways inside its own line, on the question page and on the Review page.
6. Your screenshots were checked: answers, parts (a)/(b) kept together, and "How it will look" all work. Please still read each AI answer yourself, for example a test like "BaCl2 vs AgNO3" for ionisation isomers is easy for the AI to mix up.

How to update (about 5 minutes; no SQL)
1. Copy the files of the update folder into your main Question Bank folder (replace when asked). Do not copy web/config.js.
2. GitHub: Add file > Upload files, drag the update folder contents, Commit. (Do NOT upload web/config.js.)
3. PowerShell opened INSIDE your Question Bank folder:
```
npx.cmd supabase functions deploy extract-question
npx.cmd supabase functions deploy solve-questions
```
4. Open the site and refresh once. Questions already in your bank are not changed; the new rule applies to questions read or solved from now on.
