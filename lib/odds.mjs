// Betting-market math: sportsbook lines -> fair probabilities -> position sizing.
//
// Kalshi contracts settle at $1.00 and trade in cents, so a YES bought at 42c
// risks 42c to win 58c. Everything below works in cents to match that.

/** American moneyline (-165, +140) -> implied probability, vig included. */
export function americanToProb(ml) {
  const n = typeof ml === 'string' ? Number(ml.replace(/[^0-9+-]/g, '')) : ml;
  if (!Number.isFinite(n) || n === 0) return null;
  return n < 0 ? -n / (-n + 100) : 100 / (n + 100);
}

/**
 * Strip the bookmaker's margin from a two-way market. Raw implied probabilities
 * sum to more than 1; the overround is removed proportionally so the pair sums
 * to exactly 1 (the "multiplicative" method).
 */
export function devig(pA, pB) {
  if (!Number.isFinite(pA) || !Number.isFinite(pB)) return null;
  const sum = pA + pB;
  if (sum <= 0) return null;
  return { a: pA / sum, b: pB / sum, overround: sum - 1 };
}

/** Point spread -> win probability, using a normal model of game margin. */
const SIGMA = { nfl: 13.2, ncaaf: 16.5, nba: 11.5, ncaab: 10.5, nhl: 1.9 };

function normalCdf(z) {
  // Abramowitz & Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937
    + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

/**
 * @param {number} spread negative when the team is favoured (e.g. -3.5)
 * @param {string} league key into SIGMA
 */
export function spreadToProb(spread, league = 'nfl') {
  if (!Number.isFinite(spread)) return null;
  const sigma = SIGMA[league] || 13;
  return normalCdf(-spread / sigma);
}

/**
 * Kelly stake as a fraction of bankroll for a Kalshi contract.
 * @param {number} p  your probability the contract settles YES (0-1)
 * @param {number} priceCents  ask price, 1-99
 * @param {number} fraction  Kelly multiplier; 0.25 (quarter Kelly) is a common
 *                           default because full Kelly is punishing when your
 *                           probability estimate is even slightly off.
 * @returns {{full:number, staked:number, edge:number}} fractions of bankroll
 */
export function kelly(p, priceCents, fraction = 0.25) {
  const c = Number(priceCents);
  if (!Number.isFinite(p) || !Number.isFinite(c) || c <= 0 || c >= 100) return null;
  const price = c / 100;
  const b = (1 - price) / price;          // profit per unit risked
  const full = (p * b - (1 - p)) / b;     // = p - (1-p)/b
  return {
    full: Math.max(0, full),
    staked: Math.max(0, full * fraction),
    edge: p - price,                      // probability points of edge
  };
}

/** Expected value in cents per contract bought at priceCents. */
export function expectedValue(p, priceCents) {
  if (!Number.isFinite(p) || !Number.isFinite(priceCents)) return null;
  return p * (100 - priceCents) - (1 - p) * priceCents;
}

/**
 * Pull the best available line out of an ESPN competition. ESPN nests moneylines
 * differently depending on the provider and how far out the game is, so several
 * shapes are tried before giving up.
 */
export function extractOdds(competition) {
  const o = competition?.odds?.[0];
  if (!o) return null;

  const num = (v) => {
    const n = typeof v === 'string' ? Number(v.replace(/[^0-9+-.]/g, '')) : v;
    return Number.isFinite(n) ? n : null;
  };
  const ml = (side) => num(
    o[`${side}TeamOdds`]?.moneyLine
    ?? o.moneyline?.[side]?.close?.odds
    ?? o.moneyline?.[side]?.current?.odds
    ?? o.moneyline?.[side]?.open?.odds,
  );

  return {
    provider: o.provider?.name ?? null,
    details: o.details ?? null,          // e.g. "CIN -3.5"
    spread: num(o.spread),               // negative = home favoured
    total: num(o.overUnder),
    homeML: ml('home'),
    awayML: ml('away'),
    homeFavorite: o.homeTeamOdds?.favorite ?? null,
  };
}

/**
 * Fair (vig-free) win probabilities for a game, preferring moneylines and
 * falling back to the spread when no moneyline is published yet.
 */
export function fairProbabilities(odds, league) {
  if (!odds) return null;

  const pH = americanToProb(odds.homeML);
  const pA = americanToProb(odds.awayML);
  if (pH != null && pA != null) {
    const d = devig(pH, pA);
    if (d) return { home: d.a, away: d.b, source: 'moneyline', overround: d.overround };
  }

  if (Number.isFinite(odds.spread)) {
    const home = spreadToProb(odds.spread, league);
    if (home != null) return { home, away: 1 - home, source: 'spread', overround: 0 };
  }
  return null;
}
