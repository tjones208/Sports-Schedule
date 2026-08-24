// The FPI strategy tab rests on one identity. This pins it down.
//
//   Buy a contract at (FPI - d) cents, where d is the discount in points.
//   Expected value per contract = FPI*100 - price - fee
//                               = FPI*100 - (FPI*100 - d) - fee
//                               = d - fee
//
// So the expected profit is the discount minus the fee, in cents, and it does
// not depend on FPI itself. That is why the tab and the backtest both speak in
// points, and why "how far below FPI does Kalshi have to be" is the only
// question the rule asks.

import test from 'node:test';
import assert from 'node:assert/strict';
import { feePerContractCents, orderFeeDollars } from '../lib/fees.mjs';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps,
  `expected ${a} to be within ${eps} of ${b}`);

test('expected value per contract equals discount minus fee, at every FPI', () => {
  const discount = 5;
  for (const fpi of [0.52, 0.58, 0.65, 0.74, 0.83, 0.91, 0.97]) {
    const price = fpi * 100 - discount;
    const fee = feePerContractCents(price, 'taker');
    const ev = fpi * 100 - price - fee;
    close(ev, discount - fee);
  }
});

test('the discount that breaks even is exactly the fee', () => {
  for (const fpi of [0.55, 0.65, 0.75, 0.85, 0.95]) {
    // Solve for the discount where expected value is zero. Because EV = d - fee
    // and the fee depends on the price, this is a fixed point; one pass from the
    // FPI price is close enough to check the sign flips around it.
    const fee = feePerContractCents(fpi * 100, 'taker');
    const price = fpi * 100 - fee;
    assert.ok(fpi * 100 - price - feePerContractCents(price, 'taker') < 0.05,
      'a discount equal to the fee should leave nothing on the table');
    assert.ok(fpi * 100 - (fpi * 100 - fee - 1) - feePerContractCents(price, 'taker') > 0,
      'one point more than the fee should be profitable');
  }
});

test('one point of discount is worth $1 per game per 100 contracts', () => {
  for (const fpi of [0.55, 0.70, 0.88]) {
    const contracts = 100;
    const a = contracts * (fpi - (fpi * 100 - 4) / 100);
    const b = contracts * (fpi - (fpi * 100 - 5) / 100);
    close(b - a, 1);
  }
});

test('the fee share of the requirement peaks at a coinflip and collapses at the tails', () => {
  const at = (p) => feePerContractCents(p * 100, 'taker');
  assert.ok(at(0.5) > at(0.65));
  assert.ok(at(0.65) > at(0.8));
  assert.ok(at(0.8) > at(0.95));
  // The values quoted on the tab's band table, at each band midpoint.
  close(Math.round(at(0.55) * 100) / 100, 1.73);
  close(Math.round(at(0.65) * 100) / 100, 1.59);
  close(Math.round(at(0.75) * 100) / 100, 1.31);
});

test('a maker pays a quarter of the taker fee, so needs a quarter of the fee discount', () => {
  for (const p of [55, 65, 75, 85, 95]) {
    close(feePerContractCents(p, 'maker'), feePerContractCents(p, 'taker') / 4);
  }
});

test('dollar fee at 100 contracts matches the per-contract fee in points', () => {
  for (const p of [55, 66, 74, 88]) {
    // 100 contracts x 1 cent = $1, so cents-per-contract and dollars-per-100
    // are the same number, up to Kalshi rounding the order fee up to a cent.
    const perContract = feePerContractCents(p, 'taker');
    const order = orderFeeDollars(100, p, 'taker');
    assert.ok(order >= perContract && order - perContract < 0.01,
      `order fee ${order} should round ${perContract} up to the next cent`);
  }
});
