// GET /api/diag3 - compact probe of ESPN predictive endpoints.
const CORE = 'https://sports.core.api.espn.com/v2/sports';
const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const J = async (u) => {
  try {
    const r = await fetch(u, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(9000) });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, json: j, bytes: t.length, snip: t.slice(0, 200) };
  } catch (e) { return { status: 'ERR', error: e.message }; }
};

export default async function handler(req, res) {
  const out = {};

  // Find a real upcoming NFL event id to probe against
  const sb = await J(`${SITE}/football/nfl/scoreboard?dates=20260913&limit=3`);
  const ev = sb.json?.events?.[0];
  const id = ev?.id;
  out.event = { id, name: ev?.shortName };

  if (id) {
    const pred = await J(`${CORE}/football/leagues/nfl/events/${id}/competitions/${id}/predictor`);
    out.predictor = { status: pred.status, bytes: pred.bytes,
      keys: pred.json ? Object.keys(pred.json) : null,
      homeProj: pred.json?.homeTeam?.gameProjection,
      awayProj: pred.json?.awayTeam?.gameProjection,
      homeKeys: pred.json?.homeTeam ? Object.keys(pred.json.homeTeam) : null,
      snip: pred.snip };

    const pow = await J(`${CORE}/football/leagues/nfl/events/${id}/competitions/${id}/powerindex`);
    out.powerindex = { status: pow.status, count: pow.json?.count, snip: pow.snip?.slice(0,150) };

    const odds = await J(`${CORE}/football/leagues/nfl/events/${id}/competitions/${id}/odds`);
    const o0 = odds.json?.items?.[0];
    out.coreOdds = { status: odds.status, count: odds.json?.count,
      provider: o0?.provider?.name, keys: o0 ? Object.keys(o0).slice(0,18) : null };
  }

  // Standings + team-level FPI
  const st = await J(`${SITE}/football/nfl/standings`);
  out.standings = { status: st.status, bytes: st.bytes, keys: st.json ? Object.keys(st.json) : null };

  const fpi = await J(`${CORE}/football/leagues/nfl/seasons/2025/types/2/teams/12/statistics`);
  out.teamStats2025 = { status: fpi.status, bytes: fpi.bytes,
    cats: fpi.json?.splits?.categories?.map((c) => c.name)?.slice(0, 12) };

  // Injuries
  const inj = await J(`${SITE}/football/nfl/injuries`);
  out.injuries = { status: inj.status, bytes: inj.bytes,
    n: inj.json?.injuries?.length,
    sample: inj.json?.injuries?.[0]?.injuries?.slice(0,2)?.map((x) => ({
      athlete: x.athlete?.displayName, status: x.status })) };

  // Prior-season results, for building ratings from scratch
  const past = await J(`${SITE}/football/nfl/scoreboard?dates=20251207&limit=20`);
  const pe = past.json?.events?.[0];
  out.pastScores = { status: past.status, n: past.json?.events?.length,
    sample: pe ? { name: pe.shortName, completed: pe.status?.type?.completed,
      scores: pe.competitions?.[0]?.competitors?.map((c) => `${c.team?.abbreviation} ${c.score}`) } : null };

  // Venue coordinates, for travel distance
  const venue = ev?.competitions?.[0]?.venue;
  out.venue = { name: venue?.fullName, hasCoords: Boolean(venue?.address?.city), keys: venue ? Object.keys(venue) : null };

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(out);
}
