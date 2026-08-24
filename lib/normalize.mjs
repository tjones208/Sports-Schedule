// Turns a raw ESPN scoreboard event into the flat shape the app consumes.
// Kept separate from the fetcher so it can be unit-tested without network access.

import { toMountain } from './time.mjs';
import { extractOdds, fairProbabilities } from './odds.mjs';

/**
 * Pull the network(s) a game airs on. ESPN scatters this across two shapes;
 * geoBroadcasts is richer (national vs. local) so it wins when present.
 */
export function extractNetworks(competition) {
  const names = new Set();
  let national = false;

  for (const gb of competition.geoBroadcasts ?? []) {
    const name = gb.media?.shortName || gb.media?.callLetters;
    if (name) names.add(name.trim());
    if (gb.market?.type === 'National') national = true;
  }
  for (const b of competition.broadcasts ?? []) {
    for (const n of b.names ?? []) if (n) names.add(String(n).trim());
    if (b.market === 'national') national = true;
  }

  return { networks: [...names], national };
}

export function extractTeam(competitor) {
  const t = competitor?.team ?? {};
  return {
    id: t.id ?? null,
    name: t.displayName || t.name || 'TBD',
    location: t.location || null,
    short: t.shortDisplayName || t.abbreviation || t.name || 'TBD',
    abbrev: t.abbreviation || null,
    logo: t.logo || null,
    color: t.color ? `#${t.color}` : null,
    rank: competitor?.curatedRank?.current && competitor.curatedRank.current <= 25
      ? competitor.curatedRank.current
      : null,
    record: competitor?.records?.[0]?.summary ?? null,
  };
}

export function normalizeEvent(event, league, tzMode = 'denver', devigMethod = 'multiplicative') {
  const comp = event.competitions?.[0];
  if (!comp) return null;

  const home = comp.competitors?.find((c) => c.homeAway === 'home');
  const away = comp.competitors?.find((c) => c.homeAway === 'away');
  if (!home || !away) return null;

  const mt = toMountain(event.date, tzMode);
  if (!mt) return null;

  const { networks, national } = extractNetworks(comp);
  const odds = extractOdds(comp);
  const fair = fairProbabilities(odds, league.id, devigMethod);
  // ESPN marks unscheduled tip/kick times as midnight UTC-ish with status TBD.
  const timeTBD = comp.status?.type?.name === 'STATUS_SCHEDULED' && comp.timeValid === false;

  return {
    id: `${league.id}-${event.id}`,
    league: league.id,
    leagueName: league.name,
    season: league.season,
    startUTC: event.date,
    date: mt.date,
    time: timeTBD ? 'TBD' : mt.time,
    tz: mt.tz,
    weekday: mt.weekday,
    sortKey: timeTBD ? 9999 : mt.minuteOfDay,
    timeTBD,
    home: extractTeam(home),
    away: extractTeam(away),
    networks,
    national,
    venue: {
      name: comp.venue?.fullName ?? null,
      city: comp.venue?.address?.city ?? null,
      state: comp.venue?.address?.state ?? null,
    },
    neutralSite: Boolean(comp.neutralSite),
    odds,
    fair,
    week: event.week?.number ?? null,
    seasonType: event.season?.slug ?? null,
    notes: comp.notes?.[0]?.headline ?? null,
  };
}

