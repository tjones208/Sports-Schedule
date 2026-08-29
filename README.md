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

GET /api/predictor?league=nfl&ids=401872925  # ESPN FPI projections for those games
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

### Refreshing

Schedules are cached at Vercel's edge for six hours, which is right for normal browsing and
wrong on the day a broadcast gets announced. **Refresh** re-pulls with a cache-busting
parameter, so the function goes back to ESPN rather than replaying the cached response.

It then reports what actually moved rather than just claiming success:

> Refreshed - 3 games gained a network, 1 kickoff moved.

or, when nothing has:

> Refreshed - nothing has changed since the last pull.

Filters, the selected league, and starred teams all survive a refresh. A refresh that fails
restores the schedule that was already on screen and says so, rather than leaving an empty
board. The button is hidden in the one-file build, which has no source to re-pull from.

The neighbouring button is **Clear filters** - it resets the six filter controls and nothing
else. It was called *Reset*, which read as though it might clear starred teams too; it never
did, and next to a Refresh button the old name was worse.

### One-file build

```bash
node scripts/build-standalone.mjs      # dist/sports-schedule.html, data inlined
node scripts/build-standalone.mjs --fragment
```

## Historical betting lines (optional)

Backtesting needs an entry price, and nothing keeps one: ESPN drops odds from
completed games, and Kalshi exposes no settled markets at all. The
[CollegeFootballData](https://collegefootballdata.com) API does retain closing
lines. Register for a free key and set it as `CFBD_API_KEY`:

```bash
# locally
export CFBD_API_KEY=...
# on Vercel: Project > Settings > Environment Variables, then redeploy
```

With the key set, `/api/backtest` scores the market alongside ESPN FPI and
reports what a strategy would actually have returned at market prices, instead
of against an assumed one. Without it, the backtest still runs - it just falls
back to the parameterised `pnl` simulation.

Games are joined to the lines by school name, and the response reports the match
rate plus a sample of unmatched games so a naming mismatch is visible rather
than silently shrinking the sample.

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

### Fee-adjusted edge

Kalshi's published schedule charges takers 7% of `contracts x price x (1 - price)`,
rounded up to the cent; makers pay a quarter of that. The curve peaks at **1.75c per
contract at 50c** and falls toward zero at the extremes, so fees bite hardest exactly
where most edges live.

Fees are modelled as a worse entry price. Paying `price + fee` to win `100 - price - fee`
means the breakeven probability is simply the fee-inclusive price, and Kelly sizes
against that same number - so a row can never show a negative edge next to a positive
stake. The table shows net edge with the gross figure underneath, plus the dollar fee on
the recommended order.

A 2-point gross edge at 52c is only 0.25 points net. That is the whole reason this
column exists.

### Second opinion: ESPN's own model

`/api/predictor` returns ESPN's own matchup projection, which is built from team ratings
rather than from the betting line, so it is genuinely independent of the book.

One endpoint serves every sport, but the model behind it is branded differently and the app
names the one it is actually showing:

| Sport | Model |
|---|---|
| NFL, college football | **FPI** - Football Power Index |
| NBA, college basketball | **BPI** - Basketball Power Index |
| NHL | ESPN publishes no branded power index for hockey, so it is labelled plainly |

A view mixing sports is headed with what it contains (`BPI/FPI`).

**Two ESPN endpoints carry this number, in different shapes, and coverage differs by sport:**

| Endpoint | Shape | Notes |
|---|---|---|
| `sports.core.api.espn.com/.../predictor` | `homeTeam.statistics[{name,value}]`, numbers | Well covered for football |
| `site.api.espn.com/.../summary?event=` | `predictor.homeTeam.gameProjection`, **strings** | Rides along with the box score |

`lib/projection.mjs` tries both rather than assuming one, normalises percentages and
fractions alike, derives a missing side from its complement or from `teamChanceLoss`, and
reports which endpoint answered. The backtest reuses the summary it already fetched for the
box score instead of making a second request for the same number.

`/api/predictor` reports `sources` and `statsUsed`. `/api/diag?league=&date=` probes both
endpoints side by side and says which answered, dumping the raw field names each returned -
so a sport ESPN simply does not project is distinguishable from one that labels its
projection differently.

The **Blend** column weights the book and FPI (65/35 by default, adjustable down to
book-only) and is what edge and stake are computed from. When the two disagree by 8
points or more the row is flagged - that disagreement usually means the game is harder
to price than the numbers suggest, and is a reason to size down or skip rather than to
bet bigger.

### Rest days

Days since each team last played, derived from the schedule already loaded. Flagged when
either side is on four days or less, or when the two sides differ by three or more days.

Kalshi lists game markets well before it opens an order book on them. Until then
a market has no bid or ask, so those rows show as *no book* with the sportsbook
probability still visible and the Log button disabled - the join is working, there
is just nothing to price against yet. Quotes typically appear in the days before
kickoff.

### FPI strategy tab

A separate tab that ignores the blend entirely and runs one mechanical rule across
every sport at once:

    buy when the Kalshi ask sits at least N points below ESPN's own FPI price.

**It lists the whole slate.** Every game in the window appears, including ones that cannot
be traded, each carrying the reason:

| Status | Meaning |
|---|---|
| **TRADE** | the ask is at or past the target |
| pass | priced, but too rich |
| no book yet | the market exists, nobody is quoting it - normal until close to kickoff |
| not on Kalshi | no market has been created for this game |
| no FPI / no BPI | ESPN publishes no projection, so there is nothing to price against |

A game missing from a list is indistinguishable from a game that does not exist, so nothing
is dropped silently. Narrow it with the search box, the sport filter, the model-probability
range, *Priced only*, *Triggers only*, or *FBS only*.

For each game it shows the model probability, the live Kalshi ask, and the **target** -
the highest price worth paying - and flags the ones where the market is actually
offering that price.

**College football includes FBS-vs-FCS games.** `/api/schedule` annotates every game with
whether both teams are FBS rather than dropping the mismatches, and this tab requests
`fbs=0` so they arrive. Week 1 is largely FBS-vs-FCS, and Kalshi does open markets on those
games, so filtering them out upstream made real games unfindable. They are marked *FCS
opponent* and *FBS only* hides them. The Edges tab still filters to FBS by default.

#### Refreshing

Two buttons, because the inputs move at very different speeds:

**Refresh prices** re-pulls only the Kalshi order books - five requests, a second or two.
Prices move constantly while schedules and projections do not, so this is the one to reach
for. Pairing is redone rather than patched, so a game Kalshi has listed since the last pull
picks up its new market instead of staying *not on Kalshi*.

**Reload all** re-pulls schedules, books and projections. That is five season-window
schedule requests plus a projection lookup per game, so it takes appreciably longer; it is
what you want after a postponement or when new games enter the window.

Both bypass the edge cache. `/api/schedule` and `/api/predictor` are cached for six hours
and `/api/kalshi` for sixty seconds, so without a cache-busting parameter a refresh would
replay the same response and look inert. Both report what moved - prices, books opening,
games newly listed, triggers gained - counted per game so the summary matches the rows on
screen. A refresh that changed nothing says so, which is what distinguishes it from one that
silently failed.

### How Kalshi data is pulled

`/api/kalshi` proxies Kalshi's public API. It is **read-only**: it never authenticates and
never places an order.

    GET /api/kalshi?series=KXNFLGAME    open events with nested markets
    GET /api/kalshi?tickers=A,B,C       prices for specific markets (max 60)

The series form calls `/events?series_ticker=…&status=open&with_nested_markets=true` against
`api.elections.kalshi.com/trade-api/v2` and **follows the cursor**. Kalshi caps a page at 200,
and a single page is not the series: college football lists a whole season at once and runs
well past 200 open events, with no guarantee the first page holds the near ones. Anything past
the cap was invisible, and an invisible market reads in the app as a game having no market at
all. The `/markets` backfill, used when nested markets arrive without live quotes, paginates
the same way.

Prices arrive as dollar strings in `*_dollars` fields at deci-cent precision - `"0.5235"` is
52.35 cents, not 52 - and sizes in `*_fp` fields. Both are normalised to cents on the way
through. A resting quote of zero means nothing is offered on that side, which is not the same
as a price of zero, so it is reported as `null` and renders as *no book yet*.

Responses are cached at the edge for 60 seconds (series) and 30 seconds (tickers), which is
what keeps repeat views off Kalshi's API; the refresh buttons bypass it deliberately.

Game markets are matched to ESPN games through the event ticker, which encodes the pairing as
away+home abbreviations with a date (`KXNFLGAME-26SEP13TBCIN`). Abbreviations alone are
unreliable - "TB" would match almost anything - so the ticker segment is checked as an ordered
pair, with the city names in the event title as the fallback.

**Abbreviations are not shared.** The ticker segment is the two abbreviations run together,
but Kalshi does not always use ESPN's - `UVA` against `VA`, `PITT` against `PIT`. The segment
is split at every position and each half tested against every form of a team's name, so a
differing abbreviation still pairs. Failing that, team names are looked for in the event
title *and in the market titles*, which are more consistent than the event title Kalshi
phrases several different ways. Both sides must match: "Virginia" is a substring of "Virginia
Tech", and requiring the opponent too is what keeps those apart. Words like *State* and
*North* are excluded as identifiers.

**Unmatched markets are listed.** Any open Kalshi event that pairs with no game appears in its
own table with its ticker. This is the one failure mode that is invisible by construction - a
market the app cannot recognise looks exactly like a game Kalshi never listed - so it is put
on screen rather than dropped.

**The date is not a single value.** `game.date` is the Mountain-time date, while Kalshi stamps
its own into the ticker, and an evening kickoff is already the next day in UTC - 8pm Mountain
is 02:00 UTC. A game is therefore matched against its Mountain, Eastern and UTC dates. Off the
Mountain date only the exact abbreviation pair is accepted, so the looser title check cannot
pair a team with its own game a day later.

This matters more than it sounds: comparing against the Mountain date alone meant every night
game read as *not on Kalshi*, which is indistinguishable from a game that genuinely has no
market. The matching lives in `public/simulate.mjs` and is covered by
`test/matching.test.mjs` for exactly that reason.

When there is no ask but the market is trading, the tab shows the bid and last price and says
**nothing offered** rather than claiming there is no book - Kalshi's own page will show a last
price in that situation. You cannot lift an offer that does not exist, but you can rest a bid,
which also drops the fee to a quarter.

`/api/kalshi?series=X&q=<text>&raw=1` dumps the untouched Kalshi payload for matching events
alongside what the handler makes of it, for settling whether a missing price is Kalshi's or
the app's reading of it. The discount defaults to 5 points and is editable; so are the
FPI range (lower and upper bound), the contract size, the sport, the date window, and
whether to show both sides of a game or only the side FPI favours.

The whole thing rests on one identity. Buying at `FPI - d` cents gives an expected
value per contract of

    FPI x 100 - price - fee  =  d - fee

so the expected profit is the discount minus the fee, in cents, regardless of what FPI
itself is. That is why the tab and the backtest both speak in points: at 100 contracts,
one point of discount is worth exactly $1 per game. `test/fpi.test.mjs` pins this down.

#### Where the 5 points came from

It was fitted on **FBS college football only** - 2,396 games across 2023-2025 - comparing
ESPN FPI against closing market prices. The required discount by FPI band, in points:

| Band | 2023 | 2024 | 2025 | Worst | Fee share | Model error |
|---|---|---|---|---|---|---|
| 50-60% | 3.78 | 0.30 | 6.52 | **6.52** | 1.73 | 4.79 |
| 60-70% | -0.55 | 7.80 | -0.21 | **7.80** | 1.59 | 6.21 |
| 70-80% | 5.05 | 1.66 | 3.52 | **5.05** | 1.31 | 3.74 |
| 80-90% | -2.79 | 2.00 | -1.91 | **2.00** | 0.91 | 1.09 |
| 90-100% | 1.34 | 0.33 | 1.27 | **1.34** | 0.34 | 1.00 |

Pooled and game-weighted across the three seasons: 3.42 / 2.31 / 3.36 / -1.00 / 1.00.
A negative number means that band was profitable at FPI's own price with no discount at all.

Three things follow, and the tab says all three on screen:

1. **Five points is a pooled average, not a per-band rule.** The requirement ranges from
   -2.79 to +7.80 - a 10.6-point spread. A single threshold that survives every band in
   every season would have to be 7.8.
2. **The fee is not flat.** It runs 1.73 points at 55c down to 0.34 at 95c, because Kalshi
   charges 7% x price x (1 - price). A perfectly calibrated model still needs five times
   more discount at a coinflip than at a lock. The *Add fee on top* checkbox switches the
   rule to `ask <= FPI - (fee + N)`, pricing the fee at the FPI probability so the target
   does not slide as the market moves.
3. **The per-band requirement is unstable year to year.** The 60-70% band needed nothing in
   2023 and 2025 but 7.80 points in 2024. This is the weakest point in the whole strategy
   and the reason the tab shows the worst season next to the pooled average.

The *Apply band* buttons set the FPI range and the discount to that band's worst-season
requirement, rounded up.

**NFL, NBA, NHL and college basketball are shown because every sport was asked for, but no
equivalent backtest has been run on them.** Treat those rows as untested.

### Backtest tab

Runs the strategy against a finished season with whatever variables you set. Pick a
sport and a season, press **Load season**, and it pulls every completed game plus
ESPN's pregame FPI projection for it. After that the data sits in the browser and
every variable re-simulates instantly - nothing re-hits ESPN.

What you can change:

| Variable | What it does |
|---|---|
| FPI range | lower and upper bound on the favourite's projected win probability |
| Discount | points below FPI, from -10 to 40 |
| Add fee on top | switches the requirement to `fee + N` instead of a flat `N` |
| Size | contracts per game |
| Fee | taker or maker |
| Price | assume FPI minus the discount, or use the real closing line |
| Slippage | points of cost added to the market price |

**The two price modes answer different questions, and the tab says which is which.**

*Assume FPI minus discount* buys every game in the band at exactly that price. There
is no selection - it measures what a fixed discount would have paid. The discount **is**
the price here, so profit rises in a straight line with it and the tab reports a
break-even discount, solved numerically.

*Use real closing line* pays the actual vig-free closing price plus slippage, and only
takes a game when the market was already that far below FPI. Here the discount is a
**filter**, not a price: raising it removes games rather than cheapening them, profit
is a step function that can move either way, and there is no single break-even - so the
tab shows a dash rather than a number a bisection would have invented. Read the sweep
table instead. This mode needs historical lines, which come from CollegeFootballData and
cover college football only.

Output is a summary (bets, record, profit, ROI, break-even, actual vs FPI-expected wins,
fees, max drawdown, t-statistic, Brier), a cumulative P&L curve you can hover to read any
individual game, a discount sweep, a per-band breakdown, and a calibration table.

The calibration table is the strategy in one view: where FPI says 75% and teams won 75%,
the only cost is the fee; where it says 75% and they won 70%, that five-point gap is what
the discount is paying for.

#### Reading the t-statistic

Profit alone does not establish an edge. The t-statistic asks whether the per-game result
is distinguishable from luck. Below about 2, a profitable season is one season of noise -
which is exactly what the 2023-2025 college football numbers showed, where a single season
carried most of the pooled profit.

#### How a season is fetched

Football is walked by week through the core API, which paginates properly. Basketball and
hockey are swept day by day, because the site scoreboard silently caps at 25 events per
request no matter what `limit` says; the client groups those days into windows sized so one
serverless call finishes inside its 60-second limit. College basketball uses the shortest
window of all - Division I plays ~44 games a day and well over 100 on a Saturday, and every
one of them needs its own projection lookup.

| Sport | Full season | Games | Window |
|---|---|---|---|
| College football | 5 requests | ~800 | 3 weeks |
| NFL | 4 requests | ~285 | 5 weeks |
| NBA | 27 requests | ~1,230 | 7 days |
| NHL | 29 requests | ~1,310 | 7 days |
| College basketball | 68 requests | ~5,700 | 2 days |

The **range** control trims that: *Quick probe* loads the opening two weeks, *First half*
loads half the season. Probe first - it is the cheapest way to find out whether ESPN still
has projections for that sport and season before waiting out a full load.

Requests run three at a time with a progress count, results are deduped on date-plus-matchup
at the seams, and each range is cached separately in localStorage - so loading is slow once
and instant afterwards. *Export data* writes the dataset out as JSON, and *Clear cached
seasons* drops it.

Season windows and chunking live in `public/simulate.mjs` as `seasonChunks`, under test.
They are pure and easy to get subtly wrong: the season arrives from a `<select>` as a
string, and `${'2024' + 1}` is `"20241"`, which silently yields the date `20241-04-15` on
exactly the sports that span a new year.

Older seasons are more likely to have had their projections dropped by ESPN, so a season
that returns nothing is usually that rather than a fault.

The simulation itself is `public/simulate.mjs`, a plain ES module with no DOM and no
network. `test/simulate.test.mjs` imports the same file the browser does, so the numbers
on screen are the numbers under test - including a check that its copy of the fee formula
matches `lib/fees.mjs` at every price and both fee roles.

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
