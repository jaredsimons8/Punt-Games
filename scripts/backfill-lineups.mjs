// backfill-lineups.mjs  (migration + backfill — Option B: one row per GAME)
// ───────────────────────────────────────────────────────────────────────────
// Run AFTER the two SQL steps (add game_pk column, swap unique constraint to
// (team_name, game_pk)). For every date in range it:
//   1. STAMPS each existing row that has a null game_pk with its real game_pk
//      (preserves the stored lineup/stats — only fills in game_pk).
//   2. INSERTS any game that isn't stored yet — including both halves of a
//      doubleheader, since each game has its own game_pk.
// Safe to re-run: it skips games already stored under (team_name, game_pk).
//
// Needs env vars SUPABASE_URL and SUPABASE_SERVICE_KEY (service_role) and the
// (team_name, game_pk) unique constraint to already exist. Node 18+.
// ───────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL || !KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY (service_role) first.');
  process.exit(1);
}
const db = createClient(URL, KEY, { auth: { persistSession: false } });

const START = process.argv[2] || '2026-03-01';
const END   = process.argv[3] || new Date().toISOString().slice(0, 10);
const API   = 'https://statsapi.mlb.com/api/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url) {
  for (let i = 0; i < 4; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch { /* retry */ }
    await sleep(500 * (i + 1));
  }
  throw new Error('fetch failed: ' + url);
}

function* eachDate(start, end) {
  const d = new Date(start + 'T00:00:00Z');
  const last = new Date(end + 'T00:00:00Z');
  while (d <= last) { yield d.toISOString().slice(0, 10); d.setUTCDate(d.getUTCDate() + 1); }
}

const statsCache = new Map();
async function pitcherStats(id, season) {
  if (!id) return { era: null, fip: null, ip: null, starts: null, wins: null, losses: null };
  if (statsCache.has(`${id}:${season}`)) return statsCache.get(`${id}:${season}`);
  let result = { era: null, fip: null, ip: null, starts: null, wins: null, losses: null };
  try {
    const data = await getJSON(`${API}/people/${id}/stats?stats=season&season=${season}&group=pitching`);
    const st = data?.stats?.[0]?.splits?.[0]?.stat || {};
    const era = parseFloat(st.era);
    const fip = parseFloat(st.fieldingIndependentPitching);
    const ip  = parseFloat(st.inningsPitched);
    result = {
      era:    (era && era < 90)  ? era  : null,
      fip:    (fip && fip < 90)  ? fip  : null,
      ip:     (ip  && ip  > 0)   ? ip   : null,
      starts: parseInt(st.gamesStarted)  || null,
      wins:   parseInt(st.wins)          || null,
      losses: parseInt(st.losses)        || null,
    };
  } catch { /* leave null */ }
  statsCache.set(`${id}:${season}`, result);
  return result;
}

