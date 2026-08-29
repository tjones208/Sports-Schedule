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

/**
 * Normalise a Kalshi market to cents.
 *
 * The API reports prices as dollar strings ("0.5235") in *_dollars fields and
 * sizes in *_fp fields, at deci-cent granularity - so a price is not always a
 * whole number of cents. Older field names are kept as a fallback.
 *
 * A resting quote of zero means nothing is offered on that side, which is not
 * the same as a price of zero, so it is reported as null.
 */
const toCents = (dollars, legacyCents) => {
  if (dollars != null && dollars !== '') {
    const n = Number(dollars);
    if (Number.isFinite(n)) return Math.round(n * 10000) / 100; // deci-cent precision
  }
  const l = Number(legacyCents);
  return Number.isFinite(l) ? l : null;
};
const quote = (dollars, legacyCents) => {
  const c = toCents(dollars, legacyCents);
  return c == null || c <= 0 || c >= 100 ? null : c;
};
const num = (...vals) => {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
};

function shapeMarket(m) {
  const yesBid = quote(m.yes_bid_dollars, m.yes_bid);
  const yesAsk = quote(m.yes_ask_dollars, m.yes_ask);
  const noBid = quote(m.no_bid_dollars, m.no_bid);
  const noAsk = quote(m.no_ask_dollars, m.no_ask);
  return {
    ticker: m.ticker,
    event: m.event_ticker,
    title: m.yes_sub_title || m.title || null,
    yesBid, yesAsk, noBid, noAsk,
    last: quote(m.last_price_dollars, m.last_price),
    bidSize: num(m.yes_bid_size_fp),
    askSize: num(m.yes_ask_size_fp),
    volume: num(m.volume_fp, m.volume),
    volume24h: num(m.volume_24h_fp, m.volume_24h),
    openInterest: num(m.open_interest_fp, m.open_interest),
    liquidity: num(m.liquidity_dollars),
    hasBook: yesBid != null || yesAsk != null,
    status: m.status ?? null,
    closeTime: m.close_time ?? null,
    result: m.result || null,
  };
}

export default async function handler(req, res) {
  const { series, tickers, limit } = req.query;

  // ?series=X&q=virginia&raw=1 dumps the untouched Kalshi payload for matching
  // events alongside what this handler makes of it. When the app says there is
  // no ask and the Kalshi page shows a price, this is what settles which of the
  // two is wrong - the fields Kalshi sent, or the reading of them.
  if (series && req.query.q) {
    try {
      const all = [];
      let c = '';
      let pg = 0;
      do {
        const j = await kalshi(`/events?series_ticker=${encodeURIComponent(series)}`
          + `&status=open&limit=200&with_nested_markets=true${c ? `&cursor=${encodeURIComponent(c)}` : ''}`);
        all.push(...(j?.events || []));
        c = j?.cursor || '';
        pg++;
      } while (c && pg < 12);
      const needle = String(req.query.q).toLowerCase();
      const hits = all.filter((e) => [
        e.event_ticker, e.title, e.sub_title || '',
        ...(e.markets || []).map((m) => `${m.ticker} ${m.yes_sub_title || ''} ${m.title || ''}`),
      ].join(' ').toLowerCase().includes(needle));
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        series,
        query: req.query.q,
        totalOpenEvents: all.length,
        pagesFetched: pg,
        matched: hits.length,
        events: hits.slice(0, 5).map((e) => ({
          ticker: e.event_ticker,
          title: e.title,
          subtitle: e.sub_title || null,
          markets: (e.markets || []).map((m) => ({
            ticker: m.ticker,
            title: m.yes_sub_title || m.title || null,
            status: m.status,
            // Exactly what Kalshi sent, before any interpretation.
            raw: {
              yes_bid_dollars: m.yes_bid_dollars, yes_ask_dollars: m.yes_ask_dollars,
              no_bid_dollars: m.no_bid_dollars, no_ask_dollars: m.no_ask_dollars,
              last_price_dollars: m.last_price_dollars,
              yes_bid: m.yes_bid, yes_ask: m.yes_ask, last_price: m.last_price,
              volume: m.volume, open_interest: m.open_interest,
            },
            // And what this handler turns it into.
            shaped: shapeMarket(m),
          })),
        })),
      });
    } catch (err) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(502).json({ error: err.message });
    }
    return;
  }

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

    // Kalshi caps a page at 200 and hands back a cursor. A single page is not
    // the series: college football lists a whole season at once and runs well
    // past 200 open events, with no guarantee the first page is the near ones.
    // Anything past the cap was invisible, which reads in the app as a game
    // having no market at all.
    const raw = [];
    let cursor = '';
    let pages = 0;
    const MAX_PAGES = 12;                      // 2,400 events is far beyond any sport here
    do {
      const j = await kalshi(`/events?series_ticker=${encodeURIComponent(series)}`
        + `&status=open&limit=200&with_nested_markets=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      raw.push(...(j?.events || []));
      cursor = j?.cursor || '';
      pages++;
    } while (cursor && pages < MAX_PAGES);

    const events = raw.map((e) => ({
      ticker: e.event_ticker,
      title: e.title,
      subtitle: e.sub_title || null,
      markets: (e.markets || []).map(shapeMarket),
    }));

    // Nested markets sometimes omit live quotes; backfill from the markets
    // endpoint, which paginates the same way and needs the same treatment.
    const needQuotes = events.some((e) => e.markets.some((m) => !m.hasBook));
    if (needQuotes && events.length) {
      try {
        const byTicker = new Map();
        let mCursor = '';
        let mPages = 0;
        do {
          const mj = await kalshi(`/markets?series_ticker=${encodeURIComponent(series)}`
            + `&status=open&limit=1000${mCursor ? `&cursor=${encodeURIComponent(mCursor)}` : ''}`);
          for (const m of mj?.markets || []) byTicker.set(m.ticker, shapeMarket(m));
          mCursor = mj?.cursor || '';
          mPages++;
        } while (mCursor && mPages < MAX_PAGES);
        for (const e of events) {
          e.markets = e.markets.map((m) => byTicker.get(m.ticker) || m);
        }
      } catch { /* keep what the nested response gave us */ }
    }

    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.status(200).json({ series, eventCount: events.length, pages, events });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: `Kalshi request failed: ${err.message}` });
  }
}
