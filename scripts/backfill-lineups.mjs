// backfill-lineups.mjs
// ───────────────────────────────────────────────────────────────────────────
// One-time backfill for The Punt Index. Pulls every COMPLETED regular-season
// game between START and END (inclusive) from the MLB Stats API and inserts any
// per-team lineup rows that aren't already in shared_lineup_baselines.
//
// Safe to re-run: it first reads what's already stored in the date range and
// only inserts rows that are missing (keyed by team + date + starting pitcher,
// so both halves of a doubleheader are kept).
//
// Run (start date = a few days before the gap; end defaults to today):
//   node backfill-lineups.mjs 2026-05-20
//   node backfill-lineups.mjs 2026-05-20 2026-06-01   # explicit end
//
// Needs env vars SUPABASE_URL and SUPABASE_SERVICE_KEY (service_role, NOT anon)
// and Node 18+ (built-in fetch).
// ───────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY (service_role) env vars first.');
  process.exit(1);
}
const db = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const START = process.argv[2] || '2026-03-01';            // safe early default
const END   = process.argv[3] || new Date().toISOString().slice(0, 10);
const API   = 'https://statsapi.mlb.com/api/v1';
const FIP_CONSTANT = 3.10;                                 // league baseline

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url) {
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch { /* retry */ }
    await sleep(500 * (i + 1));
  }
  throw new Error('fetch failed: ' + url);
}

function* eachDate(start, end) {
  const d = new Date(start + 'T00:00:00Z');
  const last = new Date(end + 'T00:00:00Z');
  while (d <= last) {
    yield d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

// Season pitching stats, cached per pitcher id.
const spCache = new Map();
async function pitcherStats(id, season) {
  if (!id) return { era: null, fip: null };
  if (spCache.has(id)) return spCache.get(id);
  let out = { era: null, fip: null };
  try {
    const data = await getJSON(`${API}/people/${id}/stats?stats=season&group=pitching&season=${season}`);
    const st = data?.stats?.[0]?.splits?.[0]?.stat;
    if (st) {
      const era = st.era != null ? parseFloat(st.era) : null;
      const ip  = parseFloat(st.inningsPitched || 0);
      const hr  = +st.homeRuns || 0, bb = +st.baseOnBalls || 0,
            hbp = +st.hitByPitch || 0, so = +st.strikeOuts || 0;
      const fip = ip > 0
        ? Math.round(((13 * hr + 3 * (bb + hbp) - 2 * so) / ip + FIP_CONSTANT) * 100) / 100
        : null;
      out = { era: Number.isFinite(era) ? era : null, fip };
    }
  } catch { /* leave nulls */ }
  spCache.set(id, out);
  return out;
}

// Build the per-team rows for one date (only Final games have a real lineup).
async function rowsForDate(date) {
  const season = date.slice(0, 4);
  const sched = await getJSON(`${API}/schedule?sportId=1&date=${date}&gameType=R`);
  const games = sched?.dates?.[0]?.games || [];
  const rows = [];
  for (const g of games) {
    if (g.status?.abstractGameState !== 'Final') continue;
    let box;
    try { box = await getJSON(`${API}/game/${g.gamePk}/boxscore`); }
    catch { continue; }
    for (const side of ['home', 'away']) {
      const t = box.teams?.[side];
      if (!t) continue;
      const players = t.players || {};
      const order   = (t.battingOrder || []).slice(0, 9);
      const lineup  = order.map((pid) => players['ID' + pid]?.person?.fullName).filter(Boolean);
      if (lineup.length < 7) continue;                      // no usable order recorded
      const spId    = (t.pitchers || [])[0] || null;
      const spName  = spId ? (players['ID' + spId]?.person?.fullName || null) : null;
      const { era, fip } = await pitcherStats(spId, season);
      rows.push({
        team_name: t.team?.name,
        game_date: date,
        lineup,                                             // array of player names
        sp_name: spName,
        sp_fip: fip,
        sp_era: era,
        opp_team: box.teams?.[side === 'home' ? 'away' : 'home']?.team?.name || null,
      });
    }
    await sleep(120);
  }
  return rows;
}

// Keys already in the table for the range, so we never double-insert.
async function existingKeys(start, end) {
  const keys = new Set();
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from('shared_lineup_baselines')
      .select('team_name,game_date,sp_name')
      .gte('game_date', start).lte('game_date', end)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    data.forEach((r) => keys.add(`${r.team_name}|${r.game_date}|${(r.sp_name || '').toLowerCase()}`));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return keys;
}

async function flush(rows) {
  if (!rows.length) return;
  const { error } = await db.from('shared_lineup_baselines').insert(rows);
  if (error) console.error('  ⚠️ insert error:', error.message);
  else console.log(`  ✓ inserted ${rows.length} rows`);
}

(async () => {
  console.log(`Backfill ${START} → ${END}`);
  const have = await existingKeys(START, END);
  console.log(`Already stored in range: ${have.size} rows`);

  let batch = [];
  let totalNew = 0;
  for (const date of eachDate(START, END)) {
    let rows = [];
    try { rows = await rowsForDate(date); }
    catch (e) { console.warn(`  ${date}: ${e.message}`); continue; }

    const fresh = rows.filter((r) => {
      const k = `${r.team_name}|${r.game_date}|${(r.sp_name || '').toLowerCase()}`;
      if (have.has(k)) return false;
      have.add(k);
      return true;
    });
    batch.push(...fresh);
    totalNew += fresh.length;
    if (rows.length || fresh.length) console.log(`  ${date}: ${rows.length} team-games, ${fresh.length} new`);
    if (batch.length >= 200) await flush(batch.splice(0));
    await sleep(150);
  }
  await flush(batch);
  console.log(`Done. Inserted ${totalNew} new rows.`);
  process.exit(0);
})();
