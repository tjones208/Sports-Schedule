// GET /api/predictor?league=nfl&ids=401872925,401872926
//
// ESPN's own pregame projection for specific games - FPI for football, BPI for
// basketball. This is a second opinion independent of the betting line, so
// agreement between the two raises confidence and disagreement is a reason to
// stand down.
//
// Two ESPN endpoints carry this number in different shapes and coverage differs
// by sport, so lib/projection.mjs tries both and reports which one answered.

import { LEAGUES } from '../lib/leagues.mjs';
import { fetchProjection } from '../lib/projection.mjs';

// core API paths differ from the site API paths used elsewhere
const CORE_PATH = {
  nfl: 'football/leagues/nfl',
  nba: 'basketball/leagues/nba',
  nhl: 'hockey/leagues/nhl',
  ncaaf: 'football/leagues/college-football',
  ncaab: 'basketball/leagues/mens-college-basketball',
};

async function getJSON(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function pool(items, limit, worker) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await worker(items[k]); }
  }));
  return out;
}

export default async function handler(req, res) {
  const { league, ids } = req.query;
  const path = CORE_PATH[league];

  if (!path || !LEAGUES[league]) {
    res.status(400).json({ error: 'Unknown league', valid: Object.keys(CORE_PATH) });
    return;
  }
  if (!ids) {
    res.status(400).json({ error: 'Pass ?ids=espnEventId,espnEventId' });
    return;
  }

  // Strip any "nfl-" prefix the app adds to its own game ids.
  const list = String(ids).split(',')
    .map((s) => s.trim().replace(/^[a-z]+-/, ''))
    .filter((s) => /^\d+$/.test(s))
    .slice(0, 60);

  if (!list.length) {
    res.status(400).json({ error: 'No valid event ids' });
    return;
  }

  const results = await pool(list, 6, async (id) => {
    try {
      const p = await fetchProjection({
        sitePath: LEAGUES[league].path, corePath: path, id, fetchJSON: getJSON,
      });
      return p.homeWin == null && p.awayWin == null ? null : p;
    } catch { return null; }
  });

  const found = results.filter(Boolean);
  res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
  res.status(200).json({
    league,
    source: 'ESPN FPI matchup predictor',
    requested: list.length,
    returned: found.length,
    // Which endpoint answered, and under what field name. A sport served by
    // only one of the two shows up here rather than as a silently empty tab.
    sources: [...new Set(found.map((p) => p.source).filter(Boolean))],
    statsUsed: [...new Set(found.map((p) => p.stat).filter(Boolean))],
    predictions: Object.fromEntries(found.map((p) => [p.id, p])),
  });
}
