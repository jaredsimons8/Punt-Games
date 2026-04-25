/**
 * collect-lineups.js
 * 
 * Runs daily via GitHub Actions (0 9 * * * = 5am ET).
 * Collects YESTERDAY'S completed game lineups and upserts to Supabase.
 * Also catches any games missed from the past 3 days (for postponements/makeup games).
 * 
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const MLB_API = 'https://statsapi.mlb.com/api/v1';
const SEASON = new Date().getFullYear();

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status >= 500) {
        await sleep(500 * Math.pow(2, i));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(500 * Math.pow(2, i));
    }
  }
}

// Get dates to process: yesterday + 2 days back (catches postponements/makeup games)
function getDatesToProcess() {
  const dates = [];
  for (let daysAgo = 1; daysAgo <= 3; daysAgo++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - daysAgo);
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

async function loadExistingForDates(dates) {
  const existing = new Set();
  const { data, error } = await supabase
    .from('shared_lineup_baselines')
    .select('team_name, game_date')
    .in('game_date', dates);

  if (error) throw new Error(`Supabase read error: ${error.message}`);
  (data || []).forEach(r => existing.add(`${r.team_name}::${r.game_date}`));
  return existing;
}

async function fetchPitcherStats(personId) {
  try {
    const data = await fetchWithRetry(
      `${MLB_API}/people/${personId}/stats?stats=season&season=${SEASON}&group=pitching`
    );
    const stats = data?.stats?.[0]?.splits?.[0]?.stat || {};
    return {
      era: parseFloat(stats.era) || null,
      fip: null,
      starts: parseInt(stats.gamesStarted) || 0,
    };
  } catch {
    return { era: null, fip: null, starts: 0 };
  }
}

async function processDate(dateStr, existing) {
  const rows = [];
  let schedData;

  try {
    schedData = await fetchWithRetry(
      `${MLB_API}/schedule?sportId=1&date=${dateStr}&hydrate=boxscore,probablePitcher,team&gameType=R`
    );
  } catch (e) {
    console.warn(`⚠️  Schedule fetch failed for ${dateStr}: ${e.message}`);
    return rows;
  }

  const games = schedData?.dates?.[0]?.games || [];

  for (const game of games) {
    if (game.status?.abstractGameState !== 'Final') continue;

    const homeTeam = game.teams?.home?.team?.name;
    const awayTeam = game.teams?.away?.team?.name;
    if (!homeTeam || !awayTeam) continue;

    // Skip if already stored
    const homeKey = `${homeTeam}::${dateStr}`;
    const awayKey = `${awayTeam}::${dateStr}`;
    const needHome = !existing.has(homeKey);
    const needAway = !existing.has(awayKey);
    if (!needHome && !needAway) continue;

    // Get batting orders — try hydrated first, then direct boxscore
    let homePlayers = game.boxscore?.teams?.home?.players || {};
    let awayPlayers = game.boxscore?.teams?.away?.players || {};
    let homeOrder = game.boxscore?.teams?.home?.battingOrder || [];
    let awayOrder = game.boxscore?.teams?.away?.battingOrder || [];

    if (homeOrder.length < 7 || awayOrder.length < 7) {
      try {
        const box = await fetchWithRetry(`${MLB_API}/game/${game.gamePk}/boxscore`);
        homePlayers = box?.teams?.home?.players || {};
        awayPlayers = box?.teams?.away?.players || {};
        homeOrder = box?.teams?.home?.battingOrder || [];
        awayOrder = box?.teams?.away?.battingOrder || [];
        await sleep(100);
      } catch { /* use what we have */ }
    }

    const getName = (players, id) => players[`ID${id}`]?.person?.fullName || null;
    const homeLineup = homeOrder.map(id => getName(homePlayers, id)).filter(Boolean);
    const awayLineup = awayOrder.map(id => getName(awayPlayers, id)).filter(Boolean);

    // Pitcher stats
    const homePitcherId = game.teams?.home?.probablePitcher?.id;
    const awayPitcherId = game.teams?.away?.probablePitcher?.id;
    const homePitcherName = game.teams?.home?.probablePitcher?.fullName || null;
    const awayPitcherName = game.teams?.away?.probablePitcher?.fullName || null;

    let homeStats = { era: null };
    let awayStats = { era: null };

    if (homePitcherId) { homeStats = await fetchPitcherStats(homePitcherId); await sleep(80); }
    if (awayPitcherId) { awayStats = await fetchPitcherStats(awayPitcherId); await sleep(80); }

    if (needHome && homeLineup.length >= 7) {
      rows.push({
        team_name: homeTeam,
        game_date: dateStr,
        lineup: homeLineup,
        sp_name: homePitcherName,
        sp_era: homeStats.era,
        sp_fip: null,
        opp_team: awayTeam,
      });
    }

    if (needAway && awayLineup.length >= 7) {
      rows.push({
        team_name: awayTeam,
        game_date: dateStr,
        lineup: awayLineup,
        sp_name: awayPitcherName,
        sp_era: awayStats.era,
        sp_fip: null,
        opp_team: homeTeam,
      });
    }
  }

  return rows;
}

async function main() {
  const dates = getDatesToProcess();
  console.log(`🏟️  Collecting lineups for: ${dates.join(', ')}`);

  const existing = await loadExistingForDates(dates);
  console.log(`📊 ${existing.size} entries already in DB for these dates\n`);

  let total = 0;

  for (const date of dates) {
    const rows = await processDate(date, existing);
    if (rows.length === 0) {
      console.log(`${date}: 0 new rows`);
      continue;
    }

    const { error } = await supabase
      .from('shared_lineup_baselines')
      .upsert(rows, { onConflict: 'team_name,game_date' });

    if (error) {
      console.error(`${date}: ❌ Upsert failed: ${error.message}`);
    } else {
      console.log(`${date}: ✅ ${rows.length} rows upserted`);
      total += rows.length;
    }

    await sleep(300);
  }

  console.log(`\n✅ Done — ${total} total rows written`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
