# Update: printed options make a question MCQ, better instructions for another AI, plain "JSON" export

What is new
1. A question that prints options (a) to (d) is now an MCQ, even if it is a calculation and the options are numbers. This is done in two places: the photo reader is told so, and any photo or JSON import that says "Numerical" (or Short / Long answer, Fill in the blank) but also has 2 or more options is turned into an MCQ by the app. Its answer is matched to the option that holds the value, for example 100 g/mol becomes option B. A calculation keeps its nature as the tag "numerical", so you can still find it with the Tag filter. The review page says "made a multiple-choice question" so you know. If the answer matches no option, or two options, the question stays "Needs fixing" and you choose the correct option yourself.
2. "Copy instructions for another AI" (Add questions > Paste JSON > Format help) was rewritten. Another AI (ChatGPT, Gemini, Claude...) that gets your photo and this text now knows: reply with the JSON object only (no code fence), how to write backslashes in formulas, every question type and its answer format, that printed options mean MCQ, how to write explanations, to keep Bengali as Bengali, not to copy the printed question number, to keep parts (a)(b) together, and the exact subject, chapter, topic and exam names of YOUR bank. Up to 30 questions per reply; write "continue" for the rest. The page also shows the 4 steps to use it.
3. When an AI forgets to double a backslash, formulas such as $\frac{1}{2}$ or $\times$ are now repaired on JSON import too (also when the formula starts with the command), and a forgotten closing dollar sign is closed. Normal dollar amounts like "$5 or $10" are left alone. Backups are never changed.
4. Export & backup: the first format is now simply called "JSON" and the file is named question-bank-questions-DATE.json. The word "Atomic Minds" is gone from the screen. Inside the file the technical format id is unchanged on purpose, so earlier exports and any system that already reads it keep working.

This update builds on the Language filter update (update 7). If you have not applied that one yet, use the full zip, or apply update 7 first (it has an SQL step).

How to update (about 6 minutes; NO SQL)
1. Copy the files of the update folder into your main Question Bank folder (replace when asked). Do not copy web/config.js.
2. GitHub: Add file > Upload files, drag the update folder contents (keep the folders), Commit. Do NOT upload web/config.js.
3. PowerShell opened INSIDE your Question Bank folder:
```
npx.cmd supabase functions deploy extract-question
npx.cmd supabase functions deploy solve-questions
```
(A Docker warning is harmless.)
4. Wait about 1 minute, open the site and press Ctrl + F5.
5. Test: Add questions > Paste JSON > Format help > press "Copy instructions for another AI", paste it in another AI with a photo, and paste its reply back in the box.
