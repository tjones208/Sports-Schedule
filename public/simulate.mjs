/* Backtest simulation - pure functions, no DOM and no network.
 *
 * Imported by the Backtest tab in the browser and by test/simulate.test.mjs in
 * Node, so the numbers on screen are the numbers the tests check.
 *
 * A "game" is one record from /api/backtest?dataset=1:
 *   { d: '2025-09-06', p: 0.7412, w: 1, m: 0.7201, f: 'OSU', o: 'TEX' }
 * where p is the FPI favourite's win probability, w is whether that favourite
 * actually won, and m is the same side's vig-free market probability (or null).
 *
 * Everything is expressed per favourite, so p is always >= 0.5.
 */

export const TAKER_RATE = 0.07;
export const MAKER_MULTIPLIER = 0.25;

/** Unrounded Kalshi fee in cents for one contract. Mirrors lib/fees.mjs. */
export function feePerContractCents(priceCents, role = 'taker') {
  const p = Number(priceCents) / 100;
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  const rate = role === 'maker' ? TAKER_RATE * MAKER_MULTIPLIER : TAKER_RATE;
  return rate * p * (1 - p) * 100;
}

/** Order fee in dollars, rounded up to the cent as Kalshi does. */
export function orderFeeDollars(contracts, priceCents, role = 'taker') {
  const n = Number(contracts);
  const p = Number(priceCents) / 100;
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  const rate = role === 'maker' ? TAKER_RATE * MAKER_MULTIPLIER : TAKER_RATE;
  const cents = rate * n * p * (1 - p) * 100;
  // Binary floating point turns an exact 175 into 175.00000000000003, which
  // would then round up a whole cent. Snap that noise off before the ceiling.
  return Math.ceil(Number(cents.toFixed(9))) / 100;
}

export const BANDS = [[50, 60], [60, 70], [70, 80], [80, 90], [90, 100]];

/* ---------- what ESPN calls its model, per sport ----------

   One endpoint serves the pregame win probability for every sport, but the
   model behind it is branded differently and calling all of it "FPI" is simply
   wrong outside football. Hockey gets no branded index from ESPN, so it is
   named for what it is rather than given an invented acronym.               */

export const MODEL_NAME = {
  nfl: 'FPI',          // Football Power Index
  ncaaf: 'FPI',
  nba: 'BPI',          // Basketball Power Index
  ncaab: 'BPI',
  nhl: 'ESPN model',   // ESPN publishes no branded power index for hockey
};

export const modelName = (league) => MODEL_NAME[league] || 'ESPN model';

/** A heading for a view that may mix sports: 'FPI', 'BPI', or 'FPI/BPI'. */
export function modelLabel(leagues) {
  const names = [...new Set((leagues || []).map(modelName))];
  if (!names.length) return 'ESPN model';
  if (names.length === 1) return names[0];
  const branded = names.filter((n) => n !== 'ESPN model');
  return branded.length ? branded.sort().join('/') : 'ESPN model';
}

export const DEFAULT_OPTIONS = {
  discountPts: 5,
  addFee: false,
  contracts: 100,
  role: 'taker',
  lowPct: 50,
  highPct: 100,
  priceMode: 'fpi',   // 'fpi' assumes the price, 'market' uses the real closing line
  spreadPts: 0,       // slippage added to the market price, in probability points
};

/**
 * What the ask has to be below FPI for a game to qualify.
 *
 * The fee component is priced at the FPI probability, not at the price paid, so
 * the requirement is a fixed property of the game rather than something that
 * slides as the price moves. This matches the Kalshi tab and the band table.
 */
export function requiredPts(p, opts) {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  return o.discountPts + (o.addFee ? feePerContractCents(p * 100, o.role) : 0);
}

/**
 * The price this game would be bought at, and whether it clears the rule.
 *
 * 'fpi' mode assumes Kalshi offers exactly FPI minus the discount, so every
 * game in the band is taken and there is no selection effect. That is the
 * question "what would a fixed discount have paid?".
 *
 * 'market' mode pays the real vig-free closing price plus slippage and takes
 * the game only when that price is already far enough below FPI. That is the
 * honest simulation, and it is only available where market data was joined.
 */
export function priceFor(g, opts) {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  const need = requiredPts(g.p, o);
  if (o.priceMode === 'market') {
    if (g.m == null) return { eligible: false, reason: 'no line', price: null, need };
    const price = g.m * 100 + o.spreadPts;
    const gap = g.p * 100 - price;
    return { eligible: gap >= need, reason: gap >= need ? null : 'too rich',
      price, need, gap };
  }
  const price = g.p * 100 - need;
  return { eligible: true, reason: null, price, need, gap: need };
}

