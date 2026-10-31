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

### 7. Spoonbook Plus (optional, switched off)
Spoonbook has a free tier and a paid "Plus" upgrade built in, but it's **off** until you choose to sell it. Nothing changes for anyone until then.
1. Now: run [`supabase/plus.sql`](supabase/plus.sql) in the SQL Editor once. It adds the plan columns and the switch, with the paywall off.
2. When you're ready to charge: set up a product in [Lemon Squeezy](https://www.lemonsqueezy.com) (it handles VAT and card payments as the seller). Put its checkout link and price in `config.js` (`checkoutUrl`, `plusPrice`).
3. Deploy [`supabase/functions/billing/index.ts`](supabase/functions/billing/index.ts) as a function called `billing` with **Verify JWT turned off**, and add a secret `LEMONSQUEEZY_SIGNING_SECRET` under **Edge Functions → Secrets**.
4. In Lemon Squeezy, add a webhook pointing at `https://YOUR-PROJECT.supabase.co/functions/v1/billing` with the same signing secret, sending the subscription events.
5. Switch it on: `update public.app_settings set paywall_enabled = true where id = 1;` (free cookbooks then hold 50 recipes; change `free_recipe_limit` to adjust).

### 8. Add your wife (or anyone else)
Tap **⋯ → Copy invite** and send it to her. She installs Spoonbook, creates her own account and enters the 6-letter code. You'll both see the same recipes, plan and shopping list, live.

---

## Features worth knowing about
- **Share to Spoonbook:** once installed, Spoonbook appears in Android's share sheet. Share a recipe page from Chrome (or a recipe's text from anywhere) and it opens ready to save.
- **No signal:** the cookbook, lists and every photo you've looked at are kept on the phone. Changes made offline sync when you're back online.
- **Simple mode:** for less confident cooks (⋯ → Simple mode, or the switch on a recipe's Method tab). Steps are split into one action at a time, cooking words are underlined and explained when tapped, there's a "before you start" prep list, and heat and food-safety tips appear where they matter. The recipe itself isn't changed. It's a setting on each phone.
- **Share a recipe:** the share button on a recipe can send a link. Anyone can open it on a nice recipe page; Spoonbook users tap “Save to my Spoonbook” and it's copied into their book, photo and all. New people are invited to make their own cookbook first. (Needs the latest `schema.sql` run in Supabase.)
- **Hands-free cooking:** tap the microphone in cooking mode. Steps are read out, and you can say "next", "back", "read it again", "ingredients", "start timer", "ten minute timer" or "stop".
- **Two dishes at once:** in cooking mode, tap "Add a second dish" to follow two recipes side by side, each with its own steps and timers.
- **Shop mode, cupboard staples and usuals:** on the shopping list. Staples (salt, pepper…) are left off when you add a recipe; usuals are one tap to add.
- **Tags and spice level:** set them when editing a recipe, then filter the book by them.
- **Recently deleted:** deleted recipes wait 30 days under **⋯ → Recently deleted**.
- **New in the book:** when the other cook adds or changes a recipe, it shows at the top of the book.

## Before sharing beyond family
`privacy.html` and `terms.html` are drafts. Replace everything in square brackets (your name, contact email, Supabase region, date), and have them checked properly before you charge money. People can delete their own account under **⋯ → Delete my account** (this needs the latest `schema.sql` run in Supabase).

## Things to know
- **Free Supabase projects pause after a week with no use.** If the app ever says it can't reach the cookbook after a long break, open supabase.com and press **Restore** on the project.
- **Back up now and then:** **⋯ → Back up all recipes** saves everything to a file.
- **Security:** the address and "anon" key in `config.js` are meant to be public. The database rules only let members of a cookbook see or change it. Never put the `service_role` key in this repository.

## Files
| File | What it is |
|---|---|
| `index.html` | The app |
| `backend.js` | Connects the app to Supabase (data, sign-in, photos) |
| `simple.js` | Simple mode: splits steps, explains cooking words, builds the prep list, adds heat and safety tips |
| `local.js` | Reads pasted recipes and photos, sorts the shopping list, works out calories, all on the phone |
| `nutrition.js` | Nutrition values for about 150 everyday ingredients, from UK government data |
| `config.js` | Your Supabase address and public key |
| `manifest.webmanifest`, `sw.js`, `icons/` | What makes it installable and quick to open |
| `r.html` | The public page for a recipe shared as a link |
| `privacy.html`, `terms.html` | Draft privacy policy and terms (fill in the placeholders) |
| `supabase/` | Database setup, the paywall switch (`plus.sql`), the link-clipping function and the billing function |

## Credits
Calorie and nutrient estimates use McCance and Widdowson's *The Composition of Foods Integrated Dataset* 2021 (Public Health England). Contains public sector information licensed under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).

Reading cookbook photos uses [Tesseract.js](https://github.com/naptha/tesseract.js) (Apache 2.0), which runs on the phone. It downloads its English reading data (about 10MB) the first time you snap a page, then works offline.
