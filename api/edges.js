// GET /api/edges?league=nfl[&bankroll=5000][&kelly=0.25][&maxStake=0.05][&minEdge=0][&fpi=0.35][&role=taker]
//
// The whole join, server side: schedule + sportsbook line + Kalshi book + ESPN
// FPI, returned as a ranked list of suggested positions with sizes. Same maths
// the desk runs in the browser.

import { LEAGUES } from '../lib/leagues.mjs';
import { normalizeEvent } from '../lib/normalize.mjs';
import { dateRange } from '../lib/time.mjs';
import { kellyNet, netEdge, netExpectedValue, orderFeeDollars, breakevenProbability } from '../lib/fees.mjs';

const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const CORE = 'https://sports.core.api.espn.com/v2/sports';
const KB = 'https://api.elections.kalshi.com/trade-api/v2';
const SERIES = { nfl: 'KXNFLGAME', nba: 'KXNBAGAME', nhl: 'KXNHLGAME', ncaaf: 'KXNCAAFGAME', ncaab: 'KXNCAABGAME' };
const CORE_PATH = {
  nfl: 'football/leagues/nfl', nba: 'basketball/leagues/nba', nhl: 'hockey/leagues/nhl',
  ncaaf: 'football/leagues/college-football', ncaab: 'basketball/leagues/mens-college-basketball',
};
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

const J = async (u) => {
  const r = await fetch(u, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z]/g, '');
const toCents = (d, legacy) => {
  if (d != null && d !== '') { const n = Number(d); if (Number.isFinite(n)) return Math.round(n * 10000) / 100; }
  const l = Number(legacy); return Number.isFinite(l) ? l : null;
};
const quote = (d, l) => { const c = toCents(d, l); return c == null || c <= 0 || c >= 100 ? null : c; };

function parseTicker(t) {
  const m = /-(\d{2})([A-Z]{3})(\d{2})([A-Z0-9]*)$/.exec(t || '');
  if (!m) return null;
  const mo = MONTHS.indexOf(m[2]);
  if (mo < 0) return null;
  return { date: `20${m[1]}-${String(mo + 1).padStart(2, '0')}-${m[3]}`, teams: m[4] || '' };
}

async function pool(items, limit, worker) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await worker(items[k]); }
  }));
  return out;
}

