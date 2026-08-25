// GET /api/diag?league=nba&date=2026-01-15
//
// One date, one sport, and a plain account of what ESPN actually returns. This
// exists because a backtest that comes back empty has several possible causes
// that look identical from the browser:
//
//   - the scoreboard lists no games for that date
//   - it lists games but none are finished
//   - games are finished but the predictor endpoint 404s
//   - the predictor responds but carries no gameProjection stat, which is the
//     one the backtest reads
//
// So this reports each stage separately, and dumps the raw statistic names the
// predictor did return - if a sport labels its projection something other than
// gameProjection, that is where it shows up.

import { LEAGUES } from '../lib/leagues.mjs';

const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const CORE = 'https://sports.core.api.espn.com/v2/sports';
const CORE_PATH = {
  nfl: 'football/leagues/nfl', nba: 'basketball/leagues/nba', nhl: 'hockey/leagues/nhl',
  ncaaf: 'football/leagues/college-football', ncaab: 'basketball/leagues/mens-college-basketball',
};

async function probe(url) {
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(9000) });
    if (!r.ok) return { url, status: r.status, ok: false };
    return { url, status: r.status, ok: true, json: await r.json() };
  } catch (err) {
    return { url, ok: false, error: err.message };
  }
}

export default async function handler(req, res) {
  const league = LEAGUES[req.query.league] ? req.query.league : 'nba';
  const L = LEAGUES[league];
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')
    ? req.query.date.replace(/-/g, '') : null;

  if (!date) {
    res.status(400).json({ error: 'Pass ?league=nba&date=YYYY-MM-DD' });
    return;
  }

  const out = { league, date: req.query.date, leaguePath: L.path, corePath: CORE_PATH[league] };

  // 1. Does the scoreboard list anything for this date?
  const extra = new URLSearchParams({ limit: '500', ...L.query }).toString();
  const sb = await probe(`${SITE}/${L.path}/scoreboard?dates=${date}&${extra}`);
  out.scoreboard = { url: sb.url, status: sb.status ?? null, error: sb.error };

  if (!sb.ok) { res.setHeader('Cache-Control', 'no-store'); res.status(200).json(out); return; }

  const events = sb.json?.events || [];
  const completed = events.filter((e) => e.competitions?.[0]?.status?.type?.completed);
  out.scoreboard.events = events.length;
  out.scoreboard.completed = completed.length;
  out.scoreboard.sample = events.slice(0, 3).map((e) => ({
    id: e.id, name: e.shortName,
    state: e.competitions?.[0]?.status?.type?.name,
    completed: !!e.competitions?.[0]?.status?.type?.completed,
  }));

  if (!completed.length) {
    out.verdict = events.length
      ? 'The scoreboard has games for this date but none are finished. Pick an earlier date.'
      : 'The scoreboard lists no games at all for this date. Check that the season was running.';
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(out);
    return;
  }

  // 2. Does the predictor have anything for a finished game?
  const id = completed[0].id;
  const pr = await probe(`${CORE}/${CORE_PATH[league]}/events/${id}/competitions/${id}/predictor`);
  out.predictor = { eventId: id, url: pr.url, status: pr.status ?? null, error: pr.error };

  if (!pr.ok) {
    out.verdict = pr.status === 404
      ? `The predictor endpoint 404s for finished ${league} games, so ESPN has no retained projection to backtest against.`
      : `The predictor endpoint failed (${pr.status ?? pr.error}).`;
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(out);
    return;
  }

  // 3. It responded - but does it carry the stat the backtest reads?
  const names = (side) => (pr.json?.[side]?.statistics || []).map((s) => ({
    name: s.name, value: s.value,
  }));
  out.predictor.homeStats = names('homeTeam');
  out.predictor.awayStats = names('awayTeam');
  out.predictor.topLevelKeys = Object.keys(pr.json || {});

  const has = (side) => (pr.json?.[side]?.statistics || [])
    .some((x) => (x.name || '').toLowerCase() === 'gameprojection');
  out.predictor.hasGameProjection = { home: has('homeTeam'), away: has('awayTeam') };

  out.verdict = out.predictor.hasGameProjection.home
    ? 'Everything the backtest needs is present for this date.'
    : 'The predictor responded but carries no gameProjection stat, which is the one the backtest '
      + 'reads. See homeStats for the names it does return.';

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(out);
}
