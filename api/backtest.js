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

const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
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
  if (!start) { res.status(400).json({ error: 'Pass ?start=YYYY-MM-DD[&end=]' }); return; }

  try {
    const fbsOnly = league === 'ncaaf' && q.fbs !== '0';
    const fbsIds = fbsOnly ? await getFbsTeamIds(String(start).slice(0, 4)) : null;
    const days = dateRange(start, end);
    const extra = new URLSearchParams({ limit: '1000', ...L.query }).toString();

    // 1. Completed games in the window
    const raw = [];
    let completedAll = 0;
    await pool(days, 14, async (d) => {
      try {
        const j = await J(`${SITE}/${L.path}/scoreboard?dates=${d}&${extra}`);
        for (const ev of j.events || []) {
          const c = ev.competitions?.[0];
          if (!c?.status?.type?.completed) continue;
          completedAll++;
          if (fbsOnly && !isFbsMatchup(c, fbsIds)) continue;
          const home = c.competitors?.find((x) => x.homeAway === 'home');
          const away = c.competitors?.find((x) => x.homeAway === 'away');
          if (!home || !away) continue;
          const hs = Number(home.score), as = Number(away.score);
          if (!Number.isFinite(hs) || !Number.isFinite(as) || hs === as) continue;  // ties are undefined here
          raw.push({
            id: ev.id, date: ev.date?.slice(0, 10),
            home: home.team?.abbreviation, away: away.team?.abbreviation,
            hs, as, homeWon: hs > as,
            odds: extractOdds(c),
          });
        }
      } catch { /* skip the day */ }
    });

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

    res.setHeader('Cache-Control', 'public, s-maxage=86400');
    res.status(200).json({
      league, start, end, fbsOnly,
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
      sample: (q.sample === '0' ? [] : rows.slice(0, 3)).map((r) => ({
        g: `${r.away} ${r.as} @ ${r.home} ${r.hs}`,
        fpiHome: Number((r.fpiHome * 100).toFixed(1)),
        marketHome: r.marketHome == null ? null : Number((r.marketHome * 100).toFixed(1)),
        homeWon: r.homeWon,
      })),
    });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: err.message });
  }
}