export default async function handler(req, res) {
  const q = req.query;
  const league = LEAGUES[q.league] ? q.league : 'nfl';
  const L = LEAGUES[league];
  const bankroll = Math.max(0, Number(q.bankroll) || 5000);
  const frac = Math.min(1, Math.max(0.01, Number(q.kelly) || 0.25));
  const maxStake = Math.min(1, Math.max(0.001, Number(q.maxStake) || 0.05));
  const minEdge = (Number(q.minEdge) || 0) / 100;
  const fpiW = Math.min(1, Math.max(0, q.fpi == null ? 0.35 : Number(q.fpi)));
  const role = q.role === 'maker' ? 'maker' : 'taker';
  const method = ['multiplicative', 'additive', 'power', 'shin'].includes(q.method)
    ? q.method : 'multiplicative';

  try {
    // 1. Kalshi open markets for this league
    const kj = await J(`${KB}/events?series_ticker=${SERIES[league]}&status=open&limit=200&with_nested_markets=true`);
    const events = (kj.events || []).map((e) => ({
      ticker: e.event_ticker, title: e.title,
      markets: (e.markets || []).map((m) => ({
        ticker: m.ticker, title: m.yes_sub_title || m.title,
        ask: quote(m.yes_ask_dollars, m.yes_ask),
        bid: quote(m.yes_bid_dollars, m.yes_bid),
        volume: Number(m.volume_fp ?? m.volume ?? 0) || 0,
        oi: Number(m.open_interest_fp ?? m.open_interest ?? 0) || 0,
      })),
    })).filter((e) => e.markets.some((m) => m.ask != null));

    if (!events.length) {
      res.status(200).json({ league, tradeable: false, reason: 'No quoted Kalshi markets open for this league', picks: [] });
      return;
    }

    // 2. Only fetch schedule days that actually have a market
    const dates = [...new Set(events.map((e) => parseTicker(e.ticker)?.date).filter(Boolean))].sort();
    const extra = new URLSearchParams({ limit: '1000', ...L.query }).toString();
    const games = [];
    await pool(dates, 6, async (d) => {
      try {
        const j = await J(`${SITE}/${L.path}/scoreboard?dates=${d.replace(/-/g, '')}&${extra}`);
        for (const ev of j.events || []) {
          const g = normalizeEvent(ev, L, 'denver', method);
          if (g && g.fair) games.push(g);
        }
      } catch { /* skip the day */ }
    });

    // 3. Join
    const rows = [];
    for (const e of events) {
      const parsed = parseTicker(e.ticker);
      if (!parsed) continue;
      const seg = norm(parsed.teams);
      const game = games.find((g) => {
        if (g.date !== parsed.date) return false;
        const a = norm(g.away.abbrev), h = norm(g.home.abbrev);
        if (seg && a && h && (seg === a + h || seg === h + a)) return true;
        const hay = norm(e.title);
        const hit = (t) => [t.location, t.short, t.name].filter(Boolean).map(norm)
          .some((c) => c.length >= 4 && hay.includes(c));
        return hit(g.home) && hit(g.away);
      });
      if (!game) continue;
      for (const [side, team, fair] of [['home', game.home, game.fair.home], ['away', game.away, game.fair.away]]) {
        const ab = norm(team.abbrev);
        const mkt = e.markets.find((m) => norm((m.ticker || '').split('-').pop()) === ab)
          || e.markets.find((m) => [team.location, team.short, team.name].filter(Boolean).map(norm)
            .some((c) => c.length >= 4 && norm(m.title).includes(c)));
        if (!mkt || mkt.ask == null) continue;
        rows.push({ game, team, side, fair, mkt });
      }
    }

    // 4. ESPN FPI for the matched games
    const ids = [...new Set(rows.map((r) => String(r.game.id).replace(/^[a-z]+-/, '')))].slice(0, 60);
    const fpi = new Map();
    if (fpiW > 0 && ids.length) {
      await pool(ids, 6, async (id) => {
        try {
          const j = await J(`${CORE}/${CORE_PATH[league]}/events/${id}/competitions/${id}/predictor`);
          const g = (arr, n) => { const s = (arr || []).find((x) => (x.name || '').toLowerCase() === n); return typeof s?.value === 'number' ? s.value : null; };
          const h = g(j?.homeTeam?.statistics, 'gameprojection') ?? g(j?.homeTeam?.statistics, 'gameProjection'.toLowerCase());
          const a = g(j?.awayTeam?.statistics, 'gameprojection') ?? g(j?.awayTeam?.statistics, 'gameProjection'.toLowerCase());
          if (h != null) fpi.set(id, { home: h / 100, away: a == null ? 1 - h / 100 : a / 100 });
        } catch { /* blend falls back to the book */ }
      });
    }

    // 5. Size
    const picks = rows.map((r) => {
      const id = String(r.game.id).replace(/^[a-z]+-/, '');
      const f = fpi.get(id);
      const fpiP = f ? (r.side === 'home' ? f.home : f.away) : null;
      const w = fpiP == null ? 0 : fpiW;
      const blend = r.fair * (1 - w) + (fpiP ?? 0) * w;
      const k = kellyNet(blend, r.mkt.ask, frac, role);
      if (!k) return null;
      const stake = Math.min(k.staked, maxStake) * bankroll;
      const contracts = Math.floor(stake / (r.mkt.ask / 100));
      return {
        game: `${r.game.away.short || r.game.away.name} at ${r.game.home.short || r.game.home.name}`,
        date: r.game.date, time: r.game.time, tz: r.game.tz,
        networks: r.game.networks,
        pick: r.team.short || r.team.name,
        ticker: r.mkt.ticker,
        book: Number((r.fair * 100).toFixed(1)),
        fpi: fpiP == null ? null : Number((fpiP * 100).toFixed(1)),
        blend: Number((blend * 100).toFixed(1)),
        disagree: fpiP == null ? null : Number((Math.abs(r.fair - fpiP) * 100).toFixed(1)),
        ask: r.mkt.ask,
        breakeven: Number((breakevenProbability(r.mkt.ask, role) * 100).toFixed(1)),
        netEdgePts: Number((netEdge(blend, r.mkt.ask, role) * 100).toFixed(2)),
        netEvCents: Number(netExpectedValue(blend, r.mkt.ask, role).toFixed(2)),
        stake: Number(stake.toFixed(2)),
        contracts,
        fee: orderFeeDollars(contracts, r.mkt.ask, role),
        volume: r.mkt.volume,
        source: r.game.fair.source,
      };
    }).filter(Boolean).sort((a, b) => b.netEdgePts - a.netEdgePts);

    // With all=1 the near-misses are kept, which is what tells you whether the
    // market is efficient or you are simply filtering too hard.
    const showAll = q.all === '1' || q.all === 'true';
    const qualifying = picks.filter((x) => x.netEdgePts >= minEdge * 100 && x.stake > 0);
    const shown = showAll ? picks : qualifying;

    res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=600');
    res.status(200).json({
      league, tradeable: true, generatedAt: new Date().toISOString(),
      settings: { bankroll, kellyFraction: frac, maxStakePct: maxStake, fpiWeight: fpiW, role, devig: method },
      // Edge grouped by what the contract costs. A method that is fair across
      // the price range should look flat here; a slope means the devig is
      // manufacturing edge at one end of the book.
      byPrice: (() => {
        const buckets = [[1, 15], [15, 35], [35, 65], [65, 85], [85, 99]];
        return buckets.map(([lo, hi]) => {
          const inb = picks.filter((x) => x.ask >= lo && x.ask < hi);
          const avg = inb.length ? inb.reduce((t, x) => t + x.netEdgePts, 0) / inb.length : null;
          return { range: `${lo}-${hi}c`, n: inb.length,
            avgEdge: avg == null ? null : Number(avg.toFixed(2)),
            positive: inb.filter((x) => x.netEdgePts > 0).length };
        });
      })(),
      matchedMarkets: rows.length, withFpi: fpi.size,
      qualifying: qualifying.length,
      totalStake: Number(qualifying.reduce((s, p) => s + p.stake, 0).toFixed(2)),
      edgeSpread: picks.length ? {
        best: picks[0].netEdgePts, median: picks[Math.floor(picks.length / 2)].netEdgePts,
        worst: picks[picks.length - 1].netEdgePts,
        positive: picks.filter((x) => x.netEdgePts > 0).length, of: picks.length,
      } : null,
      picks: shown.slice(0, Number(q.limit) || 25),
    });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: err.message });
  }
}
