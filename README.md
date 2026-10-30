# Spoonbook

Our shared cookbook: recipes, photos, meal plans and the shopping list. It installs on Android as a proper app (its own icon, full screen) straight from the website, with no Play Store needed.

- **App:** the files in this folder, hosted free by GitHub Pages
- **Data, sign-in and photos:** Supabase (free plan)
- **No AI and no per-use costs.** Reading pasted recipes, reading cookbook photos, sorting the shopping list and calorie estimates all run on the phone itself.

---

## One-time setup

### 1. Supabase database
1. Open your Spoonbook project at supabase.com.
2. Go to **SQL Editor → New query**, paste in everything from [`supabase/schema.sql`](supabase/schema.sql) and press **Run**. It should say *Success. No rows returned*. (It's safe to run again.)

### 2. Supabase sign-in settings
1. Go to **Authentication → URL Configuration**.
2. Set **Site URL** to your app address: `https://YOUR-GITHUB-USERNAME.github.io/spoonbook/`
3. Add the same address under **Redirect URLs** and save.

New accounts get a "confirm your email" message by default. To skip that step for a household app, turn off **Confirm email** under **Authentication → Providers → Email**.

### 3. Supabase function (for adding recipes from a link)
In **Edge Functions → Deploy a new function → Via Editor**, name it `clip`, replace the example code with [`supabase/functions/clip/index.ts`](supabase/functions/clip/index.ts), and press **Deploy**.

### 4. GitHub Pages
In this repository on GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main`, folder `/ (root)` → Save**. After a minute the app is live at `https://YOUR-GITHUB-USERNAME.github.io/spoonbook/`.

### 5. Install it on Android
1. Open the app address in **Chrome**.
2. Tap **⋮ → Install app** (or **Add to Home screen → Install**).
3. Spoonbook appears in your app drawer with its own icon.

### 6. Bring your recipes across
1. Open Spoonbook, tap **I'm new here**, and create your account.
2. Enter your name and leave the code blank to start a new cookbook.
3. Tap **⋯ → Import a backup** and choose `spoonbook-backup.zip`. It takes a minute or two for the photos.

### 7. Add your wife (or anyone else)
Tap **⋯ → Copy invite** and send it to her. She installs Spoonbook, creates her own account and enters the 6-letter code. You'll both see the same recipes, plan and shopping list, live.

---

## Things to know
- **Free Supabase projects pause after a week with no use.** If the app ever says it can't reach the cookbook after a long break, open supabase.com and press **Restore** on the project.
- **Back up now and then:** **⋯ → Back up all recipes** saves everything to a file.
- **Security:** the address and "anon" key in `config.js` are meant to be public. The database rules only let members of a cookbook see or change it. Never put the `service_role` key in this repository.

## Files
| File | What it is |
|---|---|
| `index.html` | The app |
| `backend.js` | Connects the app to Supabase (data, sign-in, photos) |
| `local.js` | Reads pasted recipes and photos, sorts the shopping list, works out calories, all on the phone |
| `nutrition.js` | Nutrition values for about 150 everyday ingredients, from UK government data |
| `config.js` | Your Supabase address and public key |
| `manifest.webmanifest`, `sw.js`, `icons/` | What makes it installable and quick to open |
| `supabase/` | Database setup and the link-clipping function |

## Credits
Calorie and nutrient estimates use McCance and Widdowson's *The Composition of Foods Integrated Dataset* 2021 (Public Health England). Contains public sector information licensed under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).

Reading cookbook photos uses [Tesseract.js](https://github.com/naptha/tesseract.js) (Apache 2.0), which runs on the phone. It downloads its English reading data (about 10MB) the first time you snap a page, then works offline.
