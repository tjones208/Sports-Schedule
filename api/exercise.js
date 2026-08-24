// GET /api/exercise?league=ncaaf&date=2026-08-29[&bankroll=5000][&flat=25]
//
// Backtest-style question: if you took the ESPN FPI favourite in every game on
// one date, at the current Kalshi ask, sized by the desk's own rule - what win
// rate would you need just to break even?
//
// With mixed prices a single "win percentage" is only well defined per
// contract: the portfolio breaks even when the share of contracts that settle
// YES equals the average price paid. That average price, in cents, IS the
// breakeven percentage.

import { LEAGUES } from '../lib/leagues.mjs';
import { normalizeEvent } from '../lib/normalize.mjs';
import { kellyNet, orderFeeDollars, feePerContractCents, breakevenProbability } from '../lib/fees.mjs';
import { getFbsTeamIds, isFbsMatchup, lastError as fbsError } from '../lib/divisions.mjs';

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
const quote = (d, l) => {
  let c = null;
  if (d != null && d !== '') { const n = Number(d); if (Number.isFinite(n)) c = Math.round(n * 10000) / 100; }
  if (c == null) { const n = Number(l); c = Number.isFinite(n) ? n : null; }
  return c == null || c <= 0 || c >= 100 ? null : c;
};
function parseTicker(t) {
  const m = /-(\d{2})([A-Z]{3})(\d{2})([A-Z0-9]*)$/.exec(t || '');
  if (!m) return null;
  const mo = MONTHS.indexOf(m[2]);
  return mo < 0 ? null : { date: `20${m[1]}-${String(mo + 1).padStart(2, '0')}-${m[3]}`, teams: m[4] || '' };
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
  const league = LEAGUES[q.league] ? q.league : 'ncaaf';
  const L = LEAGUES[league];
  const date = /^\d{4}-\d{2}-\d{2}$/.test(q.date || '') ? q.date : null;
  const bankroll = Math.max(0, Number(q.bankroll) || 5000);
  const frac = Number(q.kelly) || 0.25;
  const maxStake = Number(q.maxStake) || 0.05;
  const flat = Number(q.flat) || 25;
  const role = q.role === 'maker' ? 'maker' : 'taker';

  if (!date) { res.status(400).json({ error: 'Pass ?date=YYYY-MM-DD' }); return; }

  try {
    // Kalshi markets closing on that date
    const kj = await J(`${KB}/events?series_ticker=${SERIES[league]}&status=open&limit=200&with_nested_markets=true`);
    const events = (kj.events || []).filter((e) => parseTicker(e.event_ticker)?.date === date);

    // ESPN games that day
    const extra = new URLSearchParams({ limit: '1000', ...L.query }).toString();
    const sj = await J(`${SITE}/${L.path}/scoreboard?dates=${date.replace(/-/g, '')}&${extra}`);
    const fbsOnly = league === 'ncaaf' && q.fbs !== '0';
    const fbsIds = fbsOnly ? await getFbsTeamIds(L.season) : null;
    const games = (sj.events || [])
      .filter((ev) => !fbsOnly || isFbsMatchup(ev.competitions?.[0], fbsIds))
      .map((ev) => normalizeEvent(ev, L, 'denver')).filter(Boolean);

    // FPI for every game that day
    const ids = games.map((g) => String(g.id).replace(/^[a-z]+-/, ''));
    const fpi = new Map();
    await pool(ids, 8, async (id) => {
      try {
        const j = await J(`${CORE}/${CORE_PATH[league]}/events/${id}/competitions/${id}/predictor`);
        const val = (arr) => {
          const s = (arr || []).find((x) => (x.name || '').toLowerCase() === 'gameprojection');
          return typeof s?.value === 'number' ? s.value / 100 : null;
        };
        const h = val(j?.homeTeam?.statistics), a = val(j?.awayTeam?.statistics);
        if (h != null) fpi.set(id, { home: h, away: a == null ? 1 - h : a });
      } catch { /* game simply drops out */ }
    });

    const picks = [];
    const skipped = [];
    for (const g of games) {
      const id = String(g.id).replace(/^[a-z]+-/, '');
      const f = fpi.get(id);
      if (!f) { skipped.push({ game: `${g.away.short} at ${g.home.short}`, why: 'no FPI projection' }); continue; }

      // The FPI favourite is whichever side FPI gives the higher win chance.
      const side = f.home >= f.away ? 'home' : 'away';
      const team = side === 'home' ? g.home : g.away;
      const p = Math.max(f.home, f.away);

      const ev = events.find((e) => {
        const seg = norm(parseTicker(e.event_ticker).teams);
        const a = norm(g.away.abbrev), h = norm(g.home.abbrev);
        if (seg && a && h && (seg === a + h || seg === h + a)) return true;
        const hay = norm(e.title);
        const hit = (t) => [t.location, t.short, t.name].filter(Boolean).map(norm)
          .some((c) => c.length >= 4 && hay.includes(c));
        return hit(g.home) && hit(g.away);
      });
      if (!ev) { skipped.push({ game: `${g.away.short} at ${g.home.short}`, why: 'no Kalshi market' }); continue; }

      const ab = norm(team.abbrev);
      const mkt = (ev.markets || []).map((m) => ({
        ticker: m.ticker, title: m.yes_sub_title || m.title,
        ask: quote(m.yes_ask_dollars, m.yes_ask),
        volume: Number(m.volume_fp ?? m.volume ?? 0) || 0,
      })).find((m) => norm((m.ticker || '').split('-').pop()) === ab
        || [team.location, team.short, team.name].filter(Boolean).map(norm)
          .some((c) => c.length >= 4 && norm(m.title).includes(c)));
      if (!mkt || mkt.ask == null) { skipped.push({ game: `${g.away.short} at ${g.home.short}`, why: 'favourite not quoted' }); continue; }

      // Size on FPI itself - the premise of the exercise is that FPI is your model.
      const k = kellyNet(p, mkt.ask, frac, role);
      const kellyStake = k ? Math.min(k.staked, maxStake) * bankroll : 0;

      const mk = (stake) => {
        const contracts = Math.floor(stake / (mkt.ask / 100));
        const cost = contracts * (mkt.ask / 100);
        const fee = orderFeeDollars(contracts, mkt.ask, role);
        return { contracts, cost: Number(cost.toFixed(2)), fee, outlay: Number((cost + fee).toFixed(2)) };
      };

      picks.push({
        game: `${g.away.short || g.away.name} at ${g.home.short || g.home.name}`,
        time: `${g.time} ${g.tz}`, networks: g.networks,
        pick: team.short || team.name,
        ticker: mkt.ticker,
        fpiWin: Number((p * 100).toFixed(1)),
        book: g.fair ? Number(((side === 'home' ? g.fair.home : g.fair.away) * 100).toFixed(1)) : null,
        ask: mkt.ask,
        breakeven: Number((breakevenProbability(mkt.ask, role) * 100).toFixed(2)),
        edgeVsFpi: Number(((p - breakevenProbability(mkt.ask, role)) * 100).toFixed(2)),
        volume: mkt.volume,
        kelly: mk(kellyStake),
        flat: mk(flat),
      });
    }

    // Portfolio breakeven. Payout is $1 per winning contract, so the portfolio
    // breaks even when (winning contracts / total contracts) = average cost per
    // contract. That average cost, expressed in cents, is the breakeven rate.
    const summarise = (key) => {
      const live = picks.filter((p) => p[key].contracts > 0);
      const contracts = live.reduce((s, p) => s + p[key].contracts, 0);
      const outlay = live.reduce((s, p) => s + p[key].outlay, 0);
      const fees = live.reduce((s, p) => s + p[key].fee, 0);
      if (!contracts) return { positions: 0 };
      const avgCostCents = (outlay / contracts) * 100;
      // What FPI itself expects: contract-weighted average win probability.
      const fpiExpected = live.reduce((s, p) => s + p[key].contracts * p.fpiWin, 0) / contracts;
      const expectedPayout = live.reduce((s, p) => s + p[key].contracts * (p.fpiWin / 100), 0);
      // Equal-weight view: if every position were the same size, how many of the
      // N games must win?
      const evenBreakeven = live.reduce((s, p) => s + p.breakeven, 0) / live.length;
      return {
        positions: live.length,
        contracts,
        totalOutlay: Number(outlay.toFixed(2)),
        totalFees: Number(fees.toFixed(2)),
        pctOfBankroll: Number(((outlay / bankroll) * 100).toFixed(2)),
        maxPayout: Number(contracts.toFixed(2)),
        breakevenWinRate: Number(avgCostCents.toFixed(2)),
        breakevenPerGameEqualWeight: Number(evenBreakeven.toFixed(2)),
        fpiExpectedWinRate: Number(fpiExpected.toFixed(2)),
        expectedPayout: Number(expectedPayout.toFixed(2)),
        expectedProfit: Number((expectedPayout - outlay).toFixed(2)),
        marginVsFpi: Number((fpiExpected - avgCostCents).toFixed(2)),
      };
    };

    res.setHeader('Cache-Control', 'public, s-maxage=300');
    res.status(200).json({
      league, date, strategy: 'ESPN FPI favourite in every game',
      fbsOnly: league === 'ncaaf' && q.fbs !== '0',
      fbsRosterSize: fbsIds ? fbsIds.size : null,
      fbsSample: fbsIds ? [...fbsIds].slice(0, 5) : null,
      fbsError,
      rawGamesBeforeFilter: (sj.events || []).length,
      fbsDebug: (sj.events || []).map((ev) => ({
        name: ev.shortName,
        teams: (ev.competitions?.[0]?.competitors || []).map((c) => ({
          id: String(c?.team?.id), name: c?.team?.abbreviation,
          inFbs: fbsIds ? fbsIds.has(String(c?.team?.id)) : null,
        })),
        kept: isFbsMatchup(ev.competitions?.[0], fbsIds),
      })),
      settings: { bankroll, kellyFraction: frac, maxStakePct: maxStake, flatStake: flat, role },
      gamesOnDate: games.length,
      kalshiEventsOnDate: events.length,
      picksFound: picks.length,
      skipped: skipped.slice(0, 20),
      kellySized: summarise('kelly'),
      flatSized: summarise('flat'),
      picks: picks.sort((a, b) => b.fpiWin - a.fpiWin),
    });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: err.message });
  }
}
