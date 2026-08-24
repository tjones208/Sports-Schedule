// GET /api/diaghist - which status/window actually returns last season's markets?
const KB = 'https://api.elections.kalshi.com/trade-api/v2';
const J = async (u) => {
  try {
    const r = await fetch(u, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, json: j, snip: t.slice(0, 180) };
  } catch (e) { return { status: 'ERR', error: e.message }; }
};
// 2025 CFB season, roughly Aug 2025 - Jan 2026
const FROM = Math.floor(Date.parse('2025-08-01T00:00:00Z') / 1000);
const TO = Math.floor(Date.parse('2026-02-01T00:00:00Z') / 1000);

export default async function handler(req, res) {
  const out = {};

  for (const st of ['settled', 'finalized', 'closed', 'determined', 'active', '']) {
    const u = `${KB}/markets?series_ticker=KXNCAAFGAME&limit=50${st ? `&status=${st}` : ''}`;
    const r = await J(u);
    out[`status_${st || 'none'}`] = { http: r.status, n: r.json?.markets?.length ?? null,
      err: r.json?.error?.message || (r.status !== 200 ? r.snip : undefined) };
  }

  // Explicit close-time window over last season, with and without a status
  for (const [label, u] of Object.entries({
    window_nostatus: `${KB}/markets?series_ticker=KXNCAAFGAME&limit=50&min_close_ts=${FROM}&max_close_ts=${TO}`,
    window_settled: `${KB}/markets?series_ticker=KXNCAAFGAME&limit=50&status=settled&min_close_ts=${FROM}&max_close_ts=${TO}`,
    events_closed: `${KB}/events?series_ticker=KXNCAAFGAME&limit=50&status=closed`,
  })) {
    const r = await J(u);
    const ms = r.json?.markets || r.json?.events || [];
    out[label] = { http: r.status, n: ms.length,
      sample: ms.slice(0, 2).map((m) => m.ticker || m.event_ticker),
      snip: ms.length ? undefined : r.snip };
  }

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(out);
}
