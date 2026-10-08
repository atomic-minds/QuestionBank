# Setup guide for beginners

This guide takes you from nothing to a live Question Bank, one small step at a time. You do not need to be a programmer. Allow about 60–90 minutes the first time.

**Everything here is free, and nothing asks for a card.** If any website ever asks you to enter card details, "upgrade", "enable billing" or "start a trial", **stop and close that page**: you do not need it. The last section lists what to avoid.

> The dashboards of Supabase, Cloudflare, GitHub and Google change their menus now and then. If a button has a slightly different name, look for the closest one. The names below were checked against each service's own documentation in October 2026.

---

## What you are building

| Piece | What it does | Where it lives |
| --- | --- | --- |
| **The website** | What students and you see | Cloudflare (free) |
| **The database** | Stores questions, answers, explanations | Supabase (free) |
| **Two small server functions** | Read an image with AI; save questions safely | Supabase (free) |
| **The AI** | Reads a photo of questions (optional; you can skip it) | Google Gemini (free) |
| **Your code** | The files in this folder | GitHub (free) |

Photos you upload are only shown to the AI and then thrown away. They are never saved. Only the question text, options, answer and explanation are stored.

---

## Step 0. Install three free tools on your computer

1. **Node.js** (the "LTS" version): <https://nodejs.org>. Run the installer and accept the defaults.
2. **Git**: <https://git-scm.com/downloads>. Accept the defaults.
3. A **terminal**:
   * Windows: press the Windows key, type `PowerShell`, press Enter.
   * Mac: press ⌘ + Space, type `Terminal`, press Enter.

Check that it worked. Type this and press Enter:

```
node --version
```

You should see a number like `v22.x.x`. Install the **LTS** version (22 or newer); the tests in this project need 22. Then:

```
git --version
```

---

## Step 1. Put the code on GitHub

GitHub keeps your code and lets Cloudflare publish it.

1. Create a free account at <https://github.com> (Sign up).
2. Click the **+** at the top right → **New repository**.
3. Name it `question-bank`. Choose **Private** (recommended) or Public. Leave everything else untouched. Click **Create repository**.
4. In your terminal, go into the folder that holds this project (the one containing `wrangler.jsonc`). For example: `cd Downloads/question-bank`.
5. Run these lines one by one (replace `YOUR-NAME` with your GitHub username):

```
git init
git add .
git commit -m "First version"
git branch -M main
git remote add origin https://github.com/YOUR-NAME/question-bank.git
git push -u origin main
```

GitHub may open a browser window asking you to sign in; do that. Refresh your repository page: you should now see the files.

---

## Step 2. Create the database (Supabase)

1. Go to <https://supabase.com> and click **Start your project**. Sign in with GitHub.
2. Create an **organization** if asked (any name; keep the **Free** plan).
3. Click **New project** and fill in:
   * **Name**: `question-bank`
   * **Database password**: click *Generate a password*, then **copy it into a password manager or a safe note**. You will almost never need it, but you cannot see it again.
   * **Region**: the one closest to your students (for India, choose Mumbai / South Asia if listed).
   * Make sure the plan shown is **Free**.
4. Click **Create new project**. Wait 1–2 minutes until the dashboard appears.

### 2a. Write down your two public settings

You need two values for the website later. They are **meant to be public**:

* **Project URL**: looks like `https://abcdefghijklmnop.supabase.co`. Find it under **Project Settings → Data API** (or in the **Connect** button at the top).
* **Publishable key**: starts with `sb_publishable_`. Find it under **Project Settings → API Keys**. (If you only see an older key named `anon`, that also works with this project.)

Also on the API Keys page there is a **secret** key (`sb_secret_…`) and a `service_role` key. **Never copy those anywhere.** This project does not use them.

Also note your **project reference**: the first part of the URL (`abcdefghijklmnop`). Find it under **Project Settings → General**.

### 2b. Create the tables

1. In the left menu click **SQL Editor** → **New query**.
2. On your computer open the file `supabase/migrations/0001_schema.sql` in any text editor (Notepad is fine). Select all, copy.
3. Paste into the SQL editor and click **Run**. You should see **Success. No rows returned**.
4. Repeat for the next files, **in this order**, each in a fresh query:
   `0002_security.sql` → `0003_api.sql` → `0004_reference_data.sql` → `0005_starter_taxonomy.sql`.

`0005` is optional (it is a normal migration file, so if you ever use `npx supabase db push` instead of the SQL editor, it will be applied too; you can then simply delete the rows you do not want in the Taxonomy page). It adds a starter list of Chemistry chapters and exams (CBSE, JEE Main…) so you are not starting from nothing. You can change all of it later in the app. If you want no starter list, skip `0005` and add your own subjects in the Taxonomy page.

If a step shows a red error, do not continue. Copy the message and see **Troubleshooting** at the end.

