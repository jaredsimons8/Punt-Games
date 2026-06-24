# CLAUDE.md — The Punt Index

Project brief for Claude Code. Read this first; it captures conventions and
hard‑won context so you don't have to re‑derive them each session.

## What this is
The Punt Index is a single‑page web app that detects MLB "punt games" — games a
team has effectively decided not to try to win (resting regulars, spot starter,
no announcement). It scores every game 0–80 and flags it punt / review / clean.
Live at https://punt-games.vercel.app. Repo: github.com/jaredsimons8/Punt-Games.

## Architecture (important: it's unusual)
- **Everything is in one file: `index.html`** — ~8,700 lines, inline vanilla JS
  (no build step, no framework, no bundler). All logic, styles, and markup live
  here. Edit this file directly.
- **`scripts/collect-lineups.js`** — Node script run daily by GitHub Actions.
  Collects each finished game's lineups and writes them to Supabase. This is the
  ONLY thing that writes to `shared_lineup_baselines`.
- **`scripts/backfill-lineups.mjs`** — one‑off catch‑up; walks a date range and
  inserts missing games. Safe to re‑run (skips existing).
- **`.github/workflows/collect-lineups.yml`** — daily cron (`0 9 * * *`) +
  manual trigger. **`backfill-lineups.yml`** — manual catch‑up with date inputs.
- **MLB data** comes from `statsapi.mlb.com/api/v1`, proxied in production
  through `/api/mlb?path=...` (see `apiFetch`). Locally it hits MLB directly.
- **Deploy:** push to `main` → Vercel auto‑deploys in ~30s. Jared usually edits
  via the GitHub web UI, but with a clone you can commit/push directly.

## Supabase
- Project URL: `https://pjbnsonfojyzbjjawpxu.supabase.co`
- Tables:
  - `shared_lineup_baselines` — server‑written lineups. Columns include
    team_name, game_date, game_pk, lineup[], sp_name, sp_era, opp_team. Unique
    on (team_name, game_pk). Read by every user; drives "games played" and the
    calibration bars.
  - `game_log` — per‑user scored games. Keyed (user_id, game_id). Columns:
    game_date, away_team, home_team, punt_team, punt_side, punt_score, flag,
    result, override, notes, breakdown. Row‑level‑security isolates users.
  - `user_preferences` — starred_teams, etc.
- Secrets live in GitHub Actions: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
  (service_role, NOT anon). Never commit keys.
- Free tier auto‑pauses after ~7 days idle — a paused project returns 0 rows and
  the site shows everything as `0/60`. Restore it in the dashboard.

## Core scoring constants
- `PUNT_THRESH = 46`  → score ≥46 is a punt
- `REVIEW_THRESH = 28` → 28–45 is "review" (needs a human decision)
- below 28 = "clean" (auto not‑a‑punt)
- `CALIBRATION_GAME_THRESHOLD = 60` → a team needs 60 games of collected lineup
  data before its games get scored; until then they're flagged `calibration`
  (score 0). This is why a stalled collector freezes everything.

## Key functions (in index.html)
- `analyzeGame(game, normalLineups)` — scores one game; returns flag, topScore,
  puntSide, breakdown, etc.
- `computePuntScore(...)` — the scoring engine.
- `buildScoreBreakdown(g)` — per‑factor breakdown shown in cards / review detail.
- `fetchGames()` — loads + analyzes + renders the selected date (Today tab).
- `addGamesToLog()` / `buildLogEntry()` — write viewed games into `game_log`.
- `rebuildSeasonLog()` — re‑scores/adds the WHOLE season into `game_log`
  (admin tool on the Reviews tab). Reuses `analyzeDateSilent()`.
- `renderGameflowChart()` — inning‑by‑inning punt‑score chart (Gameflow tab).
- `isAdmin()` + `ADMIN_EMAILS` — only listed emails can make review decisions.

## Conventions / preferences (Jared)
- Terse, direct. Wants WORKING deliverables, not multiple broken iterations.
- **Triple‑check before shipping.** For index.html, that means: extract the
  inline JS and run `node --check`, run ESLint with no‑undef, confirm `<div>`
  balance and template‑literal parity, and check for duplicate element IDs.
- One step at a time; confirm before moving on.
- Single‑file constraint is intentional — do not introduce a build step,
  framework, or split the file without asking.
- Deploy is via GitHub → Vercel; mention the deploy step in instructions.

## Common gotchas (learned the hard way)
- A frozen "games played" count = the daily collector stopped (cron disabled
  after 60 days idle, a failing run, or a paused Supabase project). The fix is
  in the repo/Actions, NOT in index.html.
- The per‑user `game_log` only gets a game when that date is opened in the app
  (or via `rebuildSeasonLog`). It is not auto‑populated for the whole season.
- Scoring lives in the browser, so bulk season scoring is a heavy client‑side
  job. A good future project: move scoring server‑side so the daily Action
  scores each game on collection and writes results to a shared table.
- `node --check` does NOT catch undeclared variables — always run ESLint too.
