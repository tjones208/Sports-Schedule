// GET /api/diag3 - detail probe of ESPN's predictor + FPI shapes.
const CORE = 'https://sports.core.api.espn.com/v2/sports';
const J = async (u) => {
  try { const r = await fetch(u, { signal: AbortSignal.timeout(9000) });
    return { status: r.status, json: await r.json().catch(() => null) }; }
  catch (e) { return { status: 'ERR', error: e.message }; }
};

export default async function handler(req, res) {
  const id = req.query.id || '401872925';
  const lg = req.query.lg || 'football/leagues/nfl';
  const out = {};

  const pred = await J(`${CORE}/${lg}/events/${id}/competitions/${id}/predictor`);
  const ht = pred.json?.homeTeam, at = pred.json?.awayTeam;
  out.predictor = {
    status: pred.status,
    name: pred.json?.name,
    homeStats: (ht?.statistics || []).map((s) => ({ n: s.name, v: s.value, d: s.displayValue })),
    awayStats: (at?.statistics || []).map((s) => ({ n: s.name, v: s.value })),
  };

  // Team FPI ratings for the two sides
  const pow = await J(`${CORE}/${lg}/events/${id}/competitions/${id}/powerindex`);
  out.powerindexItems = [];
  for (const it of (pow.json?.items || []).slice(0, 2)) {
    const d = await J(it.$ref.replace('http://', 'https://'));
    out.powerindexItems.push({
      team: d.json?.team?.$ref?.split('/').pop()?.split('?')[0],
      stats: (d.json?.stats || []).slice(0, 10).map((s) => ({ n: s.name, v: s.value })),
    });
  }

  // Core-API standings (the site endpoint returns only a link)
  const st = await J(`${CORE}/${lg}/seasons/2025/types/2/standings/0`);
  out.standings = { status: st.status, keys: st.json ? Object.keys(st.json) : null,
    n: st.json?.standings?.length };

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(out);
}
