# Sports Schedule

A board of the upcoming **NFL, NBA, NHL, college football and college basketball**
seasons, with every start time in **Mountain time** and the **broadcast network**
on each game.

**Live:** https://sports-schedule-buckhorn1.vercel.app

Schedules come from ESPN at request time through a serverless function, so the
board is always current - there is no data file to regenerate.

## How it works

```
public/            the board (static HTML, CSS, JS - no build step)
api/schedule.js    fetches a league's season from ESPN, converts to Mountain time
api/leagues.js     the league catalogue
lib/               shared modules, used by both the API and the CLI fetcher
```

The browser asks `/api/schedule?league=nfl` for each league in parallel and paints
each one as it arrives. The function requests ESPN in 30-day windows - a full NFL
season is 9 upstream requests in about 175 ms - and the response is cached at the
Vercel edge for six hours, so ESPN sees roughly one request per league per window.

### Endpoints

```
GET /api/leagues
GET /api/schedule?league=nfl
GET /api/schedule?league=ncaab&start=2026-11-01&end=2026-11-30
GET /api/schedule?league=nhl&tz=mst          # strict UTC-7 instead of local Mountain
GET /api/schedule?league=nfl&debug=1         # upstream request count and timing

GET /api/kalshi?series=KXNFLGAME             # open events + market prices
GET /api/kalshi?tickers=TICKER1,TICKER2      # prices for specific markets
```

Schedule responses include `odds` (the sportsbook line) and `fair` (vig-free win
probabilities) when ESPN has published a line for the game.

| League | key | Season |
| --- | --- | --- |
| NFL | `nfl` | 2026 |
| NBA | `nba` | 2026-27 |
| NHL | `nhl` | 2026-27 |
| College football (FBS) | `ncaaf` | 2026 |
| College basketball (D-I) | `ncaab` | 2026-27 |

### One thing worth knowing about ESPN

ESPN's edge returns **403 to custom and spoofed browser User-Agents from
datacenter IPs**. Sending no `User-Agent` override works. That single header was
the difference between every request failing and every request succeeding, so
don't "helpfully" add one back.

## Running it

```bash
npm start        # board on http://localhost:8080, using the sample fixture
npx vercel dev   # board + live API locally
npm test         # parsing tests
```

`npm start` serves the static board only. With no API behind it the board falls
back to `public/data/demo.json`, a small clearly-labelled sample set, and says so
on screen. Use `vercel dev` when you want live schedules locally.

### Pulling to files instead

If you want the seasons as JSON on disk rather than through the API:

```bash
npm run fetch                                   # all five leagues -> public/data
npm run fetch:mst                               # strict UTC-7 instead of local
node scripts/fetch-schedules.mjs --league nfl,nba
node scripts/fetch-schedules.mjs --start 2026-11-01 --end 2026-11-30
```

This needs direct network access to ESPN, so it will not work from a machine whose
egress is restricted - use the deployed API in that case.

## The board

- Filter by league, network or date; search across teams, networks and venues
- **On TV** narrows to games with a listed broadcast
- Star teams to follow them, then filter to **My teams** (saved in your browser)
- Export the filtered view to a `.ics` calendar file
- Games with no announced broadcast show as *Not announced* rather than hidden
- Pages in as you scroll, so full seasons stay responsive
- Light and dark themes; press `/` to jump to search

### One-file build

```bash
node scripts/build-standalone.mjs      # dist/sports-schedule.html, data inlined
node scripts/build-standalone.mjs --fragment
```

## Prediction desk

`/predict.html` is a Kalshi-oriented desk for tracking sports predictions against a
bankroll. It is **read-only against Kalshi** - it never authenticates, never holds
an API key, and never places an order. You trade on Kalshi yourself; this tracks it.

**Edges** joins three sources per game: the ESPN schedule, the sportsbook line ESPN
carries (DraftKings), and the open Kalshi market. It strips the vig from the book's
two-way price to get a fair probability, compares that to the Kalshi ask, and sizes
a stake with fractional Kelly.

- Fair probability prefers the moneyline, falling back to a normal model of the
  point spread when no moneyline is posted yet
- Kalshi events are matched to games by the ticker's `AWAY+HOME` abbreviation pair
  (`KXNFLGAME-26SEP13TBCIN`), with city names as a fallback
- Stakes default to quarter Kelly, capped at 5% of bankroll per position

**Positions** tracks what you took, marks it to the live Kalshi bid, and settles it
won or lost. **Performance** reports record, ROI on stake, P&L by league, and a
calibration table - whether contracts you bought near 60c actually won about 60% of
the time.

Everything is stored in your browser's localStorage. Nothing is sent to a server,
which also means clearing site data loses it - export from Settings to keep a backup.

### What it does not do

It does not predict outcomes. The "edge" it shows is a disagreement between two
markets, which is a starting point for research, not a signal. Kalshi charges
trading fees that a small nominal edge will not cover, and the book line it compares
against is itself an estimate. Size accordingly.

## A note on "MST"

Mountain time is **MDT (UTC-6)** during daylight saving and **MST (UTC-7)** the
rest of the year, and the switch lands on **1 November 2026** - part-way through
every season here. A single fixed offset would be wrong on one side of that date.

The default converts to true Mountain local time and labels each game `MDT` or
`MST`. Pass `tz=mst` (or `npm run fetch:mst`) to force strict UTC-7 year round.

## Caveats

- **College basketball is genuinely incomplete this far out.** As of late August
  2026 ESPN lists about 330 D-I games for November with almost no tip times or
  networks assigned. That is the real state of the schedule, not a bug - the
  numbers fill in through September and October. Football and the pro leagues are
  complete.
- ESPN marks nearly every broadcast `national`, including ESPN+, so that flag is
  not a useful filter. **On TV** filters on whether a network is listed at all.
- ESPN revises times and networks; the six-hour edge cache is the refresh window.
- College football is FBS only (`groups=80`); change it in `lib/leagues.mjs` for
  all divisions.

## Tests

```bash
npm test
```

Covers Mountain-time conversion on both sides of the daylight-saving switch,
network extraction from both ESPN response shapes, AP rankings, neutral sites, TBD
tip times, and malformed events.
