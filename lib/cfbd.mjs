// College Football Data (api.collegefootballdata.com) - historical betting lines.
//
// This is the piece nothing else retains. ESPN drops odds from completed games
// and Kalshi does not expose last season's markets at all, so without a source
// of historical lines a backtest has no entry price to bet against.
//
// Requires a free API key in CFBD_API_KEY. Reachable from the deployment;
// unauthenticated calls return 401.

const BASE = 'https://api.collegefootballdata.com';

/** Normalise a school name so ESPN and CFBD spellings meet in the middle. */
export function normalizeTeam(name) {
  return String(name || '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^THE/, '')
    .replace(/STATE$/, 'ST')
    .replace(/UNIVERSITY/, '');
}

async function get(path, key) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20000),
  });
  if (r.status === 401) throw new Error('CFBD rejected the API key (401)');
  if (!r.ok) throw new Error(`CFBD HTTP ${r.status}`);
  return r.json();
}

/**
 * Consensus closing line per game for a season.
 * @returns {Promise<Map<string, {spread:number|null, homeML:number|null, awayML:number|null, books:number, home:string, away:string, week:number}>>}
 *          keyed by `${normalizedAway}|${normalizedHome}`
 */
export async function getSeasonLines(season, key, seasonType = 'regular') {
  const rows = await get(`/lines?year=${season}&seasonType=${seasonType}`, key);
  const out = new Map();

  for (const g of rows || []) {
    const lines = Array.isArray(g.lines) ? g.lines : [];
    if (!lines.length) continue;

    // Average across books; a single book's number can be stale or an outlier.
    const nums = (pick) => lines.map(pick).map(Number).filter(Number.isFinite);
    const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

    const spreads = nums((l) => l.spread);
    const homeMLs = nums((l) => l.homeMoneyline);
    const awayMLs = nums((l) => l.awayMoneyline);

    const key2 = `${normalizeTeam(g.awayTeam)}|${normalizeTeam(g.homeTeam)}`;
    out.set(key2, {
      // CFBD states the spread from the home team's perspective, same as ESPN.
      spread: mean(spreads),
      homeML: homeMLs.length ? Math.round(mean(homeMLs)) : null,
      awayML: awayMLs.length ? Math.round(mean(awayMLs)) : null,
      books: lines.length,
      home: g.homeTeam, away: g.awayTeam, week: g.week,
    });
  }
  return out;
}

/** Both season types merged, since bowls and the playoff sit in "postseason". */
export async function getSeasonLinesAll(season, key) {
  const [reg, post] = await Promise.all([
    getSeasonLines(season, key, 'regular').catch(() => new Map()),
    getSeasonLines(season, key, 'postseason').catch(() => new Map()),
  ]);
  for (const [k, v] of post) if (!reg.has(k)) reg.set(k, v);
  return reg;
}
