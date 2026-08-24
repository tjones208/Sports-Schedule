// GET /api/diag2 - discovers Kalshi sports series and one sample game market.
const KB = 'https://api.elections.kalshi.com/trade-api/v2';
const J = async (u) => {
  const r = await fetch(u, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  return { status: r.status, json: await r.json().catch(() => null) };
};

export default async function handler(req, res) {
  const out = {};
  const want = /NFL|NBA|NHL|NCAAF|NCAAB|CBB|CFB|SUPERBOWL|MARCHMAD/i;

  const s = await J(`${KB}/series?category=Sports`);
  const all = s.json?.series || [];
  out.totalSeries = all.length;
  out.matching = all
    .filter((x) => want.test(x.ticker))
    .map((x) => ({ t: x.ticker, title: (x.title || '').slice(0, 70) }))
    .slice(0, 90);

  // For a few likely game-level series, show open events + a sample market.
  const probe = (req.query.probe || 'KXNFLGAME,KXNBAGAME,KXNHLGAME,KXNCAAFGAME,KXNCAABGAME').split(',');
  out.probe = {};
  for (const t of probe) {
    const e = await J(`${KB}/events?series_ticker=${t}&status=open&limit=3&with_nested_markets=true`);
    const ev = e.json?.events?.[0];
    out.probe[t] = {
      status: e.status,
      nEvents: e.json?.events?.length ?? 0,
      sampleEvent: ev ? { ticker: ev.event_ticker, title: ev.title, sub: ev.sub_title } : null,
      sampleMarkets: (ev?.markets || []).slice(0, 3).map((m) => ({
        ticker: m.ticker, yes_sub: m.yes_sub_title, no_sub: m.no_sub_title,
        yes_bid: m.yes_bid, yes_ask: m.yes_ask, last: m.last_price,
        vol: m.volume, oi: m.open_interest, close: m.close_time, rules: (m.rules_primary || '').slice(0, 80),
      })),
    };
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(out);
}
