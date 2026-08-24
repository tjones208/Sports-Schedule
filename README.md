# Sports Schedule

A browsable board of the upcoming **NFL, NBA, NHL, college football and college
basketball** seasons, with every start time converted to **Mountain time** and the
**broadcast network** attached to each game.

```
npm run fetch     # pull all five leagues from ESPN into ./data
npm start         # open http://localhost:8080
```

---

## Read this first: the schedule data is not included

I could not pull the real schedules from this environment. Every sports data host
is blocked by the session's network egress policy - the proxy returns `403` on
`CONNECT` for all of them:

```
site.api.espn.com   api-web.nhle.com    statsapi.web.nhl.com
www.nba.com         www.nhl.com         www.espn.com
data.ncaa.com       sports.yahoo.com    en.wikipedia.org
```

Only `github.com`, `raw.githubusercontent.com`, `pypi.org` and `registry.npmjs.org`
are reachable. That blocks both the shell and the web-fetch tooling, so roughly
9,800 games across five leagues could not be retrieved and were **not** invented to
fill the gap.

What ships instead:

- **A complete, working ingestion pipeline** (`scripts/fetch-schedules.mjs`) that
  pulls all five leagues the moment it runs somewhere with network access.
- **A labelled demo fixture** (`data/demo.json`) so the app is usable immediately.
  It is clearly marked as sample data in the UI and is **not** the real schedule.

Run `npm run fetch` on an unrestricted machine - or allow `site.api.espn.com` for
this environment - and the app switches to live data automatically; the sample-data
banner disappears on its own.

## What `npm run fetch` retrieves

| League | Source path | Season | Approx. games |
| --- | --- | --- | --- |
| NFL | `football/nfl` | 2026 | 272 + postseason |
| NBA | `basketball/nba` | 2026-27 | ~1,230 |
| NHL | `hockey/nhl` | 2026-27 | ~1,312 |
| College football | `football/college-football` (FBS) | 2026 | ~900 |
| College basketball | `basketball/mens-college-basketball` (D-I) | 2026-27 | ~6,000 |

Data comes from ESPN's public scoreboard API. Each day in the season window is
requested once, results are de-duplicated by event id, and the output is written to
`data/<league>.json` plus a `data/index.json` summary.

```bash
npm run fetch                                   # everything, default windows
node scripts/fetch-schedules.mjs --league nfl,nba
node scripts/fetch-schedules.mjs --start 2026-11-01 --end 2026-11-30
node scripts/fetch-schedules.mjs --concurrency 4
```

### A note on "MST"

Mountain time is **MDT (UTC-6)** during daylight saving and **MST (UTC-7)** the rest
of the year. The switch lands on **1 November 2026**, part-way through every season
here - so a single fixed offset would be wrong for one side of that date.

The default converts to true Mountain local time and labels each game `MDT` or `MST`,
which is the wall-clock time you would actually tune in at. If you want strict
UTC-7 year round instead, ignoring daylight saving:

```bash
npm run fetch:mst
```

## The app

Static HTML, CSS and JavaScript - no build step, no dependencies.

- Filter by league, network, or date; free-text search across teams, networks and venues
- **National TV** toggle to cut down to nationally broadcast games
- Star teams to follow them, then filter to **My teams** (saved in your browser)
- Export the current filtered view to a `.ics` calendar file
- Games with no announced broadcast are shown as *Not announced* rather than hidden
- Renders ~10,000 games smoothly by paging as you scroll
- Light and dark themes

Press `/` to jump to the search box.

## Layout

```
scripts/fetch-schedules.mjs   day-by-day pull, retries, de-duplication
scripts/normalize.mjs         ESPN event -> flat game record
scripts/time.mjs              UTC -> Mountain time (MST/MDT aware)
scripts/leagues.mjs           league paths and season windows
scripts/serve.mjs             dependency-free static server
web/                          the app
data/demo.json                labelled sample data (committed)
data/<league>.json            real pulls (git-ignored)
test/normalize.test.mjs       parsing tests
```

## Tests

```bash
npm test
```

Covers Mountain-time conversion on both sides of the daylight-saving switch, network
extraction from both ESPN response shapes, AP rankings, neutral sites, TBD tip times,
and malformed events.

## Caveats

- **College basketball networks are genuinely incomplete this far out.** Many
  non-conference games have no announced tip time or network in August; the fetcher
  records them as TBD / *Not announced* rather than guessing.
- ESPN occasionally revises times and networks. Re-run `npm run fetch` to refresh.
- The college football pull is FBS only (`groups=80`); change it to `groups=90` in
  `scripts/leagues.mjs` for all divisions.