// What's already in the table for the range:
//  - nullDates: "team|date" that have a row with NULL game_pk (claimable to stamp)
//  - pkSet:     "team|game_pk" already stored (skip)
async function loadExisting(start, end) {
  const nullDates = new Set();
  const pkSet = new Set();
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from('shared_lineup_baselines')
      .select('team_name,game_date,game_pk')
      .gte('game_date', start).lte('game_date', end)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    for (const r of data) {
      if (r.game_pk == null) nullDates.add(`${r.team_name}|${r.game_date}`);
      else pkSet.add(`${r.team_name}|${r.game_pk}`);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return { nullDates, pkSet };
}

async function processDate(date, state) {
  const season = date.slice(0, 4);
  let sched;
  try {
    sched = await getJSON(`${API}/schedule?sportId=1&date=${date}&hydrate=boxscore,probablePitcher,team&gameType=R`);
  } catch (e) { console.warn(`  ${date}: schedule fail ${e.message}`); return { stamped: 0, inserted: 0 }; }

  const games = (sched?.dates?.[0]?.games || [])
    .filter((g) => g.status?.abstractGameState === 'Final')
    .sort((a, b) => a.gamePk - b.gamePk); // game 1 before the nightcap

  let stamped = 0, inserted = 0;

  for (const g of games) {
    const gamePk = g.gamePk;
    const getName = (players, id) => players[`ID${id}`]?.person?.fullName || null;

    // Pre-extract hydrated boxscore data (may be partial; supplemented by direct fetch below)
    const boxHome = g.boxscore?.teams?.home || {};
    const boxAway = g.boxscore?.teams?.away || {};

    const sides = [
      { team: g.teams?.home?.team?.name, opp: g.teams?.away?.team?.name, side: 'home',
        probablePid: g.teams?.home?.probablePitcher?.id,
        pname: g.teams?.home?.probablePitcher?.fullName || null,
        actualPitchers: boxHome.pitchers || [] },
      { team: g.teams?.away?.team?.name, opp: g.teams?.home?.team?.name, side: 'away',
        probablePid: g.teams?.away?.probablePitcher?.id,
        pname: g.teams?.away?.probablePitcher?.fullName || null,
        actualPitchers: boxAway.pitchers || [] },
    ];

    let box = null; // lazy direct boxscore fetch, only if an insert needs it
    for (const s of sides) {
      if (!s.team) continue;
      const pkKey = `${s.team}|${gamePk}`;
      if (state.pkSet.has(pkKey)) continue; // already stored this exact game

      const ndKey = `${s.team}|${date}`;
      if (state.nullDates.has(ndKey)) {
        // STAMP the existing (null game_pk) row — keep its lineup/stats as-is
        const { error } = await db.from('shared_lineup_baselines')
          .update({ game_pk: gamePk })
          .match({ team_name: s.team, game_date: date })
          .is('game_pk', null);
        if (error) { console.error(`  stamp ${s.team} ${date}: ${error.message}`); }
        else { state.nullDates.delete(ndKey); state.pkSet.add(pkKey); stamped++; }
        continue;
      }

      // INSERT a missing game — need the batting order + actual starter
      let players = g.boxscore?.teams?.[s.side]?.players || {};
      let order   = g.boxscore?.teams?.[s.side]?.battingOrder || [];
      let actualPitchers = s.actualPitchers;
      if (order.length < 7) {
        if (box === null) { try { box = await getJSON(`${API}/game/${gamePk}/boxscore`); } catch { box = undefined; } }
        players = box?.teams?.[s.side]?.players || players;
        order   = box?.teams?.[s.side]?.battingOrder || order;
        actualPitchers = box?.teams?.[s.side]?.pitchers || actualPitchers;
      }
      const lineup = order.map((id) => getName(players, id)).filter(Boolean);
      if (lineup.length < 7) continue; // no usable order recorded

      // Use actual starter (first pitcher in boxscore) over probablePitcher
      const actualStarterId = actualPitchers[0] || null;
      const pid   = actualStarterId || s.probablePid;
      const pname = actualStarterId ? (getName(players, actualStarterId) || s.pname) : s.pname;

      const st = await pitcherStats(pid, season); await sleep(60);
      const { error } = await db.from('shared_lineup_baselines')
        .upsert({
          team_name: s.team, game_date: date, game_pk: gamePk,
          lineup, sp_name: pname,
          sp_era: st.era, sp_fip: st.fip, sp_ip: st.ip,
          sp_starts: st.starts, sp_wins: st.wins, sp_losses: st.losses,
          opp_team: s.opp,
        }, { onConflict: 'team_name,game_pk' });
      if (error) { console.error(`  insert ${s.team} ${date} pk${gamePk}: ${error.message}`); }
      else { state.pkSet.add(pkKey); inserted++; }
    }
    await sleep(80);
  }
  return { stamped, inserted };
}

(async () => {
  console.log(`Migrate + backfill ${START} → ${END}`);
  const state = await loadExisting(START, END);
  console.log(`Existing: ${state.pkSet.size} rows already have game_pk, ${state.nullDates.size} team-dates need stamping`);

  let S = 0, I = 0;
  for (const date of eachDate(START, END)) {
    const { stamped, inserted } = await processDate(date, state);
    if (stamped || inserted) console.log(`  ${date}: stamped ${stamped}, inserted ${inserted}`);
    S += stamped; I += inserted;
    await sleep(120);
  }
  console.log(`Done. Stamped ${S} existing rows, inserted ${I} missing games.`);
  process.exit(0);
})();
