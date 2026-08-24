// Which college football teams are FBS.
//
// ESPN's groups=80 filter returns games *involving* an FBS team, so an FBS team
// hosting an FCS opponent still comes back. That is how Sacramento State - an
// FCS program ESPN's FPI rates unreliably - ended up in the desk. To exclude
// those games we need the FBS roster itself and a check that BOTH sides are in
// it.
//
// (FCS is also Division I; "FBS only" is the distinction that matters here.)

const TEAMS = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams?groups=80&limit=1000';

// Cached per lambda instance; the FBS membership list changes once a year.
let cache = null;
let cachedAt = 0;
const TTL = 12 * 60 * 60 * 1000;

/** @returns {Promise<Set<string>|null>} FBS team ids, or null if unavailable. */
export let lastError = null;

export async function getFbsTeamIds() {
  if (cache && Date.now() - cachedAt < TTL) return cache;
  try {
    const r = await fetch(TEAMS, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const teams = j?.sports?.[0]?.leagues?.[0]?.teams || [];
    const ids = new Set(teams.map((t) => String(t?.team?.id)).filter((id) => id && id !== 'undefined'));
    // A suspiciously short list means the shape changed; better to disable the
    // filter than to silently drop most of the slate.
    if (ids.size < 100) throw new Error(`only ${ids.size} FBS teams returned`);
    lastError = null;
    cache = ids;
    cachedAt = Date.now();
    return ids;
  } catch (err) {
    lastError = err.message;
    return cache || null;
  }
}

/** True when both competitors are FBS. Unknown ids fail closed to `true`. */
export function isFbsMatchup(competition, fbsIds) {
  if (!fbsIds) return true;                       // list unavailable - do not filter
  const ids = (competition?.competitors || [])
    .map((c) => String(c?.team?.id || ''))
    .filter(Boolean);
  if (ids.length < 2) return true;
  return ids.every((id) => fbsIds.has(id));
}
