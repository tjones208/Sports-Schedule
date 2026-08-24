// League definitions for the upcoming (2026 / 2026-27) seasons.
// Date windows are padded a few days on each end so nothing at the edges is missed.

export const LEAGUES = {
  nfl: {
    id: 'nfl',
    name: 'NFL',
    longName: 'National Football League',
    path: 'football/nfl',
    season: '2026',
    start: '2026-09-09',
    end: '2027-02-08',
    // NFL plays on a handful of weekdays; scanning every day is cheap enough (153 days)
    query: {},
  },
  nba: {
    id: 'nba',
    name: 'NBA',
    longName: 'National Basketball Association',
    path: 'basketball/nba',
    season: '2026-27',
    start: '2026-10-20',
    end: '2027-06-25',
    query: {},
  },
  nhl: {
    id: 'nhl',
    name: 'NHL',
    longName: 'National Hockey League',
    path: 'hockey/nhl',
    season: '2026-27',
    start: '2026-10-06',
    end: '2027-06-25',
    query: {},
  },
  ncaaf: {
    id: 'ncaaf',
    name: 'College Football',
    longName: 'NCAA Football (FBS)',
    path: 'football/college-football',
    season: '2026',
    start: '2026-08-22',
    end: '2027-01-20',
    // groups=80 -> FBS only. Use groups=90 for all divisions.
    query: { groups: '80' },
  },
  ncaab: {
    id: 'ncaab',
    name: 'College Basketball',
    longName: "NCAA Men's Basketball (Division I)",
    path: 'basketball/mens-college-basketball',
    season: '2026-27',
    start: '2026-11-02',
    end: '2027-04-06',
    // groups=50 -> Division I
    query: { groups: '50' },
  },
};

export const LEAGUE_IDS = Object.keys(LEAGUES);
