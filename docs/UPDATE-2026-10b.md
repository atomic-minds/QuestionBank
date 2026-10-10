# Update: Delete buttons and filter-first question lists

What is new
1. Delete is now available for every question, any status:
   - on the edit page (red "Delete permanently" button under Save),
   - on every row of Admin > All questions (red "Delete"),
   - for many at once: tick the boxes, then press "Delete...".
2. Strong confirmation every time. A pop-up shows the question ID and text, warns if it is published, and says it cannot be undone.
   - Deleting a draft/review/archived question: press "Delete permanently" in the pop-up.
   - Deleting a PUBLISHED question, or several at once: you must also type the word DELETE.
   - Deleting also removes the question's picture and exam tags. IDs are never reused.
   - Not sure? Use Archive (hides it, can be restored) or download a Full backup first.
3. The public "All questions" page and the admin "All questions" page no longer list everything at the start.
   - Dropdown filters sit across the top: Subject, Chapter, Topic, Question type, and under "More filters": Kind, Exam, Year, Difficulty, Marks, Tag. A search box is on top too.
   - Chapter fills after you pick a Subject; Topic fills after you pick a Chapter.
   - Nothing is listed until you choose something (any dropdown, a word in the search box, or on the admin page a status tab such as Review).
   - "Clear all filters" goes back to the empty start.
   - The left filter menu is gone.
   - Public dropdowns show how many published questions each choice has. Admin dropdowns do not show counts (they also cover drafts); Year is a list of years, Marks and Tag are small boxes.

How to update (about 5 minutes; no SQL and no function deploy this time)
1. GitHub: open the repository > Add file > Upload files. Drag in the contents of the update folder (keep the folder names `web`, `docs`, `tests`). Do NOT upload `web/config.js`. Commit. Cloudflare publishes the site by itself.
2. Open the site and refresh once. On a phone, close and reopen the tab if the old look stays.
