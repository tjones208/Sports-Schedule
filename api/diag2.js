// GET /api/diag2 - compact probe of odds + Kalshi availability from the Vercel runtime.
const J = async (url, headers = {}) => {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(9000) });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch {}
    return { status: r.status, ms: Date.now() - t0, bytes: txt.length, json: j, snippet: txt.slice(0, 160) };
  } catch (e) { return { status: 'ERR', ms: Date.now() - t0, error: e.message }; }
};

export default async function handler(req, res) {
  const out = {};

  // 1. Does ESPN expose odds on the scoreboard for future games?
  for (const [k, url] of Object.entries({
    nfl_wk1: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20260913&limit=5',
    cfb_sep5: 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates=20260905&groups=80&limit=5',
  })) {
    const r = await J(url);
    const ev = r.json?.events?.[0];
    const comp = ev?.competitions?.[0];
    out[k] = {
      status: r.status,
      event: ev?.shortName,
      hasOdds: Boolean(comp?.odds?.length),
      oddsSample: comp?.odds?.[0] ? {
        provider: comp.odds[0].provider?.name,
        details: comp.odds[0].details,
        overUnder: comp.odds[0].overUnder,
        spread: comp.odds[0].spread,
        homeML: comp.odds[0].homeTeamOdds?.moneyLine,
        awayML: comp.odds[0].awayTeamOdds?.moneyLine,
        homeFav: comp.odds[0].homeTeamOdds?.favorite,
      } : null,
      keys: comp?.odds?.[0] ? Object.keys(comp.odds[0]) : null,
    };
  }

  // 2. ESPN dedicated odds endpoint (core API)
  const core = await J('https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/401872930/competitions/401872930/odds');
  out.espn_core_odds = { status: core.status, count: core.json?.count, snippet: core.snippet };

  // 3. Kalshi public market data
  out.kalshi_series = await J('https://api.elections.kalshi.com/trade-api/v2/series?category=Sports')
    .then((r) => ({ status: r.status, ms: r.ms, bytes: r.bytes,
      n: r.json?.series?.length, sample: r.json?.series?.slice(0, 12).map((s) => s.ticker), snippet: r.snippet.slice(0, 120) }));

  out.kalshi_markets = await J('https://api.elections.kalshi.com/trade-api/v2/markets?limit=5&status=open')
    .then((r) => ({ status: r.status, ms: r.ms, n: r.json?.markets?.length,
      sample: r.json?.markets?.slice(0, 3).map((m) => ({ t: m.ticker, title: m.title, yes: m.yes_bid, no: m.no_bid, close: m.close_time })),
      snippet: r.snippet.slice(0, 120) }));

  out.kalshi_events = await J('https://api.elections.kalshi.com/trade-api/v2/events?limit=5&status=open')
    .then((r) => ({ status: r.status, n: r.json?.events?.length,
      sample: r.json?.events?.slice(0, 5).map((e) => ({ t: e.event_ticker, title: e.title, series: e.series_ticker })) }));

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(out);
}
