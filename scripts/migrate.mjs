/**
 * migrate.mjs
 *
 * Runs pending SQL migrations against the Supabase project via the
 * Management API. Uses a personal access token (not the service key)
 * because DDL execution goes through api.supabase.com, not the project API.
 *
 * Setup (one-time):
 *   1. Copy scripts/.env.local.example → scripts/.env.local
 *   2. Add your SUPABASE_ACCESS_TOKEN (supabase.com/dashboard/account/tokens)
 *
 * Usage:
 *   node scripts/migrate.mjs
 *   node scripts/migrate.mjs --dry-run    # print SQL without executing
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Load .env.local ──────────────────────────────────────────
function loadEnv() {
  const envPath = join(__dir, '.env.local');
  try {
    const lines = readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx < 0) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (key && val && !process.env[key]) process.env[key] = val;
    }
  } catch {
    console.error('❌  scripts/.env.local not found.');
    console.error('    Copy scripts/.env.local.example → scripts/.env.local and fill in your token.');
    process.exit(1);
  }
}

loadEnv();

const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pjbnsonfojyzbjjawpxu.supabase.co';
const PROJECT_REF  = SUPABASE_URL.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
const DRY_RUN      = process.argv.includes('--dry-run');

if (!ACCESS_TOKEN) {
  console.error('❌  SUPABASE_ACCESS_TOKEN missing in scripts/.env.local');
  console.error('    Get one at: supabase.com/dashboard/account/tokens');
  process.exit(1);
}

// ── MIGRATIONS ───────────────────────────────────────────────
// Add new migrations here as an object with a name and sql field.
// Each migration is idempotent (IF NOT EXISTS / OR REPLACE).
// Order matters — migrations run top-to-bottom.
const MIGRATIONS = [
  {
    name: 'add_sp_fip_column',
    sql: `alter table shared_lineup_baselines add column if not exists sp_fip numeric(5,2);`,
  },
  {
    name: 'add_sp_ip_column',
    sql: `alter table shared_lineup_baselines add column if not exists sp_ip numeric(5,1);`,
  },
  {
    name: 'add_sp_starts_column',
    sql: `alter table shared_lineup_baselines add column if not exists sp_starts integer;`,
  },
  {
    name: 'add_sp_wins_column',
    sql: `alter table shared_lineup_baselines add column if not exists sp_wins integer;`,
  },
  {
    name: 'add_sp_losses_column',
    sql: `alter table shared_lineup_baselines add column if not exists sp_losses integer;`,
  },
  {
    name: 'public_read_admin_game_log',
    sql: `
      drop policy if exists "Public read of admin game log" on game_log;
      create policy "Public read of admin game log"
        on game_log for select
        to public
        using (user_id = '0442f84a-5fc9-4c1e-a2e7-9c50c0fd8568');
    `,
  },
  {
    name: 'public_read_admin_preferences',
    sql: `
      drop policy if exists "Public read of admin preferences" on user_preferences;
      create policy "Public read of admin preferences"
        on user_preferences for select
        to public
        using (user_id = '0442f84a-5fc9-4c1e-a2e7-9c50c0fd8568');
    `,
  },
];

// ── RUN SQL VIA MANAGEMENT API ───────────────────────────────
async function runSQL(sql, label) {
  const url = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return await res.json();
}

// ── MAIN ─────────────────────────────────────────────────────
(async () => {
  console.log(`\n🗄️  Supabase migrations — project: ${PROJECT_REF}${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

  let passed = 0, failed = 0;
  for (const m of MIGRATIONS) {
    process.stdout.write(`  ${m.name} … `);
    if (DRY_RUN) {
      console.log('(skipped — dry run)');
      console.log(`    SQL: ${m.sql}`);
      continue;
    }
    try {
      await runSQL(m.sql, m.name);
      console.log('✅');
      passed++;
    } catch (e) {
      console.log(`❌  ${e.message}`);
      failed++;
    }
  }

  console.log(`\n${DRY_RUN ? '(dry run)' : `Done — ${passed} ok, ${failed} failed`}\n`);
  if (failed) process.exit(1);
})();