function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Deepest peak-to-trough fall along a cumulative series. Returned positive. */
export function maxDrawdown(equity) {
  let peak = 0, worst = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    if (peak - v > worst) worst = peak - v;
  }
  return worst;
}

/** Run one configuration over a dataset. */
export function simulate(games, opts = {}) {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  const lo = Math.min(o.lowPct, o.highPct);
  const hi = Math.max(o.lowPct, o.highPct);

  const inBand = games.filter((g) => g.p * 100 >= lo && g.p * 100 <= hi);

  const taken = [];
  let skippedNoLine = 0, skippedTooRich = 0;

  for (const g of inBand) {
    const { eligible, reason, price, need, gap } = priceFor(g, o);
    if (!eligible) {
      if (reason === 'no line') skippedNoLine++; else skippedTooRich++;
      continue;
    }
    // A price outside (0, 100) is not a tradeable contract. This happens when a
    // large discount is subtracted from a near-certain favourite, or a tiny one
    // from a coinflip; those games are dropped rather than booked at a fake price.
    if (!(price > 0 && price < 100)) { skippedTooRich++; continue; }

    const fee = orderFeeDollars(o.contracts, price, o.role);
    const cost = o.contracts * (price / 100);
    const pnl = g.w
      ? o.contracts * ((100 - price) / 100) - fee
      : -cost - fee;
    taken.push({ ...g, price, need, gap, fee, cost, pnl });
  }

  const n = taken.length;
  const wins = taken.filter((g) => g.w).length;
  const expectedWins = taken.reduce((s, g) => s + g.p, 0);
  const staked = taken.reduce((s, g) => s + g.cost, 0);
  const fees = taken.reduce((s, g) => s + g.fee, 0);
  const profit = taken.reduce((s, g) => s + g.pnl, 0);

  // Chronological, so the equity curve reads as the season actually unfolded.
  const ordered = taken.slice().sort((a, b) => (a.d || '').localeCompare(b.d || ''));
  let run = 0;
  const equity = ordered.map((g) => { run += g.pnl; return run; });

  const pnls = taken.map((g) => g.pnl);
  const sd = stdev(pnls);
  const meanPnl = n ? profit / n : 0;

  return {
    games: inBand.length,
    taken: n,
    skippedNoLine,
    skippedTooRich,
    wins,
    losses: n - wins,
    winRate: n ? wins / n : null,
    expectedWins,
    winsVsExpected: n ? wins - expectedWins : 0,
    staked,
    fees,
    profit,
    roi: staked ? profit / staked : null,
    perGame: meanPnl,
    // Is the result distinguishable from zero, or is it one season of noise?
    tStat: n > 1 && sd > 0 ? meanPnl / (sd / Math.sqrt(n)) : null,
    equity,
    ordered,
    maxDrawdown: maxDrawdown(equity),
    brier: n ? taken.reduce((s, g) => s + (g.p - g.w) ** 2, 0) / n : null,
    bands: bandBreakdown(taken, o),
    calibration: calibrate(inBand),
  };
}

function bandBreakdown(taken, o) {
  return BANDS.map(([lo, hi]) => {
    const inb = taken.filter((g) => g.p * 100 >= lo && g.p * 100 < (hi === 100 ? 100.001 : hi));
    const wins = inb.filter((g) => g.w).length;
    const profit = inb.reduce((s, g) => s + g.pnl, 0);
    const fees = inb.reduce((s, g) => s + g.fee, 0);
    const expected = inb.reduce((s, g) => s + g.p, 0);
    return {
      lo, hi, games: inb.length, wins, expectedWins: expected,
      profit, fees,
      // One point of discount is worth contracts/100 dollars per game, so the
      // extra discount this band needed is -profit scaled back into points.
      discountNeededPts: inb.length
        ? (-profit / inb.length) * (100 / o.contracts) : null,
      feeInPts: inb.length ? (fees / inb.length) * (100 / o.contracts) : null,
    };
  });
}

/** Did games projected at X% actually win about X% of the time? */
export function calibrate(games) {
  return BANDS.map(([lo, hi]) => {
    const inb = games.filter((g) => g.p * 100 >= lo && g.p * 100 < (hi === 100 ? 100.001 : hi));
    const wins = inb.filter((g) => g.w).length;
    const predicted = inb.length ? inb.reduce((s, g) => s + g.p, 0) / inb.length : null;
    const actual = inb.length ? wins / inb.length : null;
    return { lo, hi, games: inb.length, wins, predicted, actual,
      gap: predicted == null ? null : actual - predicted };
  });
}