### 2c. Stop strangers from signing up

Anyone who could sign up still could not change anything (the database checks an admin list), but turn it off anyway:

1. Left menu **Authentication** → **Sign In / Providers** (older dashboards: **Providers** or **Settings**).
2. Find **Allow new users to sign up** and switch it **off**. Save.

### 2d. Create your own admin login

1. **Authentication → Users → Add user → Create new user**.
2. Enter your email and a strong password. Tick **Auto Confirm User** if shown. Click **Create user**.
3. Now tell the database that this person is an admin. Go to **SQL Editor → New query**, paste this (change the email to yours), and click **Run**:

```sql
insert into public.admin_users (user_id)
select id from auth.users where email = 'you@example.com';
```

4. Check: run `select * from public.admin_users;`. You should see one row.

To add a second admin later, create the user as above and run the same statement with their email.

---

## Step 3. Get a free Gemini key (optional but recommended)

You can skip this whole step and still use the app: **Paste JSON** and **Write one** work without any AI. Add the AI later whenever you like.

1. Open <https://aistudio.google.com/apikey> and sign in with a Google account.
2. Click **Create API key**. Copy it somewhere safe. This is a **secret**: it only ever goes into Supabase in Step 4, never into the website files.
3. **Use a brand-new project with no billing.** When AI Studio asks which Google Cloud project the key belongs to, choose *Create API key in new project*. Do **not** pick an older project you may have attached billing to: a key from a billed project is on a paid tier. After creating the key, the AI Studio keys page should show the **Free tier** for it. **Do not link a billing account** and do not click anything that says *upgrade*, *Set up billing* or *Tier*. Google's documentation says the free tier needs no billing and that linking billing moves you to a paid tier with spending limits. When the free quota runs out the AI simply answers "quota exceeded" and this app tells you so; nothing is charged.
4. Choose a **model name**. Open <https://aistudio.google.com/rate-limit> and look at which models show a limit above zero for your project. Open <https://ai.google.dev/gemini-api/docs/models> for the exact model code (for example a "Flash-Lite" model is the cheapest to run). Copy the code exactly as written. Model names change, so this app deliberately has no built-in default.

> **Privacy:** on Google's free tier, Google may use what you send to improve its products and humans may review it. Only send images you are comfortable with. For anything private use **Paste JSON** instead.

---

## Step 4. Deploy the two server functions

These run on Supabase's free servers. You do this once.

In your terminal, in the project folder:

```
npx supabase login
```

A browser window opens; approve it. (The first run may ask to install the tool: answer `y`.)

```
npx supabase link --project-ref YOUR-PROJECT-REF
```

Replace `YOUR-PROJECT-REF` with the value from Step 2a. It may ask for the database password from Step 2; paste it.

Now store the AI settings as **secrets** (replace the values; keep the other lines as they are):

```
npx supabase secrets set GEMINI_API_KEY=paste-your-key-here GEMINI_MODEL=paste-the-model-code-here AI_PROVIDER=gemini AI_DAILY_LIMIT=20 DB_SOFT_LIMIT_MB=450
```

(You can instead enter these in the dashboard under **Edge Functions → Secrets**.) If you skipped Step 3, set only `AI_DAILY_LIMIT` and `DB_SOFT_LIMIT_MB`; the image feature then says it is not configured and everything else works.

Finally deploy:

```
npx supabase functions deploy
```

This should list `extract-question` and `save-questions` as deployed. If it complains about Docker, see Troubleshooting.

---

## Step 5. Connect the website to your database

1. Open the file `web/config.js` (on GitHub: open the file and click the pencil icon).
2. Fill in the two public values from Step 2a, and change the copyright name if you like:

```js
window.QB_CONFIG = {
  supabaseUrl: 'https://abcdefghijklmnop.supabase.co',
  supabasePublishableKey: 'sb_publishable_xxxxxxxxxxxxxxxx',
  siteName: 'Question Bank',
  copyright: 'AyanP_Chem',
};
```

3. Save and send it to GitHub. In the terminal: `git add web/config.js`, then `git commit -m "Connect to Supabase"`, then `git push`. (Or use **Commit changes** on GitHub if you edited there.)

---

## Step 6. Publish the website (Cloudflare)

1. Create a free account at <https://dash.cloudflare.com/sign-up>.
2. Left menu **Workers & Pages** → **Create** → **Import a repository** (Git integration).
3. Connect your GitHub account and choose the `question-bank` repository.
4. In the settings screen:
   * **Project name**: `question-bank`
   * **Production branch**: `main`
   * **Build command**: leave **empty** (there is nothing to build)
   * **Deploy command**: leave the default `npx wrangler deploy`
   * **Root directory**: leave empty
5. Click **Save and Deploy**. After a minute you get an address like `https://question-bank.your-name.workers.dev`.

