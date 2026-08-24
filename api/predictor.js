// GET /api/predictor?league=nfl&ids=401872925,401872926
//
// ESPN's FPI projection for specific games. This is a second opinion that is
// independent of the betting line, so agreement between the two raises
// confidence and disagreement is a reason to stand down.

import { LEAGUES } from '../lib/leagues.mjs';

const CORE = 'https://sports.core.api.espn.com/v2/sports';

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

const statVal = (stats, name) => {
  const s = (stats || []).find((x) => (x.name || '').toLowerCase() === name.toLowerCase());
  return typeof s?.value === 'number' ? s.value : null;
};

async function forEvent(path, id) {
  const j = await getJSON(`${CORE}/${path}/events/${id}/competitions/${id}/predictor`);
  const home = statVal(j?.homeTeam?.statistics, 'gameProjection');
  const away = statVal(j?.awayTeam?.statistics, 'gameProjection');
  if (home == null && away == null) return null;

  return {
    id,
    homeWin: home == null ? null : home / 100,
    awayWin: away == null ? null : away / 100,
    tie: statVal(j?.homeTeam?.statistics, 'teamChanceTie'),
    // positive means the home team is projected to win by this many points
    predPointDiff: statVal(j?.homeTeam?.statistics, 'teamPredPtDiff'),
    matchupQuality: statVal(j?.homeTeam?.statistics, 'matchupQuality'),
  };
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
    try { return await forEvent(path, id); } catch { return null; }
  });

  const found = results.filter(Boolean);
  res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
  res.status(200).json({
    league,
    source: 'ESPN FPI matchup predictor',
    requested: list.length,
    returned: found.length,
    predictions: Object.fromEntries(found.map((p) => [p.id, p])),
  });
}
