// Kalshi public market data, proxied so the browser gets one origin and the
// edge cache absorbs repeat requests.
//
//   GET /api/kalshi?series=KXNFLGAME[&limit=200]   open events + market prices
//   GET /api/kalshi?tickers=A,B,C                  prices for specific markets
//
// Read-only. This never authenticates and never places an order.

const BASE = 'https://api.elections.kalshi.com/trade-api/v2';

// Game-winner series, per league key used elsewhere in the app.
export const GAME_SERIES = {
  nfl: 'KXNFLGAME',
  nba: 'KXNBAGAME',
  nhl: 'KXNHLGAME',
  ncaaf: 'KXNCAAFGAME',
  ncaab: 'KXNCAABGAME',
};

async function kalshi(path, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await fetch(`${BASE}${path}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (err) {
      if (i === attempts) throw err;
      await new Promise((res) => setTimeout(res, 250 * 2 ** i));
    }
  }
  return null;
}

/** Kalshi quotes in cents; absent bids/asks mean nothing is resting on that side. */
function shapeMarket(m) {
  return {
    ticker: m.ticker,
    event: m.event_ticker,
    title: m.yes_sub_title || m.title || null,
    yesBid: m.yes_bid ?? null,
    yesAsk: m.yes_ask ?? null,
    noBid: m.no_bid ?? null,
    noAsk: m.no_ask ?? null,
    last: m.last_price ?? null,
    volume: m.volume ?? 0,
    openInterest: m.open_interest ?? 0,
    status: m.status ?? null,
    closeTime: m.close_time ?? null,
    result: m.result || null,
  };
}

export default async function handler(req, res) {
  const { series, tickers, limit } = req.query;

  try {
    if (tickers) {
      const list = String(tickers).split(',').map((t) => t.trim()).filter(Boolean).slice(0, 60);
      const found = await Promise.all(list.map(async (t) => {
        try {
          const j = await kalshi(`/markets/${encodeURIComponent(t)}`);
          return j?.market ? shapeMarket(j.market) : null;
        } catch { return null; }
      }));
      res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
      res.status(200).json({ markets: found.filter(Boolean) });
      return;
    }

    if (!series) {
      res.status(400).json({ error: 'Pass ?series=TICKER or ?tickers=A,B', gameSeries: GAME_SERIES });
      return;
    }

    const n = Math.min(Number(limit) || 200, 200);
    const j = await kalshi(
      `/events?series_ticker=${encodeURIComponent(series)}&status=open&limit=${n}&with_nested_markets=true`,
    );

    const events = (j?.events || []).map((e) => ({
      ticker: e.event_ticker,
      title: e.title,
      subtitle: e.sub_title || null,
      markets: (e.markets || []).map(shapeMarket),
    }));

    // Nested markets sometimes omit live quotes; backfill from the markets endpoint.
    const needQuotes = events.some((e) => e.markets.some((m) => m.yesAsk == null));
    if (needQuotes && events.length) {
      try {
        const mj = await kalshi(`/markets?series_ticker=${encodeURIComponent(series)}&status=open&limit=200`);
        const byTicker = new Map((mj?.markets || []).map((m) => [m.ticker, shapeMarket(m)]));
        for (const e of events) {
          e.markets = e.markets.map((m) => byTicker.get(m.ticker) || m);
        }
      } catch { /* keep what the nested response gave us */ }
    }

    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.status(200).json({ series, eventCount: events.length, events });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: `Kalshi request failed: ${err.message}` });
  }
}
