/**
 * backfill-lineups.js
 * 
 * Fills ALL missing game data from Opening Day through yesterday.
 * Run this once to fix gaps in shared_lineup_baselines.
 * 
 * Usage:
 *   SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_KEY=your_key node backfill-lineups.js
 * 
 * Or set them in a .env file and run: node -r dotenv/config backfill-lineups.js
 * 
 * Requires: npm install @supabase/supabase-js node-fetch
 * (node-fetch only needed for Node < 18; Node 18+ has fetch built in)
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const MLB_API = 'https://statsapi.mlb.com/api/v1';
const OPENING_DAY = '2026-03-26'; // Update if needed
const SEASON = 2026;

// Rate limiting: wait between API calls to avoid 429s
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fetch with retry on 429/5xx
async function fetchWithRetry(url, retries = 3, delay = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status >= 500) {
        console.warn(`  ⚠️  HTTP ${res.status} — retrying in ${delay}ms...`);
        await sleep(delay * (i + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(delay * (i + 1));
    }
  }
}

// Get all dates between start and yesterday (inclusive)
function getDateRange(startDate) {
  const dates = [];
  const start = new Date(startDate + 'T12:00:00Z');
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  yesterday.setUTCHours(12, 0, 0, 0);

  let current = new Date(start);
  while (current <= yesterday) {
    dates.push(current.toISOString().split('T')[0]);
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

// Load what's already in Supabase so we don't re-insert
async function loadExistingRows() {
  console.log('📥 Loading existing rows from Supabase...');
  const existing = new Set();
  let from = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from('shared_lineup_baselines')
      .select('team_name, game_date')
      .gte('game_date', OPENING_DAY)
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`Supabase read error: ${error.message}`);
    if (!data || data.length === 0) break;

    data.forEach(row => existing.add(`${row.team_name}::${row.game_date}`));
    console.log(`  Loaded ${from + data.length} existing rows...`);

    if (data.length < pageSize) break;
    from += pageSize;
  }

  console.log(`✅ ${existing.size} existing (team, date) pairs loaded\n`);
  return existing;
}

// Get pitcher stats for a given person ID and season
async function fetchPitcherStats(personId) {
  try {
    const data = await fetchWithRetry(
      `${MLB_API}/people/${personId}/stats?stats=season&season=${SEASON}&group=pitching`
    );
    const stats = data?.stats?.[0]?.splits?.[0]?.stat || {};
    return {
      era: parseFloat(stats.era) || null,
      fip: null, // FIP not in basic stats — would need advanced endpoint
      starts: parseInt(stats.gamesStarted) || 0,
    };
  } catch {
    return { era: null, fip: null, starts: 0 };
  }
}

// Process a single game date
async function processDate(dateStr, existing) {
  const rows = [];

  // Fetch schedule with boxscore hydration
  let schedData;
  try {
    schedData = await fetchWithRetry(
      `${MLB_API}/schedule?sportId=1&date=${dateStr}&hydrate=boxscore,probablePitcher,team&gameType=R`
    );
  } catch (e) {
    console.warn(`  ⚠️  Could not fetch schedule for ${dateStr}: ${e.message}`);
    return rows;
  }

  const games = schedData?.dates?.[0]?.games || [];
  if (!games.length) return rows;

  for (const game of games) {
    // Only process Final games (completed)
    const abstractState = game.status?.abstractGameState;
    if (abstractState !== 'Final') continue;

    const homeTeamName = game.teams?.home?.team?.name;
    const awayTeamName = game.teams?.away?.team?.name;
    if (!homeTeamName || !awayTeamName) continue;

    // Extract batting orders from boxscore
    const boxscore = game.boxscore || game.liveData?.boxscore;
    
    // Try to get batting orders
    const homeBattingOrder = boxscore?.teams?.home?.battingOrder || [];
    const awayBattingOrder = boxscore?.teams?.away?.battingOrder || [];
    
    // Get player name map from boxscore
    const homePlayers = boxscore?.teams?.home?.players || {};
    const awayPlayers = boxscore?.teams?.away?.players || {};

    function getPlayerName(players, id) {
      const key = `ID${id}`;
      return players[key]?.person?.fullName || null;
    }

    const homeLineup = homeBattingOrder
      .map(id => getPlayerName(homePlayers, id))
      .filter(Boolean);
    const awayLineup = awayBattingOrder
      .map(id => getPlayerName(awayPlayers, id))
      .filter(Boolean);

    // If batting order not in hydrated schedule, fetch boxscore directly
    let homeLineupFinal = homeLineup;
    let awayLineupFinal = awayLineup;

    if (homeLineup.length < 7 || awayLineup.length < 7) {
      try {
        const boxData = await fetchWithRetry(
          `${MLB_API}/game/${game.gamePk}/boxscore`
        );
        const hPlayers = boxData?.teams?.home?.players || {};
        const aPlayers = boxData?.teams?.away?.players || {};
        const hOrder = boxData?.teams?.home?.battingOrder || [];
        const aOrder = boxData?.teams?.away?.battingOrder || [];

        if (hOrder.length >= 7) {
          homeLineupFinal = hOrder.map(id => getPlayerName(hPlayers, id)).filter(Boolean);
        }
        if (aOrder.length >= 7) {
          awayLineupFinal = aOrder.map(id => getPlayerName(aPlayers, id)).filter(Boolean);
        }
        await sleep(100); // be gentle
      } catch { /* use whatever we have */ }
    }

    // Get probable pitchers
    const homePitcherId = game.teams?.home?.probablePitcher?.id;
    const awayPitcherId = game.teams?.away?.probablePitcher?.id;
    const homePitcherName = game.teams?.home?.probablePitcher?.fullName;
    const awayPitcherName = game.teams?.away?.probablePitcher?.fullName;

    // Fetch pitcher stats if we have IDs
    let homeStats = { era: null, fip: null, starts: 0 };
    let awayStats = { era: null, fip: null, starts: 0 };

    if (homePitcherId) {
      homeStats = await fetchPitcherStats(homePitcherId);
      await sleep(80);
    }
    if (awayPitcherId) {
      awayStats = await fetchPitcherStats(awayPitcherId);
      await sleep(80);
    }

    // Build rows for home and away teams
    const homeKey = `${homeTeamName}::${dateStr}`;
    const awayKey = `${awayTeamName}::${dateStr}`;

    if (!existing.has(homeKey) && homeLineupFinal.length >= 7) {
      rows.push({
        team_name: homeTeamName,
        game_date: dateStr,
        lineup: homeLineupFinal,
        sp_name: homePitcherName || null,
        sp_era: homeStats.era,
        sp_fip: homeStats.fip,
        opp_team: awayTeamName,
      });
    }

    if (!existing.has(awayKey) && awayLineupFinal.length >= 7) {
      rows.push({
        team_name: awayTeamName,
        game_date: dateStr,
        lineup: awayLineupFinal,
        sp_name: awayPitcherName || null,
        sp_era: awayStats.era,
        sp_fip: awayStats.fip,
        opp_team: homeTeamName,
      });
    }
  }

  return rows;
}

