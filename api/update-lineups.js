// api/update-lineups.js — Vercel Serverless Function
// Called nightly by Vercel Cron to store previous day's lineups
// into the shared_lineup_baselines table in Supabase.
// Also callable manually: GET /api/update-lineups?date=2026-04-15

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://pjbnsonfojyzbjjawpxu.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MLB_BASE = 'https://statsapi.mlb.com/api/v1';
const OPENING_DAY = '2026-03-25';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Verify cron secret to prevent unauthorized calls
  const authHeader = req.headers['authorization'];
  if (req.headers['x-vercel-cron'] !== '1' && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    // Allow unauthenticated for now during testing — add secret later
    // return res.status(401).json({ error: 'Unauthorized' });
  }

  // Determine date to process — default to yesterday
  const targetDate = req.query?.date || (() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  })();

  // Don't process pre-season dates
  if (targetDate < OPENING_DAY) {
    return res.status(200).json({ message: `Skipping pre-season date ${targetDate}` });
  }

  try {
    // Fetch schedule for target date (regular season only)
    const schedUrl = `${MLB_BASE}/schedule?sportId=1&date=${targetDate}&hydrate=probablePitcher,lineups&gameType=R`;
    const schedResp = await fetch(schedUrl, {
      headers: { 'User-Agent': 'ThePuntIndex/1.0', 'Accept': 'application/json' }
    });
    const schedData = await schedResp.json();
    const games = schedData?.dates?.[0]?.games || [];

    if (!games.length) {
      return res.status(200).json({ message: `No games on ${targetDate}`, stored: 0 });
    }

    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const rows = [];

    for (const game of games) {
      const gid = game.gamePk;
      const status = game.status?.abstractGameState;
      if (status !== 'Final' && status !== 'Live') continue;

      // Fetch boxscore for actual batting orders
      const boxResp = await fetch(`${MLB_BASE}/game/${gid}/boxscore`, {
        headers: { 'User-Agent': 'ThePuntIndex/1.0', 'Accept': 'application/json' }
      });
      const box = await boxResp.json();

      const extractLineup = (side) => {
        const team = box?.teams?.[side];
        const order = team?.battingOrder || [];
        const players = team?.players || {};
        return order.slice(0, 9).map(id => players[`ID${id}`]?.person?.fullName || '').filter(Boolean);
      };

      const homeTeam = game.teams.home.team.name;
      const awayTeam = game.teams.away.team.name;
      const homeSP = game.teams.home.probablePitcher?.fullName || null;
      const awaySP = game.teams.away.probablePitcher?.fullName || null;
      const homeLineup = extractLineup('home');
      const awayLineup = extractLineup('away');

      if (homeLineup.length >= 7) {
        rows.push({
          team_name: homeTeam,
          game_date: targetDate,
          lineup: homeLineup,
          sp_name: homeSP,
          opp_team: awayTeam,
        });
      }
      if (awayLineup.length >= 7) {
        rows.push({
          team_name: awayTeam,
          game_date: targetDate,
          lineup: awayLineup,
          sp_name: awaySP,
          opp_team: homeTeam,
        });
      }
    }

    if (rows.length) {
      const { error } = await db
        .from('shared_lineup_baselines')
        .upsert(rows, { onConflict: 'team_name,game_date' });
      if (error) throw error;
    }

    return res.status(200).json({
      message: `Processed ${targetDate}`,
      games: games.length,
      stored: rows.length,
    });

  } catch (err) {
    console.error('update-lineups error:', err);
    return res.status(500).json({ error: err.message });
  }
}
