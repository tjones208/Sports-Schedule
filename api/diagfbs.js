// GET /api/diagfbs - settle which source actually identifies FBS membership.
const J = async (u) => {
  try {
    const r = await fetch(u, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    return { status: r.status, json: await r.json().catch(() => null) };
  } catch (e) { return { status: 'ERR', error: e.message }; }
};
// Aug 29 slate: FCS = Sacramento St (16), N Dakota St (2449). Rest are FBS.
const PROBE = { 16: 'SacSt(FCS)', 2449: 'NDSU(FCS)', 55: 'JaxSt', 2199: 'EMU', 52: 'FSU',
  30: 'USC', 2439: 'UNLV', 166: 'NMSU', 153: 'UNC', 23: 'SJSU', 62: 'Hawaii', 87: 'NotreDame' };

export default async function handler(req, res) {
  const yr = req.query.year || '2026';
  const out = {};

  // Source 1: standings tree for group 80 (conference members)
  const st = await J(`https://site.api.espn.com/apis/v2/sports/football/college-football/standings?season=${yr}&group=80`);
  const stIds = new Set();
  for (const conf of st.json?.children || []) {
    for (const e of conf?.standings?.entries || []) {
      if (e?.team?.id) stIds.add(String(e.team.id));
    }
  }
  out.standings = { n: stIds.size, membership: Object.fromEntries(
    Object.entries(PROBE).map(([id, nm]) => [nm, stIds.has(id)])) };

  // Source 2: each FBS conference's own team list, via group 80's children
  const kids = await J(`https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/${yr}/types/2/groups/80/children?limit=50`);
  const confIds = new Set();
  const confNames = [];
  for (const item of (kids.json?.items || [])) {
    const d = await J(item.$ref.replace('http://', 'https://'));
    confNames.push(d.json?.name);
    const t = await J(`${item.$ref.replace('http://', 'https://').split('?')[0]}/teams?limit=100`);
    for (const ti of t.json?.items || []) {
      const m = /\/teams\/(\d+)/.exec(ti?.$ref || '');
      if (m) confIds.add(m[1]);
    }
  }
  out.conferenceRollup = { n: confIds.size, conferences: confNames,
    membership: Object.fromEntries(Object.entries(PROBE).map(([id, nm]) => [nm, confIds.has(id)])) };

  // Source 3: what a team's own record says about its group
  for (const id of ['16', '2199']) {
    const d = await J(`https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/${yr}/teams/${id}`);
    out[`team_${id}`] = { name: d.json?.displayName, keys: d.json ? Object.keys(d.json).filter((k) => /group|conf|division/i.test(k)) : null,
      groups: d.json?.groups?.$ref, isAllStar: d.json?.isAllStar };
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(out);
}
