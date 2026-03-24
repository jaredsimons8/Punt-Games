# PUNT GAME TRACKER — Deployment Guide
## Get your site live in ~20 minutes, no coding needed

---

## WHAT YOU'LL SET UP

| Service | What it does | Cost |
|---------|-------------|------|
| **Supabase** | Database + user logins | Free |
| **Vercel** | Hosts your website | Free |
| **GitHub** | Stores your code | Free |

Your final URL will look like: `https://punt-tracker.vercel.app`

---

## STEP 1 — Set Up Your Database (Supabase)

1. Go to **supabase.com** and click **Start for Free**
2. Sign up with GitHub or email
3. Click **New Project**
   - Name it: `punt-tracker`
   - Set a database password (save this somewhere)
   - Pick the region closest to you
   - Click **Create new project** (takes ~2 minutes)

4. Once ready, click **SQL Editor** in the left sidebar
5. Click **New query**
6. Open the file **`supabase-schema.sql`** from this folder
7. Copy ALL the contents and paste into the SQL editor
8. Click **Run** (green button)
9. You should see "Success. No rows returned" — your database is ready!

10. **Get your API keys** (you'll need these in Step 3):
    - Click **Settings** → **API** in the left sidebar
    - Copy **Project URL** (looks like: `https://xyzabc.supabase.co`)
    - Copy **anon public** key (long string starting with `eyJ...`)

---

## STEP 2 — Put Your Code on GitHub

1. Go to **github.com** and sign up / log in
2. Click the **+** icon → **New repository**
3. Name it: `punt-tracker`
4. Leave it Public (or Private — both work with Vercel free tier)
5. Click **Create repository**

6. On your computer, open **Terminal** (Mac) or **Command Prompt** (Windows)
7. Navigate to this folder:
   ```
   cd path/to/punt-tracker
   ```
8. Run these commands one by one:
   ```
   git init
   git add .
   git commit -m "Initial punt tracker"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/punt-tracker.git
   git push -u origin main
   ```
   *(Replace YOUR_USERNAME with your GitHub username)*

---

## STEP 3 — Add Your Supabase Keys to the Code

Before deploying, you need to insert your two Supabase keys into the app.

Open **`public/index.html`** in any text editor (Notepad, TextEdit, VS Code, etc.)

Find these two lines near the top of the `<script>` section:
```javascript
const SUPABASE_URL  = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON = 'YOUR_SUPABASE_ANON_KEY';
```

Replace the placeholder text with your actual values from Step 1:
```javascript
const SUPABASE_URL  = 'https://xyzabc.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...';
```

Save the file, then push the change to GitHub:
```
git add public/index.html
git commit -m "Add Supabase keys"
git push
```

---

## STEP 4 — Deploy to Vercel

1. Go to **vercel.com** and click **Sign Up**
2. Choose **Continue with GitHub** — authorize Vercel
3. Click **Add New...** → **Project**
4. Find your `punt-tracker` repository and click **Import**
5. Leave all settings as-is (Vercel auto-detects everything)
6. Click **Deploy**
7. Wait ~30 seconds — you'll see confetti 🎉

8. Click **Visit** to see your live site!
   Your URL will be something like `https://punt-tracker-xyz.vercel.app`
   You can add a custom domain later in Vercel settings if you want.

---

## STEP 5 — Enable Google Login (Optional but recommended)

1. In **Supabase** → **Authentication** → **Providers** → click **Google**
2. Toggle it **on**
3. Follow the on-screen instructions to create a Google OAuth app
   (takes ~5 minutes, all in Google Cloud Console)
4. Paste the Client ID and Secret back into Supabase
5. Add your Vercel URL to the redirect allow-list

---

## GOING FORWARD

Every time you want to update the app:
```
git add .
git commit -m "Description of change"
git push
```
Vercel automatically redeploys within 30 seconds.

---

## TROUBLESHOOTING

**"Invalid API key" error:** Double-check your Supabase URL and anon key are pasted correctly, no extra spaces.

**Login emails not arriving:** Check spam. In Supabase → Authentication → Email Templates you can customize them.

**Data not saving:** Open browser DevTools (F12) → Console tab and look for red error messages. Usually means the SQL schema wasn't run correctly — try running it again.

**Site not updating after code changes:** Force-refresh with Ctrl+Shift+R (Windows) or Cmd+Shift+R (Mac).

---

## YOUR SITE FEATURES

Once live, anyone who visits your URL can:
- Create an account (email or Google)
- Star their favorite teams (saved to their account)
- Analyze any MLB game date
- Log punt games with notes, results (W/L), and manual overrides
- All data persists permanently across sessions and devices

---

Questions? The Supabase docs at docs.supabase.com and Vercel docs at vercel.com/docs are excellent.
