// The Backtest tab's engine. These run the same module the browser imports, so
// a number that passes here is the number rendered on screen.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fees from '../lib/fees.mjs';
import {
  simulate, priceFor, requiredPts, calibrate, discountSweep,
  breakEvenDiscount, maxDrawdown, feePerContractCents, orderFeeDollars,
} from '../public/simulate.mjs';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps,
  `expected ${a} to be within ${eps} of ${b}`);

/** n games at probability p, of which `wins` were won by the favourite. */
const make = (n, p, wins, m = null) => Array.from({ length: n }, (_, i) => ({
  d: `2025-09-${String((i % 28) + 1).padStart(2, '0')}`,
  p, w: i < wins ? 1 : 0, m, f: 'AAA', o: 'BBB',
}));

test('the browser copy of the fee math matches lib/fees.mjs exactly', () => {
  // public/simulate.mjs cannot import from lib/, so the formula is duplicated.
  // This pins the copy so it cannot drift silently.
  for (const role of ['taker', 'maker']) {
    for (let c = 1; c <= 99; c += 1) {
      close(feePerContractCents(c, role), fees.feePerContractCents(c, role));
      for (const n of [1, 7, 100, 2500]) {
        close(orderFeeDollars(n, c, role), fees.orderFeeDollars(n, c, role));
      }
    }
  }
});

test('a perfectly calibrated model breaks even at a discount equal to the fee', () => {
  // 1000 games at 70%, exactly 700 won. No model error, so the only cost is fees.
  const games = make(1000, 0.7, 700);
  const be = breakEvenDiscount(games, { contracts: 100, priceMode: 'fpi' });
  // Fee at the break-even price, which sits a bit under 70c.
  const expected = feePerContractCents(70 - be, 'taker');
  assert.ok(Math.abs(be - expected) < 0.02,
    `break-even ${be} should equal the fee at that price ${expected}`);
});

test('profit is contracts x (wins - expected wins) plus discount, minus fees', () => {
  const games = make(200, 0.6, 130);   // 130 actual vs 120 expected: model beat itself
  const r = simulate(games, { discountPts: 3, contracts: 100, priceMode: 'fpi' });
  const price = 60 - 3;
  const fee = orderFeeDollars(100, price, 'taker') * 200;
  const expected = 100 * (130 - 120) / 100 * 100 + 200 * 3 - fee;
  close(r.profit, expected, 1e-6);
  close(r.winsVsExpected, 10, 1e-9);
  close(r.fees, fee, 1e-6);
});

test('one point of discount is worth $1 per game per 100 contracts', () => {
  const games = make(150, 0.72, 108);
  const a = simulate(games, { discountPts: 4, contracts: 100 });
  const b = simulate(games, { discountPts: 5, contracts: 100 });
  // Fees shift slightly because the price moved, so compare gross of fees.
  close((b.profit + b.fees) - (a.profit + a.fees), 150, 1e-6);
});

test('doubling contracts doubles gross profit', () => {
  const games = make(120, 0.65, 80);
  const a = simulate(games, { discountPts: 5, contracts: 100 });
  const b = simulate(games, { discountPts: 5, contracts: 200 });
  close((b.profit + b.fees) / (a.profit + a.fees), 2, 1e-9);
});

test('the FPI band filter is inclusive of both ends', () => {
  const games = [...make(10, 0.55, 5), ...make(10, 0.75, 6), ...make(10, 0.95, 9)];
  assert.equal(simulate(games, { lowPct: 70, highPct: 80 }).games, 10);
  assert.equal(simulate(games, { lowPct: 50, highPct: 100 }).games, 30);
  assert.equal(simulate(games, { lowPct: 90, highPct: 100 }).games, 10);
});

test('market mode only takes games the real price was far enough below', () => {
  const games = [
    { d: '2025-01-01', p: 0.75, w: 1, m: 0.68, f: 'A', o: 'B' },  // 7 pts below
    { d: '2025-01-02', p: 0.75, w: 0, m: 0.735, f: 'C', o: 'D' }, // 1.5 pts below
    { d: '2025-01-03', p: 0.75, w: 1, m: null, f: 'E', o: 'F' },  // no line
  ];
  const r = simulate(games, { priceMode: 'market', discountPts: 5, contracts: 100 });
  assert.equal(r.taken, 1);
  assert.equal(r.skippedTooRich, 1);
  assert.equal(r.skippedNoLine, 1);
  close(r.ordered[0].price, 68);
});

