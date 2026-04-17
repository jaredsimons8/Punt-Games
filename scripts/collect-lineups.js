#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// The Punt Index — Daily Lineup Collector
// Runs via GitHub Actions every morning at 6am ET.
// Fetches completed games from the MLB Stats API,
// extracts batting orders + pitcher stats, and upserts
// to the shared_lineup_baselines Supabase table.
//
// This is the ONLY writer to shared_lineup_baselines.
// The frontend only reads from it — no user action required.
// ═══════════════════════════════════════════════════════════════

const https = require('https');

// ── CONFIG ───────────────────────────────────────────────────
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY; // service role — bypasses RLS
const MLB_BASE      = 'https://statsapi.mlb.com/api/v1';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars');
  process.exit(1);
}

// ── HELPERS ──────────────────────────────────────────────────
function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'PuntIndex/1.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error(`JSON parse error for ${url}: ${e.message}`)); }
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
        'Prefer': 'resolution=merge-duplicates', // upsert on conflict
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(url, options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, status: res.statusCode });
        } else {
          reject(new Error(`Supabase ${res.statusCode}: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── EXTRACT BATTING ORDER ────────────────────────────────────
function extractLineup(boxscore, side) {
  const team = boxscore?.teams?.[side];
  if (!team) return [];
  // battingOrder is an array of player IDs in order
  const battingOrder = team.battingOrder || [];
  const players = team.players || {};
  return battingOrder
    .map(id => players[`ID${id}`]?.person?.fullName)
    .filter(Boolean);
}

// ── FETCH PITCHER STATS ──────────────────────────────────────
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

// ── MAIN ─────────────────────────────────────────────────────
async function main() {
  const year = new Date().getFullYear();

  // Collect yesterday + today (catches late games finishing after midnight)
  const dates = [];
  for (let d = 1; d >= 0; d--) {
    const dt = new Date();
    dt.setDate(dt.getDate() - d);
    dates.push(dt.toISOString().split('T')[0]);
  }

  console.log(`Collecting lineup data for: ${dates.join(', ')}`);

  let totalUpserted = 0;

  for (const dateStr of dates) {
    let schedule;
    try {
      schedule = await get(
        `${MLB_BASE}/schedule?sportId=1&date=${dateStr}&hydrate=probablePitcher,team,game(doubleHeader,gameNumber)&gameType=R`
      );
    } catch(e) {
      console.warn(`Schedule fetch failed for ${dateStr}:`, e.message);
      continue;
    }

    const games = schedule?.dates?.[0]?.games || [];
    const completedGames = games.filter(g => g.status?.abstractGameState === 'Final');

    console.log(`  ${dateStr}: ${games.length} games scheduled, ${completedGames.length} completed`);

    const rows = [];

    for (const game of completedGames) {
      const gid = game.gamePk;
      const homeTeamName = game.teams?.home?.team?.name;
      const awayTeamName = game.teams?.away?.team?.name;
      const homePitcher = game.teams?.home?.probablePitcher;
      const awayPitcher = game.teams?.away?.probablePitcher;

      // Fetch boxscore for batting orders
      let boxscore;
      try {
        boxscore = await get(`${MLB_BASE}/game/${gid}/boxscore`);
      } catch(e) {
        console.warn(`  Boxscore failed for game ${gid}:`, e.message);
        continue;
      }

      const homeLineup = extractLineup(boxscore, 'home');
      const awayLineup = extractLineup(boxscore, 'away');

      // Fetch pitcher stats in parallel
      const [homeSpStats, awaySpStats] = await Promise.all([
        fetchPitcherStats(homePitcher?.id, year),
        fetchPitcherStats(awayPitcher?.id, year),
      ]);

      if (homeLineup.length >= 7) {
        rows.push({
          team_name: homeTeamName,
          game_date: dateStr,
          lineup: homeLineup,
          sp_name: homePitcher?.fullName || null,
          sp_fip: homeSpStats.fip,
          sp_era: homeSpStats.era,
          opp_team: awayTeamName,
        });
      }

      if (awayLineup.length >= 7) {
        rows.push({
          team_name: awayTeamName,
          game_date: dateStr,
          lineup: awayLineup,
          sp_name: awayPitcher?.fullName || null,
          sp_fip: awaySpStats.fip,
          sp_era: awaySpStats.era,
          opp_team: homeTeamName,
        });
      }

      // Small delay to avoid hammering the MLB API
      await new Promise(r => setTimeout(r, 150));
    }

    if (rows.length > 0) {
      try {
        await supabaseUpsert(rows);
        console.log(`  ✓ Upserted ${rows.length} lineup entries for ${dateStr}`);
        totalUpserted += rows.length;
      } catch(e) {
        console.error(`  ✗ Supabase upsert failed for ${dateStr}:`, e.message);
      }
    }
  }

  console.log(`\nDone. Total upserted: ${totalUpserted} entries.`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
