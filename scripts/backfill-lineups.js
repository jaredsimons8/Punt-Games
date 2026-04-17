#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// The Punt Index — Season Backfill Script
// Run ONCE manually to load all completed games from opening
// day through today. After that, collect-lineups.js handles
// the daily updates automatically.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/backfill-lineups.js
//
// Optional: override start date
//   START_DATE=2026-03-26 node scripts/backfill-lineups.js
// ═══════════════════════════════════════════════════════════════

const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MLB_BASE     = 'https://statsapi.mlb.com/api/v1';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars');
  process.exit(1);
}

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'PuntIndex-Backfill/1.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

async function supabaseUpsert(rows) {
  const body = JSON.stringify(rows);
  return new Promise((resolve, reject) => {
    const url = new URL(`${SUPABASE_URL}/rest/v1/shared_lineup_baselines`);
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'resolution=merge-duplicates',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(url, options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode });
        else reject(new Error(`Supabase ${res.statusCode}: ${data.slice(0, 300)}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function extractLineup(boxscore, side) {
  const team = boxscore?.teams?.[side];
  if (!team) return [];
  const battingOrder = team.battingOrder || [];
  const players = team.players || {};
  return battingOrder
    .map(id => players[`ID${id}`]?.person?.fullName)
    .filter(Boolean);
}

async function fetchPitcherStats(pitcherId, year) {
  if (!pitcherId) return { era: null, fip: null };
  try {
    const data = await get(`${MLB_BASE}/people/${pitcherId}/stats?stats=season&group=pitching&season=${year}`);
    const stat = data?.stats?.[0]?.splits?.[0]?.stat || {};
    const era = parseFloat(stat.era);
    const fip = parseFloat(stat.fieldingIndependentPitching);
    return {
      era: (era && era < 90) ? +era.toFixed(2) : null,
      fip: (fip && fip < 90) ? +fip.toFixed(2) : null,
    };
  } catch { return { era: null, fip: null }; }
}

// Generate array of date strings from start to today
function dateRange(start, end) {
  const dates = [];
  const cur = new Date(start + 'T12:00:00Z');
  const last = new Date(end + 'T12:00:00Z');
  while (cur <= last) {
    dates.push(cur.toISOString().split('T')[0]);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

async function processDate(dateStr, year) {
  let schedule;
  try {
    schedule = await get(
      `${MLB_BASE}/schedule?sportId=1&date=${dateStr}&hydrate=probablePitcher,team&gameType=R`
    );
  } catch(e) {
    console.warn(`  ✗ Schedule fetch failed for ${dateStr}: ${e.message}`);
    return 0;
  }

  const games = schedule?.dates?.[0]?.games || [];
  const completed = games.filter(g => g.status?.abstractGameState === 'Final');

  if (!completed.length) return 0;

  const rows = [];

  for (const game of completed) {
    const gid = game.gamePk;
    const homeTeam = game.teams?.home?.team?.name;
    const awayTeam = game.teams?.away?.team?.name;
    const homePitcher = game.teams?.home?.probablePitcher;
    const awayPitcher = game.teams?.away?.probablePitcher;

    let boxscore;
    try {
      boxscore = await get(`${MLB_BASE}/game/${gid}/boxscore`);
    } catch { continue; }

    const homeLineup = extractLineup(boxscore, 'home');
    const awayLineup = extractLineup(boxscore, 'away');

    const [homeStats, awayStats] = await Promise.all([
      fetchPitcherStats(homePitcher?.id, year),
      fetchPitcherStats(awayPitcher?.id, year),
    ]);

    if (homeLineup.length >= 7) {
      rows.push({
        team_name: homeTeam, game_date: dateStr,
        lineup: homeLineup,
        sp_name: homePitcher?.fullName || null,
        sp_fip: homeStats.fip, sp_era: homeStats.era,
        opp_team: awayTeam,
      });
    }
    if (awayLineup.length >= 7) {
      rows.push({
        team_name: awayTeam, game_date: dateStr,
        lineup: awayLineup,
        sp_name: awayPitcher?.fullName || null,
        sp_fip: awayStats.fip, sp_era: awayStats.era,
        opp_team: homeTeam,
      });
    }

    await new Promise(r => setTimeout(r, 120));
  }

  if (!rows.length) return 0;

  try {
    await supabaseUpsert(rows);
    console.log(`  ✓ ${dateStr}: ${rows.length} entries (${completed.length} games)`);
    return rows.length;
  } catch(e) {
    console.error(`  ✗ ${dateStr}: Supabase failed — ${e.message}`);
    return 0;
  }
}

async function main() {
  const year = new Date().getFullYear();
  const today = new Date().toISOString().split('T')[0];
  const start = process.env.START_DATE || `${year}-03-20`;

  console.log(`\nPunt Index Backfill — ${start} → ${today}`);
  console.log(`Supabase: ${SUPABASE_URL}`);
  console.log('─'.repeat(50));

  const dates = dateRange(start, today);
  console.log(`Processing ${dates.length} dates...\n`);

  let total = 0;
  for (const d of dates) {
    total += await processDate(d, year);
    // Slightly longer delay between dates to be polite to MLB API
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('\n' + '─'.repeat(50));
  console.log(`Backfill complete. ${total} lineup entries written to Supabase.`);
  console.log('Visit the site — calibration progress will now show correctly.');
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
