// GET /api/diagq - what fields does the public Kalshi markets endpoint return?
const KB = 'https://api.elections.kalshi.com/trade-api/v2';
const g = async (path) => {
  const r = await fetch(`${KB}${path}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(9000) });
  return { status: r.status, json: await r.json().catch(() => null) };
};

export default async function handler(req, res) {
  const out = {};

  // A high-volume, long-running market should certainly have a book.
  const all = await g('/markets?status=open&limit=100');
  const ms = all.json?.markets || [];
  out.sampled = ms.length;
  out.allKeys = ms[0] ? Object.keys(ms[0]) : null;
  out.priceFieldsPresent = ms[0] ? Object.fromEntries(
    Object.entries(ms[0]).filter(([k]) => /price|bid|ask|volume|interest|liquid/i.test(k))) : null;

  // Highest-volume market in the sample, and whether anything has a quote
  const byVol = ms.slice().sort((a, b) => (b.volume || 0) - (a.volume || 0));
  out.topByVolume = byVol.slice(0, 3).map((m) => ({
    ticker: m.ticker, volume: m.volume, oi: m.open_interest,
    yes_bid: m.yes_bid, yes_ask: m.yes_ask, last_price: m.last_price,
    liquidity: m.liquidity, status: m.status,
  }));
  out.anyWithVolume = ms.filter((m) => (m.volume || 0) > 0).length;
  out.anyWithBid = ms.filter((m) => m.yes_bid != null && m.yes_bid !== 0).length;

  // Single-market fetch on a known liquid ticker, plus the orderbook endpoint
  const t = byVol[0]?.ticker;
  if (t) {
    const one = await g(`/markets/${encodeURIComponent(t)}`);
    out.singleMarket = { status: one.status, keys: one.json?.market ? Object.keys(one.json.market) : null,
      yes_bid: one.json?.market?.yes_bid, yes_ask: one.json?.market?.yes_ask,
      last_price: one.json?.market?.last_price, volume: one.json?.market?.volume };
    const ob = await g(`/markets/${encodeURIComponent(t)}/orderbook?depth=3`);
    out.orderbook = { status: ob.status, body: JSON.stringify(ob.json).slice(0, 300) };
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(out);
}
