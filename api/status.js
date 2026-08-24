// GET /api/status - is there anything actually tradeable yet?
//
// Reports, per league, how many Kalshi game markets exist and how many carry a
// live quote. A market with no bid or ask cannot be traded at any price, so
// this is the difference between "the desk is ready" and "come back later".

const KB = 'https://api.elections.kalshi.com/trade-api/v2';
const SERIES = {
  nfl: 'KXNFLGAME', nba: 'KXNBAGAME', nhl: 'KXNHLGAME',
  ncaaf: 'KXNCAAFGAME', ncaab: 'KXNCAABGAME',
};

async function get(path) {
  const r = await fetch(`${KB}${path}`, { headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export default async function handler(req, res) {
  const out = {};

  await Promise.all(Object.entries(SERIES).map(async ([lg, series]) => {
    try {
      const j = await get(`/markets?series_ticker=${series}&status=open&limit=200`);
      const ms = j?.markets || [];
      const quoted = ms.filter((m) => m.yes_bid != null || m.yes_ask != null);
      const traded = ms.filter((m) => (m.volume || 0) > 0);
      const soonest = ms.map((m) => m.close_time).filter(Boolean).sort()[0] || null;
      out[lg] = {
        series,
        openMarkets: ms.length,
        quoted: quoted.length,
        withVolume: traded.length,
        totalVolume: ms.reduce((s, m) => s + (m.volume || 0), 0),
        soonestClose: soonest,
        tradeable: quoted.length > 0,
      };
    } catch (err) {
      out[lg] = { series, error: err.message, tradeable: false };
    }
  }));

  // A liquid non-sports market proves the price fields parse correctly, so a
  // wall of nulls above can be read as "not quoted yet", not "parser broken".
  try {
    const j = await get('/markets?status=open&limit=200&min_close_ts=0');
    const withQuotes = (j?.markets || []).filter((m) => m.yes_bid != null);
    out._parserCheck = {
      sampled: (j?.markets || []).length,
      quoted: withQuotes.length,
      example: withQuotes[0] ? {
        ticker: withQuotes[0].ticker, yes_bid: withQuotes[0].yes_bid,
        yes_ask: withQuotes[0].yes_ask, volume: withQuotes[0].volume } : null,
    };
  } catch { /* the per-league numbers are the point */ }

  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=900');
  res.status(200).json({ checkedAt: new Date().toISOString(), leagues: out });
}
