// Which college football teams are FBS.
//
// ESPN's groups=80 filter means "involving an FBS team" on the scoreboard, so an
// FBS side hosting an FCS opponent still comes back. To exclude those we need the
// FBS roster itself and a check that BOTH sides are in it.
//
// Two traps found the hard way:
//   - the site teams endpoint ignores groups= entirely and returns 759 teams,
//     i.e. all of college football, which silently matches everything;
//   - team.conferenceId on a scoreboard competitor is the *game's* conference,
//     so an FCS visitor is tagged with its FBS host's conference and looks FBS.
//
// The core API's group-80 teams collection is the one that actually filters. It
// returns ~148 $ref URLs with the team id embedded, so no per-team fetch needed.
//
// (FCS is also Division I; "FBS only" is the distinction that matters here.)

const CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football';

// A real FBS roster is ~134 teams; ESPN's group includes a few extras. Anything
// far outside this band means the shape changed and the filter must stand down.
const MIN_TEAMS = 100;
const MAX_TEAMS = 250;
const TTL = 12 * 60 * 60 * 1000;

let cache = null;
let cachedAt = 0;
export let lastError = null;

async function getJSON(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
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
    const j = await getJSON(`${CORE}/seasons/${season}/types/2/groups/80/teams?limit=300`);
    const ids = new Set();
    for (const item of j?.items || []) {
      const m = /\/teams\/(\d+)/.exec(item?.$ref || '');
      if (m) ids.add(m[1]);
    }
    if (ids.size < MIN_TEAMS || ids.size > MAX_TEAMS) {
      throw new Error(`got ${ids.size} teams, outside the plausible FBS range`);
    }
    cache = ids;
    cachedAt = Date.now();
    lastError = null;
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
