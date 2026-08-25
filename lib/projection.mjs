/* ESPN's pregame win projection, from whichever endpoint actually serves it.
 *
 * Two endpoints carry the same number in different shapes, and which one
 * answers depends on the sport:
 *
 *   site summary   site.api.espn.com/.../summary?event=ID
 *                  -> { predictor: { homeTeam: { gameProjection: "67.3" } } }
 *                  Values are STRINGS. This block rides along with a request
 *                  the backtest already makes for the box score.
 *
 *   core predictor sports.core.api.espn.com/.../events/ID/competitions/ID/predictor
 *                  -> { homeTeam: { statistics: [{ name, value }] } }
 *                  Values are NUMBERS.
 *
 * The core endpoint is the one the app used originally, and it is well covered
 * for football. Rather than decide per sport which to trust - a guess that has
 * already been wrong once - both are tried and whichever answers is reported,
 * so the source is visible instead of assumed.
 *
 * The model behind the number is FPI for football and BPI for basketball; the
 * field name happens to be gameProjection in both.
 */

const num = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** Percentages (67.3) and fractions (0.673) both appear; normalise to 0..1. */
const asProb = (v) => {
  const n = num(v);
  if (n == null) return null;
  const p = n > 1 ? n / 100 : n;
  return p >= 0 && p <= 1 ? p : null;
};

const PROJECTION_FIELDS = ['gameProjection', 'gameWinProbability', 'winProbability'];

/** Core API shape: a statistics array of { name, value }. */
function fromStatistics(stats) {
  const list = stats || [];
  for (const want of PROJECTION_FIELDS) {
    const hit = list.find((x) => (x.name || '').toLowerCase() === want.toLowerCase());
    if (hit != null && num(hit.value) != null) return { p: asProb(hit.value), stat: hit.name };
  }
  const loose = list.find((x) => /projection|winprob/i.test(x.name || '') && num(x.value) != null);
  return loose ? { p: asProb(loose.value), stat: loose.name } : null;
}

/** Site summary shape: a flat object of string-valued fields. */
function fromPredictorTeam(team) {
  if (!team) return null;
  for (const want of PROJECTION_FIELDS) {
    if (team[want] != null && num(team[want]) != null) {
      return { p: asProb(team[want]), stat: want };
    }
  }
  return null;
}

const stat = (v) => (v ? v.stat : null);
const prob = (v) => (v && v.p != null ? v.p : null);

/** Read a projection out of a site `summary?event=` response. */
export function fromSummary(summary) {
  const pred = summary?.predictor;
  if (!pred) return null;
  let home = fromPredictorTeam(pred.homeTeam);
  let away = fromPredictorTeam(pred.awayTeam);

  // Only one side is sometimes populated; the other is its complement, and
  // teamChanceLoss carries it explicitly when present.
  if (!home && pred.homeTeam?.teamChanceLoss != null) {
    const loss = asProb(pred.homeTeam.teamChanceLoss);
    if (loss != null) home = { p: 1 - loss, stat: 'teamChanceLoss' };
  }
  if (!away && pred.awayTeam?.teamChanceLoss != null) {
    const loss = asProb(pred.awayTeam.teamChanceLoss);
    if (loss != null) away = { p: 1 - loss, stat: 'teamChanceLoss' };
  }
  if (!home && away) home = { p: 1 - away.p, stat: `${away.stat} (complement)` };
  if (!away && home) away = { p: 1 - home.p, stat: `${home.stat} (complement)` };
  if (!home && !away) return null;

  return { homeWin: prob(home), awayWin: prob(away),
    source: 'summary', stat: stat(home) || stat(away) };
}

/** Read a projection out of a core API `predictor` response. */
export function fromCorePredictor(json) {
  if (!json) return null;
  const home = fromStatistics(json?.homeTeam?.statistics);
  const away = fromStatistics(json?.awayTeam?.statistics);
  if (!home && !away) return null;
  return {
    homeWin: prob(home) ?? (prob(away) == null ? null : 1 - prob(away)),
    awayWin: prob(away) ?? (prob(home) == null ? null : 1 - prob(home)),
    source: 'core',
    stat: stat(home) || stat(away),
    // Extra detail the core endpoint carries and the summary block does not.
    predPointDiff: (() => {
      const s = (json?.homeTeam?.statistics || [])
        .find((x) => (x.name || '').toLowerCase() === 'teampredptdiff');
      return s ? num(s.value) : null;
    })(),
    matchupQuality: (() => {
      const s = (json?.homeTeam?.statistics || [])
        .find((x) => (x.name || '').toLowerCase() === 'matchupquality');
      return s ? num(s.value) : null;
    })(),
  };
}

/**
 * Fetch a projection for one event, trying both endpoints.
 *
 * `preloadedSummary` lets a caller that already fetched the summary (the
 * backtest does, for the box score) skip a redundant request.
 */
export async function fetchProjection(
  { sitePath, corePath, id, fetchJSON, preloadedSummary = null },
) {
  if (preloadedSummary) {
    const hit = fromSummary(preloadedSummary);
    if (hit) return { id, ...hit };
  }

  let coreErr = null;
  try {
    const j = await fetchJSON(
      `https://sports.core.api.espn.com/v2/sports/${corePath}/events/${id}/competitions/${id}/predictor`);
    const hit = fromCorePredictor(j);
    if (hit) return { id, ...hit };
  } catch (err) { coreErr = err.message; }

  if (!preloadedSummary) {
    try {
      const j = await fetchJSON(
        `https://site.api.espn.com/apis/site/v2/sports/${sitePath}/summary?event=${id}`);
      const hit = fromSummary(j);
      if (hit) return { id, ...hit };
    } catch { /* both endpoints are out of options */ }
  }

  return { id, homeWin: null, awayWin: null, source: null, stat: null, coreErr };
}
