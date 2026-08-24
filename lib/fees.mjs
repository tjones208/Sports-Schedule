// Kalshi trading fees.
//
// Published schedule (July 2026): the taker fee is 7% of the "risk" term
// C x P x (1-P), rounded up to the next cent on the order total. Makers pay a
// quarter of that. The curve peaks at 50c - about 1.75c per contract - and
// falls toward zero at the extremes, which is why a thin edge on a coin-flip
// market is often entirely fee.
//
// Verify against https://kalshi.com/docs/kalshi-fee-schedule.pdf before relying
// on these numbers for live trading; the schedule can change.

const TAKER_RATE = 0.07;
const MAKER_MULTIPLIER = 0.25;

/** Unrounded fee in cents for a single contract at priceCents. */
export function feePerContractCents(priceCents, role = 'taker') {
  const p = Number(priceCents) / 100;
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  const rate = role === 'maker' ? TAKER_RATE * MAKER_MULTIPLIER : TAKER_RATE;
  return rate * p * (1 - p) * 100;
}

/** Fee in dollars for an order, rounded up to the cent as Kalshi does. */
export function orderFeeDollars(contracts, priceCents, role = 'taker') {
  const n = Number(contracts);
  const p = Number(priceCents) / 100;
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  const rate = role === 'maker' ? TAKER_RATE * MAKER_MULTIPLIER : TAKER_RATE;
  const cents = rate * n * p * (1 - p) * 100;
  // Binary floating point turns an exact 175 into 175.00000000000003, which
  // would then round up a whole cent. Snap off that noise before the ceiling.
  return Math.ceil(Number(cents.toFixed(9))) / 100;
}

/**
 * The price you effectively pay once the entry fee is included. Settlement of a
 * winning contract is free, so only the entry is charged for a hold-to-expiry
 * position.
 */
export function effectivePriceCents(priceCents, role = 'taker') {
  return Number(priceCents) + feePerContractCents(priceCents, role);
}

/** Expected value per contract in cents, after the entry fee. */
export function netExpectedValue(p, priceCents, role = 'taker') {
  const c = Number(priceCents);
  if (!Number.isFinite(p) || !Number.isFinite(c)) return null;
  const gross = p * (100 - c) - (1 - p) * c;
  return gross - feePerContractCents(c, role);
}

/**
 * Edge after fees, in probability points. Fees act exactly like a worse entry
 * price, so this is your probability minus the fee-inclusive price.
 */
export function netEdge(p, priceCents, role = 'taker') {
  if (!Number.isFinite(p) || !Number.isFinite(Number(priceCents))) return null;
  return p - effectivePriceCents(priceCents, role) / 100;
}

/** The probability at which a contract stops losing money after fees. */
export function breakevenProbability(priceCents, role = 'taker') {
  return effectivePriceCents(priceCents, role) / 100;
}

/**
 * Kelly sizing against the fee-inclusive price. Risking (c + fee) to win
 * (100 - c) shifts both sides of the ratio, so the stake shrinks faster than
 * the edge does.
 */
export function kellyNet(p, priceCents, fraction = 0.25, role = 'taker') {
  const c = Number(priceCents);
  if (!Number.isFinite(p) || !Number.isFinite(c) || c <= 0 || c >= 100) return null;
  const cost = effectivePriceCents(c, role) / 100;
  const win = (100 - c) / 100;
  if (cost <= 0 || cost >= 1) return null;
  const b = win / cost;
  const full = (p * b - (1 - p)) / b;
  return {
    full: Math.max(0, full),
    staked: Math.max(0, full * fraction),
    edge: p - cost,
    breakeven: cost,
  };
}
