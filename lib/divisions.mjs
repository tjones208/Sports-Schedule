// Which college football teams are FBS.
//
// ESPN's groups=80 filter means "involving an FBS team" on the scoreboard, so an
// FBS side hosting an FCS opponent still comes back. Excluding those needs the
// FBS roster itself and a check that BOTH sides are in it.
//
// Getting that roster is fiddlier than it looks. Two sources that seem right are
// not:
//   - the site teams endpoint ignores groups= and returns ~759 teams, i.e. all
//     of college football, so every id matches and nothing is filtered;
//   - team.conferenceId on a scoreboard competitor is the conference of the
//     *game*, so a visitor is tagged with its host's conference.
//
// What works is walking group 80's child conferences and unioning their team
// lists. For 2026 that yields 138 teams, which matches the published FBS count
// after Sacramento State (MAC) and North Dakota State (Mountain West) completed
// their moves up from FCS.
//
// (FCS is also Division I; "FBS only" is the distinction that matters here.)

const CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football';

// FBS is ~134-140 teams. Far outside that band means the shape changed and the
// filter must stand down rather than silently empty the board.
const MIN_TEAMS = 110;
const MAX_TEAMS = 180;
const TTL = 12 * 60 * 60 * 1000;

let cache = null;
let cachedAt = 0;
export let lastError = null;
export let lastCount = null;

async function getJSON(url) {
  const r = await fetch(url.replace('http://', 'https://'), {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/**
 * @param {string|number} season
 * @returns {Promise<Set<string>|null>} FBS team ids, or null if unavailable.
 */
export async function getFbsTeamIds(season = new Date().getUTCFullYear()) {
  if (cache && Date.now() - cachedAt < TTL) return cache;
  try {
    const kids = await getJSON(`${CORE}/seasons/${season}/types/2/groups/80/children?limit=50`);
    const refs = (kids?.items || []).map((i) => i?.$ref).filter(Boolean);
    if (!refs.length) throw new Error('no FBS conferences returned');

    const lists = await Promise.all(refs.map(async (ref) => {
      try {
        const j = await getJSON(`${ref.split('?')[0]}/teams?limit=100`);
        return (j?.items || []).map((t) => /\/teams\/(\d+)/.exec(t?.$ref || '')?.[1]).filter(Boolean);
      } catch { return []; }
    }));

    const ids = new Set(lists.flat());
    if (ids.size < MIN_TEAMS || ids.size > MAX_TEAMS) {
      throw new Error(`got ${ids.size} teams, outside the plausible FBS range`);
    }
    cache = ids;
    cachedAt = Date.now();
    lastError = null;
    lastCount = ids.size;
    return ids;
  } catch (err) {
    lastError = err.message;
    return cache || null;   // fail open rather than empty the board
  }
}

/** True when both competitors are FBS. Unknown ids fail closed to `true`. */
export function isFbsMatchup(competition, fbsIds) {
  if (!fbsIds) return true;
  const ids = (competition?.competitors || [])
    .map((c) => String(c?.team?.id || ''))
    .filter(Boolean);
  if (ids.length < 2) return true;
  return ids.every((id) => fbsIds.has(id));
}
