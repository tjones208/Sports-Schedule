// GET /api/diagfbs - find an endpoint that actually returns just FBS.
const J = async (u) => {
  try {
    const r = await fetch(u, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    return { status: r.status, json: await r.json().catch(() => null) };
  } catch (e) { return { status: 'ERR', error: e.message }; }
};

export default async function handler(req, res) {
  const out = {};
  const yr = req.query.year || '2026';

  // A: the site teams endpoint (known to ignore groups)
  const a = await J(`https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams?groups=80&limit=1000`);
  out.A_siteTeams = { status: a.status, n: a.json?.sports?.[0]?.leagues?.[0]?.teams?.length };

  // B: core API group 80 teams
  const b = await J(`https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/${yr}/types/2/groups/80/teams?limit=300`);
  out.B_coreGroupTeams = { status: b.status, count: b.json?.count, items: b.json?.items?.length,
    sample: b.json?.items?.slice(0, 2).map((i) => i.$ref) };

  // C: group 80's child conferences
  const c = await J(`https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/${yr}/types/2/groups/80/children?limit=50`);
  out.C_coreChildren = { status: c.status, count: c.json?.count, items: c.json?.items?.length };

  // D: standings tree for group 80
  const d = await J(`https://site.api.espn.com/apis/v2/sports/football/college-football/standings?season=${yr}&group=80`);
  const kids = d.json?.children || [];
  out.D_standings = { status: d.status, conferences: kids.length,
    teams: kids.reduce((s, k) => s + (k?.standings?.entries?.length || 0), 0),
    confNames: kids.slice(0, 4).map((k) => k.name) };

  // E: does the scoreboard itself tag a competitor's division?
  const e = await J('https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates=20260829&groups=80&limit=20');
  const ev = (e.json?.events || []).find((x) => /Sacramento/i.test(JSON.stringify(x.competitions?.[0]?.competitors || [])));
  out.E_scoreboardTeamKeys = {
    status: e.status,
    teamKeys: ev ? Object.keys(ev.competitions[0].competitors[0].team) : null,
    sides: ev ? ev.competitions[0].competitors.map((c) => ({
      name: c.team?.displayName, id: c.team?.id,
      conferenceId: c.team?.conferenceId, isActive: c.team?.isActive,
    })) : null,
    groupsOnEvent: ev?.competitions?.[0]?.groups || null,
  };

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(out);
}