Open it. You should see the Question Bank home page. Every time you `git push`, Cloudflare republishes automatically.

Optional hardening: once the site works, set the secret `ALLOWED_ORIGINS` to your site address so only your site can call the functions:
`npx supabase secrets set ALLOWED_ORIGINS=https://question-bank.your-name.workers.dev`

---

## Step 7. First run

1. Go to `your-site/admin` and sign in with the admin email and password from Step 2d.
2. **Taxonomy**: check your subjects and chapters (add your own if you skipped the starter list). Questions can only be filed under chapters that exist here.
3. **Add questions → Paste JSON**: open "Format help, example…", click **Copy example**, paste it into the box and press **Check and preview**. You will land on **Review drafts**. Choose *Save as: Draft* and click **Save**.
4. **Add questions → From an image** (if you did Step 3): choose a clear photo of one or two questions, add a subject if you know it, press **Read the questions**. Check every answer. Answers the AI had to work out are marked, and you must fill any missing answer yourself.
5. **All questions → Publish** the ones you have checked. Open the public site: they appear under their subject and chapter, with a **Show answer** button.
6. **Export & backup**: try *Plain text* and *Atomic Minds JSON* to see the files.

Only **published** questions are visible to the public.

---

## Step 8. Stop Supabase from going to sleep (once)

Free Supabase projects are paused when nobody uses them for a while (about a week, according to Supabase; a paused project can be restored from the dashboard for 90 days). The included GitHub job pings your database every three days.

1. On GitHub open your repository → **Settings → Secrets and variables → Actions → Variables** tab → **New repository variable**.
2. Add `SUPABASE_URL` (your project URL) and `SUPABASE_PUBLISHABLE_KEY` (the `sb_publishable_…` key). These are public values, so variables (not secrets) are fine.
3. Open the **Actions** tab → *keep-supabase-awake* → **Run workflow** once to test. It should turn green.

On **public** repositories GitHub switches off scheduled jobs after about 60 days without any repository activity; if that happens, open the **Actions** tab and re-enable the workflow (or push a small change). This does not apply to private repositories. The job reports a failure until the two variables above exist.

---

## Step 9. Back up regularly

The Free plan has **no automatic backups**. Once a month (and before big changes): **Admin → Export & backup → Full backup → Download**. Keep the file somewhere safe (cloud drive). To restore, use *Restore a backup* on the same page; you review everything before it is saved.

If you are comfortable with the terminal you can also take a complete database copy: `npx supabase db dump -f backup.sql`.

---

## Troubleshooting

| What you see | What to do |
| --- | --- |
| Red error while running a migration | Run the files strictly in order. If one failed half-way, the simplest fix on a brand-new project is to delete it (Project Settings → General → Delete project) and create a fresh one, then redo Step 2. Do not try to wipe the `public` schema by hand. |
| "This site is not connected to its database yet" | `web/config.js` still has empty values, or the push has not reached Cloudflare yet. Wait a minute after pushing. |
| Admin sign-in says **not an admin** | You skipped the `insert into public.admin_users …` statement, or used a different email. Re-run it. |
| Admin sign-in says wrong email or password | Re-create the user in Authentication → Users, or reset the password there. |
| `npx supabase functions deploy` asks for Docker or fails to bundle | Try `npx supabase functions deploy --use-api`. If it still fails, upgrade the tool with `npx supabase@latest functions deploy`. |
| "Could not reach the server function" | The functions are not deployed (redo Step 4), or the project is paused (open the Supabase dashboard and click **Restore**). |
| AI says "not configured" | `GEMINI_API_KEY` or `GEMINI_MODEL` is missing. Run the `secrets set` line again. |
| AI says the free quota is used up | Wait until it resets (midnight Pacific time) or use **Paste JSON**. As long as billing was never enabled for the key, nothing is charged. |
| AI says the model is unavailable | The model name is wrong or not free for your account. Pick another from the Gemini models page and run `secrets set GEMINI_MODEL=…` again. |
| "New questions are paused" | The database is near the free 500 MB limit. Export a backup, archive or delete old questions, or raise `DB_SOFT_LIMIT_MB` slightly. |
| A page shows "not found" after refreshing | Check `wrangler.jsonc` was deployed unchanged (it contains `single-page-application`). |

---

## Staying at ₹0: the short list

* Never enter a card number anywhere. Never click **Upgrade**, **Add billing**, **Pro**, **Tier**, **Enable billing** or a trial.
* Never put the Gemini key, the Supabase `secret`/`service_role` key or any password in `web/config.js` or in GitHub.
* If a free quota runs out, the app tells you and waits; the fix is to wait or use Paste JSON, not to pay.
* Keep `AI_DAILY_LIMIT` below the free daily limit shown in Google AI Studio for your model.