/** Profit across a range of discounts, for the sweep table and the curve. */
export function discountSweep(games, opts, points) {
  const list = points || [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12];
  return list.map((d) => {
    const r = simulate(games, { ...opts, discountPts: d });
    return { discountPts: d, taken: r.taken, profit: r.profit, roi: r.roi,
      tStat: r.tStat, perGame: r.perGame };
  });
}

/**
 * The discount at which this configuration breaks even.
 *
 * Only defined in 'fpi' mode. There the discount sets the price, so a bigger
 * discount is strictly a cheaper entry and profit rises monotonically, which is
 * what makes the bisection valid.
 *
 * In 'market' mode the discount is a *filter*, not a price: raising it removes
 * games from the sample rather than improving the ones that stay. Profit is
 * then a step function that can move either way, a bisection would converge on
 * a meaningless crossing, and there is no single break-even to report. Read the
 * sweep table instead - it shows how the result moves as the bar rises.
 */
export function breakEvenDiscount(games, opts, lo = -20, hi = 40) {
  if ({ ...DEFAULT_OPTIONS, ...opts }.priceMode !== 'fpi') return null;
  const at = (d) => simulate(games, { ...opts, discountPts: d }).profit;
  let a = lo, b = hi;
  const fa = at(a), fb = at(b);
  if (fa > 0 || fb < 0) return null;
  for (let i = 0; i < 40; i++) {
    const mid = (a + b) / 2;
    if (at(mid) < 0) a = mid; else b = mid;
  }
  return (a + b) / 2;
}


/* ---------- season planning ----------

   Which requests cover a season, per sport. Pure, so test/simulate.test.mjs can
   check the windows rather than discovering a bad date the slow way: `year`
   arrives from a <select> as a string, and `${year + 1}` on a string silently
   produces "20251" instead of 2025.                                          */

export const SEASON_PLAN = {
  ncaaf: { mode: 'weeks', weeks: 15, chunk: 3, seasontype: '2',
    label: (y) => `${y}` },
  nfl: { mode: 'weeks', weeks: 18, chunk: 5, seasontype: '2',
    label: (y) => `${y}` },
  nba: { mode: 'dates', from: (y) => `${y}-10-15`, to: (y) => `${y + 1}-04-15`, chunk: 7,
    label: (y) => `${y}-${String((y + 1) % 100).padStart(2, '0')}` },
  nhl: { mode: 'dates', from: (y) => `${y}-10-01`, to: (y) => `${y + 1}-04-18`, chunk: 7,
    label: (y) => `${y}-${String((y + 1) % 100).padStart(2, '0')}` },
  // Division I plays ~44 games a day and well over 100 on a Saturday, so this
  // window is deliberately short - a wider one puts more projection lookups in
  // a single request than the 60s function limit can finish.
  ncaab: { mode: 'dates', from: (y) => `${y}-11-01`, to: (y) => `${y + 1}-03-15`, chunk: 2,
    label: (y) => `${y}-${String((y + 1) % 100).padStart(2, '0')}` },
};

export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * The /api/backtest query strings that together cover a season.
 *
 * `range` trims the span: 'probe' is a fast look at the opening stretch, which
 * is the cheapest way to find out whether ESPN still has projections for that
 * sport and season before waiting out a full load.
 */
export function seasonChunks(league, year, range = 'full') {
  const plan = SEASON_PLAN[league];
  if (!plan) throw new Error(`unknown league: ${league}`);
  const y = Number(year);
  if (!Number.isInteger(y)) throw new Error(`season must be a year, got ${year}`);
  const out = [];

  if (plan.mode === 'weeks') {
    const weeks = range === 'probe' ? Math.min(2, plan.weeks)
      : range === 'half' ? Math.ceil(plan.weeks / 2) : plan.weeks;
    for (let w = 1; w <= weeks; w += plan.chunk) {
      const list = [];
      for (let k = w; k < w + plan.chunk && k <= weeks; k++) list.push(k);
      out.push(`league=${league}&year=${y}&weeks=${list.join(',')}&seasontype=${plan.seasontype}`);
    }
    return out;
  }

  const first = plan.from(y);
  const full = plan.to(y);
  const days = Math.round(
    (Date.parse(`${full}T12:00:00Z`) - Date.parse(`${first}T12:00:00Z`)) / 86400000);
  const last = range === 'probe' ? addDays(first, Math.min(13, days))
    : range === 'half' ? addDays(first, Math.floor(days / 2)) : full;

  let cur = first;
  while (cur <= last) {
    const end = addDays(cur, plan.chunk - 1);
    out.push(`league=${league}&start=${cur}&end=${end > last ? last : end}`);
    cur = addDays(cur, plan.chunk);
  }
  return out;
}
