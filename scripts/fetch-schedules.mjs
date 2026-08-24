#!/usr/bin/env node
/**
 * Pulls full season schedules from ESPN's public scoreboard API and writes
 * normalized JSON into ./data, with every start time converted to Mountain time
 * and the broadcasting network attached to each game.
 *
 * Usage:
 *   node scripts/fetch-schedules.mjs                        # all leagues, default season windows
 *   node scripts/fetch-schedules.mjs --league nfl,nba        # subset
 *   node scripts/fetch-schedules.mjs --start 2026-11-01 --end 2026-11-30
 *   node scripts/fetch-schedules.mjs --tz-mode mst           # strict UTC-7, ignore DST
 *   node scripts/fetch-schedules.mjs --concurrency 4
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEAGUES, LEAGUE_IDS } from '../lib/leagues.mjs';
import { dateRange } from '../lib/time.mjs';
import { normalizeEvent } from '../lib/normalize.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'public', 'data');
const BASE = 'https://site.api.espn.com/apis/site/v2/sports';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { args[key] = next; i++; }
    else args[key] = true;
  }
  return args;
}

const args = parseArgs(process.argv);
const TZ_MODE = args['tz-mode'] === 'mst' ? 'mst' : 'denver';
const CONCURRENCY = Math.max(1, Number(args.concurrency) || 6);
const selected = args.league
  ? String(args.league).split(',').map((s) => s.trim()).filter((s) => LEAGUES[s])
  : LEAGUE_IDS;

if (selected.length === 0) {
  console.error(`No valid league selected. Choose from: ${LEAGUE_IDS.join(', ')}`);
  process.exit(1);
}

/** Fetch one URL with retry + backoff. Returns parsed JSON or null. */
async function getJSON(url, attempt = 1) {
  const MAX = 4;
  try {
    const res = await fetch(url, {
      // No User-Agent override: ESPN's edge blocks custom agents from
      // datacenter IPs, while the runtime default is accepted.
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (attempt >= MAX) {
      throw new Error(`${url} failed after ${MAX} attempts: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 2 ** attempt * 500));
    return getJSON(url, attempt + 1);
  }
}

/** Run tasks with a bounded worker pool, reporting progress as it goes. */
async function pool(items, limit, worker, onProgress) {
  const results = [];
  let index = 0;
  let done = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await worker(items[i], i);
      done++;
      onProgress?.(done, items.length);
    }
  });
  await Promise.all(runners);
  return results;
}

async function fetchLeague(leagueId) {
  const league = LEAGUES[leagueId];
  const start = args.start || league.start;
  const end = args.end || league.end;
  const days = dateRange(start, end);

  const extra = new URLSearchParams({ limit: '1000', ...league.query }).toString();
  console.log(`\n${league.name} — ${days.length} days (${start} to ${end})`);

  const games = new Map();
  let failures = 0;

  await pool(days, CONCURRENCY, async (day) => {
    const url = `${BASE}/${league.path}/scoreboard?dates=${day}&${extra}`;
    try {
      const json = await getJSON(url);
      for (const event of json?.events ?? []) {
        const game = normalizeEvent(event, league, TZ_MODE);
        if (game) games.set(game.id, game); // de-dupe across day boundaries
      }
    } catch (err) {
      failures++;
      if (failures <= 3) console.warn(`  ! ${day}: ${err.message}`);
    }
  }, (done, total) => {
    if (done % 25 === 0 || done === total) {
      process.stdout.write(`\r  fetched ${done}/${total} days — ${games.size} games`);
    }
  });

  process.stdout.write('\n');
  if (failures) console.warn(`  ${failures} day(s) failed to fetch`);

  const list = [...games.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.sortKey - b.sortKey,
  );

  const networkCounts = {};
  for (const g of list) {
    for (const n of g.networks.length ? g.networks : ['Unannounced']) {
      networkCounts[n] = (networkCounts[n] || 0) + 1;
    }
  }

  const payload = {
    league: league.id,
    name: league.name,
    longName: league.longName,
    season: league.season,
    timezone: TZ_MODE === 'mst' ? 'MST (UTC-7, fixed)' : 'America/Denver (MST/MDT)',
    generatedAt: new Date().toISOString(),
    range: { start, end },
    gameCount: list.length,
    withNetwork: list.filter((g) => g.networks.length > 0).length,
    networkCounts,
    games: list,
  };

  await writeFile(join(DATA_DIR, `${league.id}.json`), JSON.stringify(payload));
  console.log(`  wrote data/${league.id}.json — ${list.length} games, ` +
    `${payload.withNetwork} with a network listed`);
  return payload;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  console.log(`Timezone mode: ${TZ_MODE === 'mst' ? 'strict MST (UTC-7)' : 'Mountain local (MST/MDT)'}`);

  const summaries = [];
  for (const id of selected) {
    try {
      const payload = await fetchLeague(id);
      summaries.push({
        league: payload.league, name: payload.name, season: payload.season,
        gameCount: payload.gameCount, withNetwork: payload.withNetwork,
        range: payload.range,
      });
    } catch (err) {
      console.error(`\n${id}: ${err.message}`);
      summaries.push({ league: id, name: LEAGUES[id].name, error: err.message, gameCount: 0 });
    }
  }

  const index = {
    generatedAt: new Date().toISOString(),
    timezone: TZ_MODE === 'mst' ? 'MST (UTC-7, fixed)' : 'America/Denver (MST/MDT)',
    source: 'ESPN public scoreboard API',
    leagues: summaries,
    totalGames: summaries.reduce((n, s) => n + (s.gameCount || 0), 0),
  };
  await writeFile(join(DATA_DIR, 'index.json'), JSON.stringify(index, null, 2));

  console.log('\n' + '='.repeat(52));
  for (const s of summaries) {
    console.log(s.error
      ? `${s.name.padEnd(20)} FAILED — ${s.error.slice(0, 60)}`
      : `${s.name.padEnd(20)} ${String(s.gameCount).padStart(5)} games  (${s.withNetwork} w/ network)`);
  }
  console.log(`${'TOTAL'.padEnd(20)} ${String(index.totalGames).padStart(5)} games`);
  if (index.totalGames === 0) {
    console.error('\nNo games written. If every day failed, the ESPN API was unreachable ' +
      'from this machine (network/egress policy).');
    process.exit(2);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
