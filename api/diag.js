// GET /api/diag - probes candidate schedule sources from the Vercel runtime and
// reports what each returns. Temporary: used to pick a working upstream.

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const TARGETS = [
  ['espn-site-browserUA', 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20260913',
    { 'User-Agent': BROWSER_UA, Accept: 'application/json', Referer: 'https://www.espn.com/' }],
  ['espn-site-noUA', 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20260913', {}],
  ['espn-cdn-core', 'https://cdn.espn.com/core/nfl/schedule?xhr=1&year=2026&week=1',
    { 'User-Agent': BROWSER_UA, Accept: 'application/json' }],
  ['espn-web-api', 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20260913',
    { 'User-Agent': BROWSER_UA, Accept: 'application/json' }],
  ['espn-core-api', 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/2026/types/2/weeks/1/events',
    { 'User-Agent': BROWSER_UA, Accept: 'application/json' }],
  ['nhl-official', 'https://api-web.nhle.com/v1/schedule/2026-10-06', { 'User-Agent': BROWSER_UA }],
  ['nhl-stats', 'https://api.nhle.com/stats/rest/en/team', { 'User-Agent': BROWSER_UA }],
  ['nba-cdn', 'https://cdn.nba.com/static/json/staticData/scheduleLeagueV2_1.json',
    { 'User-Agent': BROWSER_UA, Referer: 'https://www.nba.com/' }],
  ['ncaa-scoreboard', 'https://data.ncaa.com/casablanca/scoreboard/football/fbs/2026/01/scoreboard.json',
    { 'User-Agent': BROWSER_UA }],
  ['ncaa-sched', 'https://ncaa-api.henrygd.me/scoreboard/football/fbs/2026/01', { 'User-Agent': BROWSER_UA }],
];

export default async function handler(req, res) {
  const results = await Promise.all(TARGETS.map(async ([name, url, headers]) => {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(9000) });
      const body = await r.text();
      let events = null;
      try {
        const j = JSON.parse(body);
        events = Array.isArray(j.events) ? j.events.length
          : Array.isArray(j.gameWeek) ? j.gameWeek.length
          : Array.isArray(j.games) ? j.games.length
          : Array.isArray(j.items) ? j.items.length
          : j.leagueSchedule?.gameDates?.length ?? null;
      } catch { /* not JSON */ }
      return { name, status: r.status, ms: Date.now() - t0, bytes: body.length, events,
        snippet: body.slice(0, 90) };
    } catch (err) {
      return { name, status: 'ERR', ms: Date.now() - t0, error: err.message };
    }
  }));
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ region: process.env.VERCEL_REGION, results });
}