// Upsert rows to Supabase in batches
async function upsertRows(rows) {
  if (!rows.length) return;
  const BATCH = 50;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supabase
      .from('shared_lineup_baselines')
      .upsert(batch, { onConflict: 'team_name,game_date' });
    if (error) {
      console.error(`  ❌ Upsert error:`, error.message);
    }
  }
}

async function main() {
  console.log('🏟️  Punt Index — Lineup Backfill Script');
  console.log(`📅 Date range: ${OPENING_DAY} through yesterday\n`);

  const existing = await loadExistingRows();
  const dates = getDateRange(OPENING_DAY);
  console.log(`📆 Processing ${dates.length} dates...\n`);

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalDates = 0;

  for (const dateStr of dates) {
    process.stdout.write(`${dateStr}: `);

    const rows = await processDate(dateStr, existing);
    const newRows = rows.filter(r => !existing.has(`${r.team_name}::${r.game_date}`));

    if (newRows.length === 0) {
      process.stdout.write(`skip (0 new)\n`);
      totalSkipped++;
    } else {
      await upsertRows(newRows);
      newRows.forEach(r => existing.add(`${r.team_name}::${r.game_date}`));
      process.stdout.write(`✅ inserted ${newRows.length} rows\n`);
      totalInserted += newRows.length;
    }

    totalDates++;
    await sleep(200); // ~5 dates/sec — well within API limits
  }

  console.log(`\n🎉 Done!`);
  console.log(`   Dates processed: ${totalDates}`);
  console.log(`   Rows inserted:   ${totalInserted}`);
  console.log(`   Dates skipped:   ${totalSkipped} (already had data)`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
