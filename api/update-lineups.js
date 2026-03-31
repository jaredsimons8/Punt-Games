// api/update-lineups.js — Vercel Serverless Function
// Runs nightly via Vercel Cron to store lineup data into shared_lineup_baselines.
// Also callable manually: GET /api/update-lineups?date=2026-04-15

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://pjbnsonfojyzbjjawpxu.supabase.co';
const MLB_BASE = 'https://statsapi.mlb.com/api/v1';
const OPENING_DAY = '2026-03-25';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Determine date to process — default to yesterday ET
  const targetDate = req.query && req.query.date
    ? req.query.date
    : (() => {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        return d.toISOString().split('T')[0];
      })();

  if (targetDate < OPENING_DAY) {
    return res.status(200).json({ message: `Skipping pre-season date ${targetDate}` });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not set in environment' });
  }

  try {
    const schedUrl = `${MLB_BASE}/schedule?sportId=1&date=${targetDate}&hydrate=probablePitcher,lineups&gameType=R`;
    const schedResp = await fetch(schedUrl, {
      headers: { 'User-Agent': 'ThePuntIndex/1.0', 'Accept': 'application/json' }
    });
    const schedData = await schedResp.json();
    const games = (schedData && schedData.dates && schedData.dates[0] && schedData.dates[0].games) || [];

    if (!games.length) {
      return res.status(200).json({ message: `No games on ${targetDate}`, stored: 0 });
    }

    const db = createClient(SUPABASE_URL, serviceKey);
    const rows = [];

    for (const game of games) {
      const gid = game.gamePk;
      const status = game.status && game.status.abstractGameState;
      if (status !== 'Final' && status !== 'Live') continue;

      const boxResp = await fetch(`${MLB_BASE}/game/${gid}/boxscore`, {
        headers: { 'User-Agent': 'ThePuntIndex/1.0', 'Accept': 'application/json' }
      });
      const box = await boxResp.json();

      const extractLineup = (side) => {
        const team = box && box.teams && box.teams[side];
        if (!team) return [];
        const order = team.battingOrder || [];
        const players = team.players || {};
        return order.slice(0, 9)
          .map(id => players['ID' + id] && players['ID' + id].person && players['ID' + id].person.fullName || '')
          .filter(Boolean);
      };

      const homeTeam = game.teams.home.team.name;
      const awayTeam = game.teams.away.team.name;
      const homeSP = (game.teams.home.probablePitcher && game.teams.home.probablePitcher.fullName) || null;
      const awaySP = (game.teams.away.probablePitcher && game.teams.away.probablePitcher.fullName) || null;
      const homeLineup = extractLineup('home');
      const awayLineup = extractLineup('away');

      if (homeLineup.length >= 7) {
        rows.push({ team_name: homeTeam, game_date: targetDate, lineup: homeLineup, sp_name: homeSP, opp_team: awayTeam });
      }
      if (awayLineup.length >= 7) {
        rows.push({ team_name: awayTeam, game_date: targetDate, lineup: awayLineup, sp_name: awaySP, opp_team: homeTeam });
      }
    }

    if (rows.length) {
      const { error } = await db
        .from('shared_lineup_baselines')
        .upsert(rows, { onConflict: 'team_name,game_date' });
      if (error) throw new Error(error.message);
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
};
