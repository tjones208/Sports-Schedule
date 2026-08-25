// GET /api/backtest?league=ncaaf&start=2025-09-01&end=2025-09-07
//
// Scores ESPN's FPI game projections against what actually happened.
//
// The load-bearing assumption is that the predictor endpoint still returns the
// PREGAME projection for a finished game. If ESPN overwrote it with a post-hoc
// number the whole exercise is contaminated, so the response reports a
// leakage check: a model that "knew" the result would be near-perfect and its
// probabilities would cluster at the extremes.

import { LEAGUES } from '../lib/leagues.mjs';
import { dateRange } from '../lib/time.mjs';
import { getFbsTeamIds, isFbsMatchup } from '../lib/divisions.mjs';
import { extractOdds, fairProbabilityConsensus } from '../lib/odds.mjs';
import { kellyNet, orderFeeDollars } from '../lib/fees.mjs';
import { getSeasonLinesAll, normalizeTeam } from '../lib/cfbd.mjs';

const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
// ESPN silently falls back to 25 events when limit exceeds ~500, so a bigger
// number returns FEWER games. 500 is the largest value it actually honours.
const SCOREBOARD_LIMIT = '500';
const CORE = 'https://sports.core.api.espn.com/v2/sports';
const CORE_PATH = {
  nfl: 'football/leagues/nfl', nba: 'basketball/leagues/nba', nhl: 'hockey/leagues/nhl',
  ncaaf: 'football/leagues/college-football', ncaab: 'basketball/leagues/mens-college-basketball',
};

