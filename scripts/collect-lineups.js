/**
 * collect-lineups.js
 *
 * Runs daily via GitHub Actions (0 9 * * * = 5am ET).
 * Collects YESTERDAY'S completed game lineups and upserts to Supabase.
 * Also catches any games missed from the past 3 days (for postponements/makeup games).
 *
 * One row per GAME (keyed on team_name + game_pk) so both halves of a
 * doubleheader are stored.
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

// Keyed on team_name + game_pk so doubleheaders aren't collapsed.
async function loadExistingForDates(dates) {
  const existing = new Set();
  const { data, error } = await supabase
    .from('shared_lineup_baselines')
    .select('team_name, game_pk')
    .in('game_date', dates);

  if (error) throw new Error(`Supabase read error: ${error.message}`);
  (data || []).forEach(r => { if (r.game_pk != null) existing.add(`${r.team_name}::${r.game_pk}`); });
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

    const gamePk = game.gamePk;
    const homeTeam = game.teams?.home?.team?.name;
    const awayTeam = game.teams?.away?.team?.name;
    if (!homeTeam || !awayTeam || !gamePk) continue;

    // Skip if this exact game (per team) is already stored
    const homeKey = `${homeTeam}::${gamePk}`;
    const awayKey = `${awayTeam}::${gamePk}`;
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
        const box = await fetchWithRetry(`${MLB_API}/game/${gamePk}/boxscore`);
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
