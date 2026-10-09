# Export formats and how Atomic Minds uses them

The Question Bank is the **master**. Other systems (Atomic Minds TMS, a printout, another bank) receive **copies**. Every export carries the question's permanent Question Bank ID (`QB-CHEM-000123`), so a question can always be traced back and re-synchronised.

Three exports exist, all under **Admin → Export & backup**. Each can export *everything that matches the filters* (status, subject, chapter, type, general/exam, exam, year, difficulty, tag) or *only the questions you tick*.

## 1. Atomic Minds JSON (`atomic-minds-question-bank`, version 1)

File name: `atomic-minds-questions-YYYY-MM-DD.json`.

```json
{
  "format": "atomic-minds-question-bank",
  "version": 1,
  "exported_at": "2026-10-07T03:02:14.833Z",
  "generator": { "name": "question-bank", "version": "1.0.0" },
  "count": 1,
  "questions": [
    {
      "id": "QB-CHEM-000001",
      "revision": 1,
      "type": "mcq",
      "question": "Which of these is the SI unit of amount of substance?",
      "context": null,
      "options": ["kilogram", "mole", "kelvin", "candela"],
      "answer": 1,
      "answer_text": null,
      "answer_numeric": null,
      "match": null,
      "answer_pairs": null,
      "explanation": "The mole counts elementary entities.",
      "subject": "Chemistry",
      "chapter": "Some Basic Concepts of Chemistry",
      "topic": null,
      "category": "exam",
      "difficulty": "easy",
      "marks": 4,
      "tags": ["units", "mole"],
      "sources": [{ "exam": "JEE Main", "year": 2019, "paper": null }]
    }
  ]
}
```

### Field reference

Every key is **always present**; "not applicable" is `null` (or `[]`), so a consumer never has to test for missing keys.

| Key | Meaning |
| --- | --- |
| `format`, `version` | Contract name and number. A reader must refuse a higher `version` than it understands. Additive changes keep the version; breaking changes bump it. |
| `exported_at`, `generator`, `count` | Provenance and a sanity check (`count` equals `questions.length`). |
| `id` | The permanent Question Bank ID. Never reused, never changed. **Use it as the external key.** |
| `revision` | Increases every time the question is edited. If an imported `id` arrives with a higher `revision` than you hold, update your copy. |
| `type` | `mcq`, `true_false`, `assertion_reason`, `numerical`, `short_answer`, `long_answer`, `fill_blank`, `case_based`, `match_following`. |
| `question`, `context` | The question text, and an optional passage (case-based questions). Plain text; line breaks are `\n`. |
| `options` | Option texts **without** letters, in display order. `[]` for questions with no fixed options. |
| `answer` | **0-based index** into `options` of the correct option (`1` = second option = "B"). `null` when there are no options. |
| `answer_text` | The model answer for written types (short, long, fill-in-the-blank, case-based without options). |
| `answer_numeric` | `{ "value": number, "unit": string\|null, "tolerance": number\|null }` for numerical questions. Accept an answer within ± `tolerance` of `value`. |
| `match`, `answer_pairs` | Match-the-following: `{ "left": [...], "right": [...] }` and `[[leftIndex, rightIndex], ...]` (0-based). |
| `explanation` | Worked solution or `null`. |
| `subject`, `chapter`, `topic` | Names from the bank's taxonomy (`topic` may be `null`). Match them by name; they are stable but editable. |
| `category` | `"exam"` if the question has at least one exam appearance, otherwise `"general"`. |
| `difficulty` | `easy`, `medium`, `hard` or `null`. |
| `marks` | Number or `null`. |
| `tags` | Lower-case tags. |
| `sources` | Exam appearances: `{ exam, year, paper }`. A question may have several. |

### What is included

* By default only questions with **fixed options** (MCQ, true/false, assertion-reason). The others are listed as *skipped* on screen. Tick *Also include questions without fixed options* to export them with the `answer_text` / `answer_numeric` / `answer_pairs` fields.
* Choose *Published only* (the default) for anything students will see.

### How Atomic Minds should consume it

1. Read the file and check `format === "atomic-minds-question-bank"` and `version <= 1`.
2. For each question, **upsert by `id`**: create it if the ID is new; update it if `revision` is higher than the stored one; ignore it otherwise.
3. Store `id` on the Atomic Minds record (for example as `external_id`) so later exports update instead of duplicating.
4. Map `answer` (0-based) to your correct-option field, and `type` to your question types. Ignore unknown extra keys, so future additive versions stay compatible.
5. Never write back into the Question Bank from Atomic Minds. Corrections are made in the bank and re-exported.

## 2. Plain text

File name: `question-bank-YYYY-MM-DD.txt`. Easy to read, paste into a worksheet or share.

```
Q1. Which of these is the SI unit of amount of substance?

A. kilogram
B. mole
C. kelvin
D. candela

Ans: B

Exp: The mole counts elementary entities.
```

Options are on consecutive lines, answers and explanations are optional (tick boxes), and **QB IDs** can be included (`ID: QB-CHEM-000001`). Numerical answers print with their unit and tolerance; match-the-following prints *List I* and *List II* and answers like `A-2, B-1`.

## 3. Full backup (`qb-backup`, version 1)

File name: `question-bank-backup-YYYY-MM-DD.json`. Contains every field of each selected question, **including status and origin**, plus the taxonomy and exam list, so it can recreate the bank elsewhere. Use *Restore a backup* on the same page: the file is checked, shown for review (existing IDs are flagged), and only then saved, with the original IDs kept. A backup file holds at most 1000 questions (4 MB) so that the review screen stays responsive; the export refuses to create a bigger one, so export one subject or status per file. Exports never cut silently: if more than 20,000 questions match, they are refused with advice to narrow the filters.

Backups are the safety net on the Free plan because Supabase does not take automatic backups there. For a complete database copy use the Supabase CLI: `npx supabase db dump -f backup.sql`.

## Importing into the bank

*Add questions → Paste JSON* accepts, and tells you which it recognised:

* the product-brief shape (`question.text`, `question.options[{id,text}]`, `answer.value`, `classification`, `exam`, `metadata`),
* the simple flat shape (`type`, `question`, `options`, `answer`, `subject`, `chapter`, …) — **Copy example** shows it,
* an Atomic Minds export (so a bank can be rebuilt from it),
* a backup (via *Restore a backup*).

Limits: 100 questions and 1 MB per paste. Each question is checked on its own; the invalid ones are listed with a plain reason and the rest can be saved.

## Pictures and chemistry formatting (added with migration 0007)

* **Pictures are not part of the Atomic Minds JSON, the plain text, or the Full backup.** Those files carry the question text only. Take a **Pictures backup** as well (Admin > Export & backup > Pictures backup). It is a separate file, `question-bank-pictures-YYYY-MM-DD.json`:

  ```json
  { "format": "qb-pictures", "version": 1, "exported_at": "...", "count": 1,
    "pictures": { "QB-CHEM-000012": { "mime": "image/webp", "data": "<base64>" } } }
  ```
  Restore it after restoring the Full backup: each picture goes onto the question with the same ID.
* **Chemistry formatting is display only.** The stored and exported text is exactly what was typed (`H2SO4`, `Fe^{3+}`, `->`). The website and the printed worksheet show it as H₂SO₄, Fe³⁺ and →.
