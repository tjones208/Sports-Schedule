// GET /api/diaghist - can we reconstruct what a 2025 Kalshi market cost pregame?
const KB = 'https://api.elections.kalshi.com/trade-api/v2';
const J = async (u) => {
  try {
    const r = await fetch(u, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, json: j, snip: t.slice(0, 220) };
  } catch (e) { return { status: 'ERR', error: e.message }; }
};

export default async function handler(req, res) {
  const out = {};

  // 1. Are last season's college football markets still queryable?
  const s = await J(`${KB}/markets?series_ticker=KXNCAAFGAME&status=settled&limit=100`);
  const ms = s.json?.markets || [];
  out.settled = {
    status: s.status, n: ms.length,
    sample: ms.slice(0, 3).map((m) => ({
      ticker: m.ticker, close: m.close_time, result: m.result,
      last: m.last_price_dollars ?? m.last_price,
      prevYesBid: m.previous_yes_bid_dollars, volume: m.volume_fp ?? m.volume,
    })),
    oldest: ms.map((m) => m.close_time).filter(Boolean).sort()[0],
    newest: ms.map((m) => m.close_time).filter(Boolean).sort().pop(),
  };

  // 2. Price history, so an entry can be taken from before kickoff rather than
  //    from the settled price (which is always 0 or 100 and would be lookahead).
  const t = ms[0]?.ticker;
  if (t) {
    const series = t.split('-')[0];
    const closeTs = Math.floor(new Date(ms[0].close_time).getTime() / 1000);
    for (const [label, url] of Object.entries({
      candles_1h: `${KB}/series/${series}/markets/${encodeURIComponent(t)}/candlesticks?start_ts=${closeTs - 86400 * 3}&end_ts=${closeTs}&period_interval=60`,
      trades: `${KB}/markets/trades?ticker=${encodeURIComponent(t)}&limit=5`,
    })) {
      const r = await J(url);
      out[label] = { status: r.status,
        n: r.json?.candlesticks?.length ?? r.json?.trades?.length ?? null,
        snip: r.snip };
    }
  }

  // 3. How far back does the series go at all?
  const old = await J(`${KB}/markets?series_ticker=KXNCAAFGAME&status=settled&limit=1&min_close_ts=1725000000&max_close_ts=1740000000`);
  out.window2024_25 = { status: old.status, n: old.json?.markets?.length,
    sample: old.json?.markets?.[0]?.ticker || null };

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(out);
}