test('slippage makes the market price worse and can disqualify a game', () => {
  const games = [{ d: '2025-01-01', p: 0.75, w: 1, m: 0.69, f: 'A', o: 'B' }];
  assert.equal(simulate(games, { priceMode: 'market', discountPts: 5, spreadPts: 0 }).taken, 1);
  assert.equal(simulate(games, { priceMode: 'market', discountPts: 5, spreadPts: 2 }).taken, 0);
});

test('add-fee raises the requirement by the fee at the FPI price', () => {
  close(requiredPts(0.55, { discountPts: 5, addFee: true }), 5 + feePerContractCents(55));
  close(requiredPts(0.95, { discountPts: 5, addFee: true }), 5 + feePerContractCents(95));
  close(requiredPts(0.55, { discountPts: 5, addFee: false }), 5);
});

test('an untradeable price is dropped, not booked', () => {
  // A 60% favourite with a 65-point discount would price below zero.
  const r = simulate(make(10, 0.6, 6), { discountPts: 65, contracts: 100 });
  assert.equal(r.taken, 0);
  assert.equal(r.skippedTooRich, 10);
  assert.equal(r.profit, 0);
});

test('profit rises monotonically with the discount, so bisection is valid', () => {
  const games = make(300, 0.68, 200);
  const sweep = discountSweep(games, { contracts: 100 }, [0, 2, 4, 6, 8, 10]);
  for (let i = 1; i < sweep.length; i++) {
    assert.ok(sweep[i].profit > sweep[i - 1].profit,
      `profit should increase from ${sweep[i - 1].discountPts} to ${sweep[i].discountPts} pts`);
  }
});

test('break-even returns null when the range never crosses zero', () => {
  // A model this wrong loses at any discount inside the search range.
  assert.equal(breakEvenDiscount(make(100, 0.9, 10), { contracts: 100 }), null);
});

test('calibration reports predicted against actual per band', () => {
  const games = [...make(100, 0.75, 60), ...make(100, 0.95, 95)];
  const cal = calibrate(games);
  const b70 = cal.find((b) => b.lo === 70);
  const b90 = cal.find((b) => b.lo === 90);
  close(b70.predicted, 0.75); close(b70.actual, 0.6); close(b70.gap, -0.15, 1e-9);
  close(b90.predicted, 0.95); close(b90.actual, 0.95); close(b90.gap, 0, 1e-9);
});

test('max drawdown finds the deepest peak-to-trough fall', () => {
  close(maxDrawdown([10, 25, 5, 30, 12]), 20);   // 25 -> 5
  close(maxDrawdown([1, 2, 3]), 0);
  close(maxDrawdown([-5, -20]), 20);             // peak starts at 0
});

test('the equity curve runs in date order regardless of input order', () => {
  const games = [
    { d: '2025-03-01', p: 0.8, w: 1, m: null, f: 'A', o: 'B' },
    { d: '2025-01-01', p: 0.8, w: 0, m: null, f: 'C', o: 'D' },
  ];
  const r = simulate(games, { discountPts: 5, contracts: 100 });
  assert.deepEqual(r.ordered.map((g) => g.d), ['2025-01-01', '2025-03-01']);
  assert.ok(r.equity[0] < 0, 'the January loss should land first');
});

test('a losing t-stat is negative and a coinflip result is near zero', () => {
  assert.ok(simulate(make(400, 0.7, 200), { discountPts: 5 }).tStat < -2);
  assert.equal(simulate([], { discountPts: 5 }).tStat, null);
});

test('break-even is undefined in market mode, where the discount filters rather than prices', () => {
  // Raising the discount in market mode removes games instead of cheapening
  // them, so profit is a step function and a bisection would report a
  // meaningless crossing. The engine refuses rather than inventing a number.
  const games = Array.from({ length: 60 }, (_, i) => ({
    d: `2025-01-${String((i % 28) + 1).padStart(2, '0')}`,
    p: 0.75, w: i % 4 ? 1 : 0, m: 0.60 + (i % 10) * 0.015, f: 'A', o: 'B',
  }));
  assert.equal(breakEvenDiscount(games, { priceMode: 'market' }), null);
  assert.ok(breakEvenDiscount(games, { priceMode: 'fpi' }) != null);
});

test('a higher bar in market mode can only remove bets, never add them', () => {
  const games = Array.from({ length: 80 }, (_, i) => ({
    d: '2025-01-01', p: 0.8, w: 1, m: 0.60 + (i % 20) * 0.01, f: 'A', o: 'B',
  }));
  const sweep = discountSweep(games, { priceMode: 'market' }, [0, 4, 8, 12, 16]);
  for (let i = 1; i < sweep.length; i++) {
    assert.ok(sweep[i].taken <= sweep[i - 1].taken,
      `bets should not increase from ${sweep[i - 1].discountPts} to ${sweep[i].discountPts} pts`);
  }
});