const J = async (u) => {
  const r = await fetch(u, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};
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
  const start = /^\d{4}-\d{2}-\d{2}$/.test(q.start || '') ? q.start : null;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(q.end || '') ? q.end : start;

  // Week mode. Querying by date caps results well below a full Saturday slate,
  // so a season backtest has to ask for whole weeks instead.
  const year = /^\d{4}$/.test(q.year || '') ? q.year : null;
  const weeks = String(q.weeks || '').split(',').map((w) => w.trim()).filter((w) => /^\d+$/.test(w));
  const seasonType = /^[123]$/.test(q.seasontype || '') ? q.seasontype : '2';

  // ?probe=YYYYMMDD reports how many events come back at various limits, to
  // find where ESPN's cap actually bites.
  if (q.probe) {
    const out = {};
    for (const lim of ['25', '100', '300', '500', '900', '1000']) {
      try {
        const j = await J(`${SITE}/${L.path}/scoreboard?dates=${q.probe}&groups=80&limit=${lim}`);
        out[`limit_${lim}`] = (j?.events || []).length;
      } catch (e) { out[`limit_${lim}`] = `ERR ${e.message}`; }
    }
    try {
      const j = await J(`${SITE}/${L.path}/scoreboard?dates=${q.probe}&limit=900`);
      out.noGroups_limit900 = (j?.events || []).length;
    } catch { /* ignore */ }
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ probe: q.probe, events: out });
    return;
  }

  if (!start && !(year && weeks.length)) {
    res.status(400).json({ error: 'Pass ?start=YYYY-MM-DD[&end=] or ?year=2025&weeks=1,2,3[&seasontype=2]' });
    return;
  }

  try {
    const fbsOnly = league === 'ncaaf' && q.fbs !== '0';
    const fbsIds = fbsOnly ? await getFbsTeamIds(year || String(start).slice(0, 4)) : null;
    const extra = new URLSearchParams({ limit: SCOREBOARD_LIMIT, ...L.query }).toString();

    // 1. Completed games.
    //
    // The site scoreboard silently caps at 25 events per request no matter what
    // `limit` says, which quietly turns a season backtest into a sample of
    // whichever games ESPN lists first. The core API's week events collection
    // paginates properly, so week mode walks that instead and pulls each game's
    // detail individually.
    const raw = [];
    let completedAll = 0;
    const seenIds = new Set();

    async function collectEvent(id) {
      const sum = await J(`${SITE}/${L.path}/summary?event=${id}`);
      const c = sum?.header?.competitions?.[0];
      if (!c?.status?.type?.completed) return;
      if (seenIds.has(String(id))) return;
      seenIds.add(String(id));
      completedAll++;
      if (fbsOnly && !isFbsMatchup(c, fbsIds)) return;
      const home = c.competitors?.find((x) => x.homeAway === 'home');
      const away = c.competitors?.find((x) => x.homeAway === 'away');
      if (!home || !away) return;
      const hs = Number(home.score), as = Number(away.score);
      if (!Number.isFinite(hs) || !Number.isFinite(as) || hs === as) return;
      raw.push({
        id: String(id), date: (sum?.header?.competitions?.[0]?.date || '').slice(0, 10),
        home: home.team?.abbreviation, away: away.team?.abbreviation,
        homeName: home.team?.location || home.team?.displayName,
        awayName: away.team?.location || away.team?.displayName,
        hs, as, homeWon: hs > as, odds: null,
      });
    }

    let requests = 0;
    if (year && weeks.length) {
      const ids = [];
      await pool(weeks, 6, async (w) => {
        let page = 1, pageCount = 1;
        while (page <= pageCount && page <= 10) {
          try {
            requests++;
            const j = await J(`${CORE}/${CORE_PATH[league]}/seasons/${year}/types/${seasonType}/weeks/${w}/events?limit=100&page=${page}`);
            pageCount = j?.pageCount || 1;
            for (const it of j?.items || []) {
              const m = /\/events\/(\d+)/.exec(it?.$ref || '');
              if (m) ids.push(m[1]);
            }
          } catch { break; }
          page++;
        }
      });
      requests += ids.length;
      await pool([...new Set(ids)], 14, async (id) => {
        try { await collectEvent(id); } catch { /* skip */ }
      });
    } else {
      const extra2 = new URLSearchParams({ limit: SCOREBOARD_LIMIT, ...L.query }).toString();
      const days = dateRange(start, end);
      requests = days.length;
      await pool(days, 14, async (d) => {
        try {
          const j = await J(`${SITE}/${L.path}/scoreboard?dates=${d}&${extra2}`);
          for (const ev of j.events || []) {
            const c = ev.competitions?.[0];
            if (!c?.status?.type?.completed) continue;
            if (seenIds.has(ev.id)) continue;
            seenIds.add(ev.id);
            completedAll++;
            if (fbsOnly && !isFbsMatchup(c, fbsIds)) continue;
            const home = c.competitors?.find((x) => x.homeAway === 'home');
            const away = c.competitors?.find((x) => x.homeAway === 'away');
            if (!home || !away) continue;
            const hs = Number(home.score), as = Number(away.score);
            if (!Number.isFinite(hs) || !Number.isFinite(as) || hs === as) continue;
            raw.push({ id: ev.id, date: ev.date?.slice(0, 10),
              home: home.team?.abbreviation, away: away.team?.abbreviation,
              homeName: home.team?.location || home.team?.displayName,
              awayName: away.team?.location || away.team?.displayName,
              hs, as, homeWon: hs > as, odds: extractOdds(c) });
          }
        } catch { /* skip the day */ }
      });
    }

    // 2. FPI projection per game
    const rows = [];
    await pool(raw, 14, async (g) => {
      try {
        const j = await J(`${CORE}/${CORE_PATH[league]}/events/${g.id}/competitions/${g.id}/predictor`);
        const val = (arr) => {
          const s = (arr || []).find((x) => (x.name || '').toLowerCase() === 'gameprojection');
          return typeof s?.value === 'number' ? s.value / 100 : null;
        };
        const p = val(j?.homeTeam?.statistics);
        if (p == null) return;
        const market = fairProbabilityConsensus(g.odds, league);
        rows.push({ ...g, fpiHome: p, marketHome: market ? market.home : null });
      } catch { /* game drops out */ }
    });

    // Historical closing lines, when a CFBD key is configured. This is the only
    // source that retains them, and it turns the P&L from a parameterised
    // what-if into an actual number.
    let lineJoin = null;
    const cfbdKey = process.env.CFBD_API_KEY || q.key || '';
    if (cfbdKey && league === 'ncaaf' && rows.length) {
      try {
        const season = year || String(start).slice(0, 4);
        const lines = await getSeasonLinesAll(season, cfbdKey);
        let matched = 0, priced = 0;
        let byId = 0, byName = 0;
        for (const r of rows) {
          // CFBD carries ESPN's event id, so this is an exact join.
          let hit = lines.get(String(r.id));
          if (hit) byId++;
          else {
            hit = lines.get(`${normalizeTeam(r.awayName)}|${normalizeTeam(r.homeName)}`);
            if (hit) byName++;
          }
          if (!hit) continue;
          matched++;
          const fair = fairProbabilityConsensus(
            { homeML: hit.homeML, awayML: hit.awayML, spread: hit.spread }, league);
          if (fair) { r.marketHome = fair.home; r.lineBooks = hit.books; priced++; }
        }
        lineJoin = { source: 'CollegeFootballData /lines', season,
          joinedById: byId, joinedByName: byName,
          gamesWithLines: Math.floor(lines.size / 2), matched, priced,
          matchRate: Number(((matched / rows.length) * 100).toFixed(1)),
          unmatchedSample: rows.filter((r) => !r.marketHome).slice(0, 5)
            .map((r) => `${r.awayName} at ${r.homeName}`) };
      } catch (err) {
        lineJoin = { error: err.message };
      }
    }

    // ?minProb / ?maxProb restrict every downstream number to a confidence
    // window, so a "only trade 60-80%" rule can be measured directly.
    const minProb = q.minProb != null ? Number(q.minProb) / 100 : null;
    const maxProb = q.maxProb != null ? Number(q.maxProb) / 100 : null;
    const beforeFilter = rows.length;
    if (minProb != null || maxProb != null) {
      const keep = rows.filter((r) => {
        const p = Math.max(r.fpiHome, 1 - r.fpiHome);
        return (minProb == null || p >= minProb) && (maxProb == null || p < maxProb);
      });
      rows.length = 0;
      rows.push(...keep);
    }

    // ?dataset=1 returns one compact record per game and nothing else.
    //
    // This is what the Backtest tab pulls. Every derived number - bands, the
    // discount sweep, P&L, fees, calibration - is recomputed in the browser
    // from these rows, so changing a variable is instant and does not re-hit
    // ESPN. Keys are single letters because a full NBA season is 1,200+ of
    // these and the field names would otherwise outweigh the data.
    //
    //   d date, p favourite's FPI probability, w did the favourite win,
    //   m the same favourite's vig-free market probability (null when unknown),
    //   f favourite abbreviation, o opponent abbreviation
    if (q.dataset === '1') {
      const dataset = rows.map((r) => {
        const favIsHome = r.fpiHome >= 0.5;
        return {
          d: r.date,
          p: Number(Math.max(r.fpiHome, 1 - r.fpiHome).toFixed(4)),
          w: (favIsHome === r.homeWon) ? 1 : 0,
          m: r.marketHome == null ? null
            : Number((favIsHome ? r.marketHome : 1 - r.marketHome).toFixed(4)),
          f: favIsHome ? r.home : r.away,
          o: favIsHome ? r.away : r.home,
        };
      });
      // Cache a productive answer, but never a zero - an empty result is
      // usually transient upstream trouble and should not stick for a day.
      res.setHeader('Cache-Control', dataset.length
        ? 'public, s-maxage=86400' : 'no-store');
      res.status(200).json({
        league, start, end, year, weeks, fbsOnly,
        gamesFound: raw.length,
        gamesScored: rows.length,
        // Why games dropped out, so an empty result is self-diagnosing:
        // completed games ESPN listed, how many survived filtering, and how
        // many of those still had a pregame projection attached.
        droppedNoProjection: raw.length - rows.length,
        withMarket: dataset.filter((g) => g.m != null).length,
        completedGamesOnScoreboard: completedAll,
        lines: lineJoin && { matchRate: lineJoin.matchRate, priced: lineJoin.priced,
          error: lineJoin.error || undefined },
        dataset,
      });
      return;
    }

    if (!rows.length) { res.status(200).json({ league, start, end, games: 0, note: 'no completed games with a projection' }); return; }

    // 3. Score it
    const score = (probOf) => {
      const used = rows.filter((r) => probOf(r) != null);
      if (!used.length) return null;
      let correct = 0, brier = 0, logloss = 0;
      for (const r of used) {
        const p = probOf(r);
        const y = r.homeWon ? 1 : 0;
        if ((p >= 0.5) === r.homeWon) correct++;
        brier += (p - y) ** 2;
        logloss += -(y * Math.log(Math.max(p, 1e-9)) + (1 - y) * Math.log(Math.max(1 - p, 1e-9)));
      }
      return {
        n: used.length,
        correct,
        sumBrier: Number(brier.toFixed(6)),
        sumLogLoss: Number(logloss.toFixed(6)),
        accuracy: Number(((correct / used.length) * 100).toFixed(2)),
        brier: Number((brier / used.length).toFixed(4)),
        logLoss: Number((logloss / used.length).toFixed(4)),
      };
    };

    // Confidence bands, folded so 0.5 is "coin flip" and 1.0 is "certain"
    const bands = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]];
    const calibration = bands.map(([lo, hi]) => {
      const inb = rows.filter((r) => {
        const c = Math.max(r.fpiHome, 1 - r.fpiHome);
        return c >= lo && c < hi;
      });
      const hit = inb.filter((r) => (r.fpiHome >= 0.5) === r.homeWon).length;
      const meanPred = inb.length
        ? inb.reduce((s, r) => s + Math.max(r.fpiHome, 1 - r.fpiHome), 0) / inb.length : null;
      return {
        band: `${Math.round(lo * 100)}-${Math.round(hi * 100)}%`,
        n: inb.length,
        hits: hit,
        sumPred: Number(inb.reduce((s2, r) => s2 + Math.max(r.fpiHome, 1 - r.fpiHome), 0).toFixed(6)),
        predicted: meanPred == null ? null : Number((meanPred * 100).toFixed(1)),
        actual: inb.length ? Number(((hit / inb.length) * 100).toFixed(1)) : null,
        gap: inb.length ? Number((((hit / inb.length) - meanPred) * 100).toFixed(1)) : null,
      };
    });

    const withMarket = rows.filter((r) => r.marketHome != null);
    const homeWins = rows.filter((r) => r.homeWon).length;

    const payload = {
      league, start, end, year, weeks, fbsOnly,
      probabilityWindow: (minProb != null || maxProb != null)
        ? { min: minProb == null ? null : minProb * 100, max: maxProb == null ? null : maxProb * 100,
            gamesBefore: beforeFilter, gamesAfter: rows.length } : null,
      requests,
      // Completed games found vs those ESPN still has a projection for. A big
      // gap would mean the sample is not the season, just the part ESPN kept.
      completedGamesOnScoreboard: completedAll,
      fbsRosterSize: fbsIds ? fbsIds.size : null,
      gamesFound: raw.length,
      gamesScored: rows.length,
      coverage: Number(((rows.length / raw.length) * 100).toFixed(1)),
      games: rows.length,
      fpi: score((r) => r.fpiHome),
      market: score((r) => r.marketHome),
      marketCoverage: withMarket.length,
      baselineAlwaysHome: {
        homeWins,
        accuracy: Number(((homeWins / rows.length) * 100).toFixed(2)),
        brier: Number((rows.reduce((s, r) => s + (1 - (r.homeWon ? 1 : 0)) ** 2, 0) / rows.length).toFixed(4)),
      },
      calibration,
      // If ESPN had overwritten pregame numbers with hindsight, accuracy would be
      // near 100 and almost every projection would sit above 95%.
      leakageCheck: {
        projectionsOver95: rows.filter((r) => Math.max(r.fpiHome, 1 - r.fpiHome) > 0.95).length,
        shareOver95: Number(((rows.filter((r) => Math.max(r.fpiHome, 1 - r.fpiHome) > 0.95).length / rows.length) * 100).toFixed(1)),
      },
      lines: lineJoin,

      // With real closing lines, the price is no longer assumed: this is what
      // taking every FPI favourite at the market's vig-free price would have paid.
      pnlAtMarket: (q.pnl === '1' && rows.some((r) => r.marketHome != null)) ? (() => {
        const bankroll = Number(q.bankroll) || 5000;
        const frac = Number(q.kelly) || 0.25;
        const cap = Number(q.maxStake) || 0.05;
        const flat = Number(q.flat) || 25;
        const used = rows.filter((r) => r.marketHome != null);

        // The vig-free mid is not tradeable. On Kalshi you lift an ask above
        // fair; at a book you pay the juice. spreadPts adds that cost in
        // probability points, so a result that only works at the untradeable
        // mid is exposed rather than reported as profit.
        const run = (mode, spreadPts) => {
          let staked = 0, fees = 0, profit = 0, bets = 0, wins = 0;
          const pnls = [];
          for (const r of used) {
            const p = Math.max(r.fpiHome, 1 - r.fpiHome);
            const favIsHome = r.fpiHome >= 0.5;
            const won = (favIsHome === r.homeWon);
            const mkt = favIsHome ? r.marketHome : 1 - r.marketHome;
            const ask = Math.min(99, Math.max(1, mkt * 100 + spreadPts));
            let stake;
            if (mode === 'flat') stake = flat;
            else {
              const k = kellyNet(p, ask, frac, 'taker');
              if (!k) continue;
              stake = Math.min(k.staked, cap) * bankroll;
            }
            const contracts = Math.floor(stake / (ask / 100));
            if (contracts < 1) continue;
            const fee = orderFeeDollars(contracts, ask, 'taker');
            const cost = contracts * (ask / 100) + fee;
            const pl = won ? contracts - cost : -cost;
            bets++; wins += won ? 1 : 0; staked += cost; fees += fee;
            profit += pl; pnls.push(pl);
          }
          // Standard error of the ROI, so a result inside the noise is visible.
          const se = bets > 1 ? Math.sqrt(pnls.reduce((s2, x) => s2 + (x - profit / bets) ** 2, 0) / (bets - 1)) / Math.sqrt(bets) : null;
          return { spreadPts, bets, wins, winRate: bets ? Number(((wins / bets) * 100).toFixed(2)) : null,
            staked: Number(staked.toFixed(2)), fees: Number(fees.toFixed(2)),
            profit: Number(profit.toFixed(2)),
            roi: staked ? Number(((profit / staked) * 100).toFixed(2)) : null,
            profitSE: se == null ? null : Number((se * bets).toFixed(2)),
            tStat: se && se > 0 ? Number(((profit / bets) / se).toFixed(2)) : null,
            endingBankroll: Number((bankroll + profit).toFixed(2)) };
        };
        const steps = [0, 1, 2, 3, 4];
        return { gamesWithLine: used.length,
          kelly: steps.map((v) => run('kelly', v)),
          flat: steps.map((v) => run('flat', v)) };
      })() : undefined,

      // ?pnl=1 simulates taking every FPI favourite with the desk's own staking.
      //
      // Kalshi does not retain last season's markets, so there is no real entry
      // price to use. The price is therefore modelled as FPI's own probability
      // shifted by delta points: delta 0 means the market agreed with FPI
      // exactly (no edge, so Kelly stakes nothing), negative delta means the
      // market was cheaper than FPI thought, i.e. you had an edge.
      pnl: q.pnl === '1' ? (() => {
        const bankroll = Number(q.bankroll) || 5000;
        const frac = Number(q.kelly) || 0.25;
        const cap = Number(q.maxStake) || 0.05;
        const flat = Number(q.flat) || 25;
        const fixedContracts = Number(q.contracts) || 100;
        const deltas = [-10, -8, -7, -6, -5, -4, -3, -2, -1, 0];

        const run = (delta, mode) => {
          let staked = 0, fees = 0, profit = 0, bets = 0, wins = 0, contractsTotal = 0;
          const pnls = [];
          for (const r of rows) {
            const p = Math.max(r.fpiHome, 1 - r.fpiHome);
            const won = ((r.fpiHome >= 0.5) === r.homeWon);
            const ask = Math.min(99, Math.max(1, (p * 100) + delta));
            let contracts;
            if (mode === 'fixed') {
              // Same size on every game, regardless of price or edge.
              contracts = fixedContracts;
            } else {
              let stake;
              if (mode === 'flat') stake = flat;
              else {
                const k = kellyNet(p, ask, frac, 'taker');
                if (!k) continue;
                stake = Math.min(k.staked, cap) * bankroll;
              }
              contracts = Math.floor(stake / (ask / 100));
            }
            if (contracts < 1) continue;
            const fee = orderFeeDollars(contracts, ask, 'taker');
            const cost = contracts * (ask / 100) + fee;
            const pl = won ? contracts - cost : -cost;
            bets++; wins += won ? 1 : 0; staked += cost; fees += fee; contractsTotal += contracts;
            profit += pl; pnls.push(pl);
          }
          const mean = bets ? profit / bets : 0;
          const sd = bets > 1 ? Math.sqrt(pnls.reduce((t, x) => t + (x - mean) ** 2, 0) / (bets - 1)) : null;
          const seTotal = sd == null ? null : sd * Math.sqrt(bets);
          return {
            delta, bets, wins,
            profitSE: seTotal == null ? null : Number(seTotal.toFixed(2)),
            tStat: seTotal && seTotal > 0 ? Number((profit / seTotal).toFixed(2)) : null,
            avgPriceCents: bets ? Number(((staked - fees) / (bets * fixedContracts) * 100).toFixed(2)) : null,
            winRate: bets ? Number(((wins / bets) * 100).toFixed(2)) : null,
            staked: Number(staked.toFixed(2)),
            fees: Number(fees.toFixed(2)),
            profit: Number(profit.toFixed(2)),
            roi: staked ? Number(((profit / staked) * 100).toFixed(2)) : null,
            endingBankroll: Number((bankroll + profit).toFixed(2)),
          };
        };

        // Per-confidence-band P&L at a fair price, fixed size. This is what
        // answers "is there a range I should not trade": at fair value every
        // band loses the fee, so what varies is how much miscalibration adds on
        // top and how heavy the fee is at that price.
        const bandPnl = (lo, hi, spreadPts = 0) => {
          let n = 0, wins = 0, expWins = 0, cost = 0, fees = 0, payout = 0;
          for (const r of rows) {
            const p = Math.max(r.fpiHome, 1 - r.fpiHome);
            if (p < lo || p >= hi) continue;
            const won = ((r.fpiHome >= 0.5) === r.homeWon);
            const ask = Math.min(99, Math.max(1, p * 100 + spreadPts));
            const fee = orderFeeDollars(fixedContracts, ask, 'taker');
            n++; wins += won ? 1 : 0; expWins += p;
            cost += fixedContracts * (ask / 100); fees += fee;
            payout += won ? fixedContracts : 0;
          }
          const outlay = cost + fees;
          return { band: `${Math.round(lo * 100)}-${Math.round(hi * 100)}%`, games: n,
            wins, expectedWins: Number(expWins.toFixed(1)),
            winsVsExpected: Number((wins - expWins).toFixed(1)),
            outlay: Number(outlay.toFixed(2)), fees: Number(fees.toFixed(2)),
            profit: Number((payout - outlay).toFixed(2)),
            roi: outlay ? Number(((payout - outlay) / outlay * 100).toFixed(2)) : null,
            profitPerGame: n ? Number(((payout - outlay) / n).toFixed(2)) : null };
        };

        const coarse = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]];
        const fine = [[0.5, 0.55], [0.55, 0.6], [0.6, 0.65], [0.65, 0.7], [0.7, 0.75],
          [0.75, 0.8], [0.8, 0.85], [0.85, 0.9], [0.9, 0.95], [0.95, 1.01]];

        // Sum of FPI's own probabilities: how many wins it expected in total.
        const sumPred = rows.reduce((t, r) => t + Math.max(r.fpiHome, 1 - r.fpiHome), 0);
        const actualWins = rows.filter((r) => ((r.fpiHome >= 0.5) === r.homeWon)).length;

        return {
          note: 'price modelled as FPI probability + delta points; no historical Kalshi prices exist',
          bankroll, kellyFraction: frac, maxStakePct: cap, flatStake: flat, fixedContracts,
          expectedWins: Number(sumPred.toFixed(2)),
          actualWins,
          winsVsExpected: Number((actualWins - sumPred).toFixed(2)),
          byBand: coarse.map(([lo, hi]) => bandPnl(lo, hi)),
          byBandFine: fine.map(([lo, hi]) => bandPnl(lo, hi)),
          // What the season looks like if a band is skipped entirely.
          excludingBand: coarse.map(([lo, hi]) => {
            const kept = coarse.filter(([a]) => a !== lo).map(([a, b]) => bandPnl(a, b));
            return { skipped: `${Math.round(lo * 100)}-${Math.round(hi * 100)}%`,
              games: kept.reduce((t, x) => t + x.games, 0),
              profit: Number(kept.reduce((t, x) => t + x.profit, 0).toFixed(2)) };
          }),
          fixed: deltas.map((d) => run(d, 'fixed')),
          kelly: deltas.map((d) => run(d, 'kelly')),
          flat: deltas.map((d) => run(d, 'flat')),
        };
      })() : undefined,

      // ?raw=1 returns the per-game (favourite probability, did it win) pairs so
      // a P&L can be simulated against an assumed price. Kalshi does not retain
      // last season's markets, so the price has to be a stated assumption.
      raw: q.raw === '1' ? {
        favProb: rows.map((r) => Number(Math.max(r.fpiHome, 1 - r.fpiHome).toFixed(4))),
        favWon: rows.map((r) => (((r.fpiHome >= 0.5) === r.homeWon) ? 1 : 0)),
      } : undefined,
      sample: (q.sample === '0' ? [] : rows.slice(0, 3)).map((r) => ({
        g: `${r.away} ${r.as} @ ${r.home} ${r.hs}`,
        fpiHome: Number((r.fpiHome * 100).toFixed(1)),
        marketHome: r.marketHome == null ? null : Number((r.marketHome * 100).toFixed(1)),
        homeWon: r.homeWon,
      })),
    };

    res.setHeader('Cache-Control', 'public, s-maxage=86400');

    // ?brief=1 returns just the headline comparison, for reading several
    // seasons side by side without the full sweeps.
    if (q.brief === '1') {
      const pick = (arr, v) => (arr || []).find((x) => x.spreadPts === v);
      res.status(200).json({
        season: year || `${start} to ${end}`,
        window: payload.probabilityWindow,
        games: payload.games,
        fpi: payload.fpi && { accuracy: payload.fpi.accuracy, brier: payload.fpi.brier },
        market: payload.market && { accuracy: payload.market.accuracy, brier: payload.market.brier },
        fpiBeatsMarket: payload.fpi && payload.market
          ? payload.fpi.brier < payload.market.brier : null,
        atMarket: payload.pnlAtMarket && {
          kelly0: pick(payload.pnlAtMarket.kelly, 0),
          kelly2: pick(payload.pnlAtMarket.kelly, 2),
          flat0: pick(payload.pnlAtMarket.flat, 0),
        },
        atFpiPrice: payload.pnl && (payload.pnl.fixed || []).find((x) => x.delta === 0),
        // How the result moves as Kalshi prices below FPI, in probability points.
        discountSweep: payload.pnl && (payload.pnl.fixed || []).map((x) => ({
          discountPts: -x.delta, profit: x.profit, roi: x.roi, tStat: x.tStat })),
        // Per-band result at zero discount. Since one point of discount is worth
        // exactly $1 per game per 100 contracts, -profit/games is very nearly the
        // discount that band needed to break even.
        byBand: payload.pnl && (payload.pnl.byBand || []).filter((b) => b.games > 0).map((b) => ({
          band: b.band, games: b.games, wins: b.wins, expectedWins: b.expectedWins,
          fees: b.fees, profit: b.profit,
          discountNeededPts: b.games ? Number((-b.profit / b.games).toFixed(2)) : null,
          feeInPts: b.games ? Number((b.fees / b.games).toFixed(2)) : null,
        })),
        lines: payload.lines && { matchRate: payload.lines.matchRate, priced: payload.lines.priced },
      });
      return;
    }
    res.status(200).json(payload);
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: err.message });
  }
}
