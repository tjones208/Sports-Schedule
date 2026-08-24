// GET /api/diagcfbd - is the College Football Data API usable from here?
//
// cfbfastR is an R wrapper over api.collegefootballdata.com. What matters for
// the backtest is not FPI (ESPN already gives per-game projections) but whether
// this API can supply historical BETTING LINES, which is the piece nothing else
// retains.
const B = 'https://api.collegefootballdata.com';
const J = async (u, key) => {
  try {
    const h = { Accept: 'application/json' };
    if (key) h.Authorization = `Bearer ${key}`;
    const r = await fetch(u, { headers: h, signal: AbortSignal.timeout(12000) });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, n: Array.isArray(j) ? j.length : null,
             keys: Array.isArray(j) && j[0] ? Object.keys(j[0]) : null,
             sample: Array.isArray(j) ? j[0] : undefined,
             snip: t.slice(0, 200) };
  } catch (e) { return { status: 'ERR', error: e.message }; }
};

export default async function handler(req, res) {
  const key = process.env.CFBD_API_KEY || req.query.key || '';
  const out = { hasKey: Boolean(key) };

  out.reachable = await J(`${B}/teams/fbs?year=2025`, key);
  out.lines = await J(`${B}/lines?year=2025&week=5&seasonType=regular`, key);
  out.fpiRatings = await J(`${B}/ratings/fpi?year=2025`, key);
  out.games = await J(`${B}/games?year=2025&week=5&division=fbs`, key);

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(out);
}
