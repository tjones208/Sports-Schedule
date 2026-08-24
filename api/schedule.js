// GET /api/schedule?league=nfl[&start=YYYY-MM-DD][&end=YYYY-MM-DD][&tz=mst][&debug=1]
//
// Runs on Vercel, so it reaches ESPN directly and returns normalized games with
// Mountain-time start times and broadcast networks. Responses are cached at the
// edge, so ESPN sees roughly one request per league per cache window.

import { LEAGUES, LEAGUE_IDS } from '../lib/leagues.mjs';
import { normalizeEvent } from '../lib/normalize.mjs';
import { dateRange } from '../lib/time.mjs';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const CHUNK_DAYS = 30;      // days per ESPN range request
const CONCURRENCY = 6;
const FETCH_TIMEOUT = 12_000;

const compact = (d) => d.replace(/-/g, '');

async function getJSON(url, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'sports-schedule/1.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === attempts) throw err;
      await new Promise((r) => setTimeout(r, 300 * 2 ** i));
    }
  }
  return null;
}

async function pool(items, limit, worker) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx]);
    }
  }));
  return out;
}

/** Split a date span into ESPN range windows (ESPN accepts dates=YYYYMMDD-YYYYMMDD). */
function windows(start, end, size) {
  const days = dateRange(start, end);
  const out = [];
  for (let i = 0; i < days.length; i += size) {
    const slice = days.slice(i, i + size);
    out.push(`${slice[0]}-${slice[slice.length - 1]}`);
  }
  return out;
}

// Only what the board actually renders - keeps big leagues under the response limit.
function slim(g) {
  return {
    id: g.id, league: g.league, date: g.date, time: g.time, tz: g.tz,
    weekday: g.weekday, sortKey: g.sortKey, timeTBD: g.timeTBD,
    startUTC: g.startUTC, networks: g.networks, national: g.national,
    week: g.week, neutralSite: g.neutralSite, notes: g.notes,
    venue: g.venue,
    home: { name: g.home.name, short: g.home.short, abbrev: g.home.abbrev, rank: g.home.rank },
    away: { name: g.away.name, short: g.away.short, abbrev: g.away.abbrev, rank: g.away.rank },
  };
}

export default async function handler(req, res) {
  const { league: leagueId, start, end, tz, debug } = req.query;
  const league = LEAGUES[leagueId];

  if (!league) {
    res.status(400).json({ error: 'Unknown league', valid: LEAGUE_IDS });
    return;
  }

  const from = /^\d{4}-\d{2}-\d{2}$/.test(start || '') ? start : league.start;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(end || '') ? end : league.end;
  if (from > to) {
    res.status(400).json({ error: 'start must be on or before end' });
    return;
  }

  const tzMode = tz === 'mst' ? 'mst' : 'denver';
  const extra = new URLSearchParams({ limit: '1000', ...league.query }).toString();
  const started = Date.now();
  const games = new Map();
  const errors = [];
  let requests = 0;

  const collect = (json) => {
    for (const event of json?.events ?? []) {
      const g = normalizeEvent(event, league, tzMode);
      if (g) games.set(g.id, slim(g));
    }
  };

  // One request per 30-day window. If ESPN ignores the range form we fall back
  // to day-by-day for that window only.
  const spans = windows(from, to, CHUNK_DAYS);
  await pool(spans, CONCURRENCY, async (span) => {
    try {
      requests++;
      const json = await getJSON(`${BASE}/${league.path}/scoreboard?dates=${span}&${extra}`);
      if (json?.events?.length) { collect(json); return; }

      const [s, e] = span.split('-');
      const days = dateRange(
        `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`,
        `${e.slice(0, 4)}-${e.slice(4, 6)}-${e.slice(6)}`,
      );
      await pool(days, CONCURRENCY, async (day) => {
        try {
          requests++;
          collect(await getJSON(`${BASE}/${league.path}/scoreboard?dates=${day}&${extra}`));
        } catch (err) { errors.push(`${day}: ${err.message}`); }
      });
    } catch (err) {
      errors.push(`${span}: ${err.message}`);
    }
  });

  const list = [...games.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.sortKey - b.sortKey,
  );

  if (list.length === 0) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({
      error: 'No games returned from the upstream schedule API',
      league: league.id, range: { start: from, end: to }, errors: errors.slice(0, 5),
    });
    return;
  }

  res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
  res.status(200).json({
    league: league.id,
    name: league.name,
    longName: league.longName,
    season: league.season,
    timezone: tzMode === 'mst' ? 'MST (UTC-7, fixed)' : 'America/Denver (MST/MDT)',
    range: { start: from, end: to },
    generatedAt: new Date().toISOString(),
    gameCount: list.length,
    withNetwork: list.filter((g) => g.networks.length > 0).length,
    games: list,
    ...(debug ? { debug: { requests, ms: Date.now() - started, errors: errors.slice(0, 10) } } : {}),
  });
}
