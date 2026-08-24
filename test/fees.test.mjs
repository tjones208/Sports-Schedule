// Kalshi fee model and fee-adjusted edge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  feePerContractCents, orderFeeDollars, effectivePriceCents,
  netExpectedValue, netEdge, breakevenProbability, kellyNet,
} from '../lib/fees.mjs';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('the fee curve peaks at 50c and is symmetric', () => {
  assert.ok(close(feePerContractCents(50), 1.75), 'max taker fee is 1.75c per contract');
  assert.ok(close(feePerContractCents(10), feePerContractCents(90)),
    'a price and its complement cost the same');
  assert.ok(close(feePerContractCents(25), feePerContractCents(75)));
  assert.ok(feePerContractCents(50) > feePerContractCents(40));
  assert.ok(feePerContractCents(40) > feePerContractCents(20));
});

test('fees vanish at the boundaries and never go negative', () => {
  assert.equal(feePerContractCents(0), 0);
  assert.equal(feePerContractCents(100), 0);
  assert.equal(feePerContractCents(-5), 0);
  assert.ok(feePerContractCents(1) > 0 && feePerContractCents(1) < 0.1);
});

test('makers pay a quarter of the taker rate', () => {
  assert.ok(close(feePerContractCents(50, 'maker'), 1.75 * 0.25));
  assert.ok(close(feePerContractCents(30, 'maker'), feePerContractCents(30) * 0.25));
});

test('order fees round up to the cent', () => {
  // 100 x 0.07 x 0.5 x 0.5 = $1.75 exactly
  assert.ok(close(orderFeeDollars(100, 50), 1.75));
  // 1 contract at 50c is $0.0175, which must round up to a full cent
  assert.ok(close(orderFeeDollars(1, 50), 0.02));
  assert.equal(orderFeeDollars(0, 50), 0);
  assert.equal(orderFeeDollars(10, 0), 0);
});

test('fees act as a worse entry price', () => {
  assert.ok(close(effectivePriceCents(52), 52 + feePerContractCents(52)));
  assert.ok(close(breakevenProbability(50), 0.5175),
    'a 50c contract must win 51.75% of the time to break even');
  assert.ok(breakevenProbability(52) > 0.52);
});

test('net edge is always below gross edge', () => {
  const p = 0.5991;
  const gross = p - 0.52;
  const net = netEdge(p, 52);
  assert.ok(net < gross);
  assert.ok(close(gross - net, feePerContractCents(52) / 100));
  assert.ok(netExpectedValue(p, 52) < p * 48 - (1 - p) * 52);
});

test('a thin edge can be entirely fee', () => {
  // 1 point of gross edge at a coin-flip price does not survive 1.75c of fee
  assert.ok(netExpectedValue(0.51, 50) < 0, 'a 1-point edge at 50c is net negative');
  assert.ok(netEdge(0.51, 50) < 0);
  // The same 1-point edge at a cheap price does survive, because fees are smaller there
  assert.ok(netExpectedValue(0.11, 10) > 0, 'a 1-point edge at 10c clears the smaller fee');
});

test('fee-aware Kelly stakes less than fee-blind Kelly', () => {
  const p = 0.60;
  const withFees = kellyNet(p, 52, 0.25);
  // Fee-blind equivalent: risking 0.52 to win 0.48
  const blindFull = (p - (1 - p) * (52 / 48));
  assert.ok(withFees.full < blindFull, 'fees must reduce the recommended size');
  assert.ok(withFees.breakeven > 0.52);
  assert.ok(close(withFees.staked, withFees.full * 0.25));
});

test('fee-aware Kelly refuses a position that only looked good before fees', () => {
  const k = kellyNet(0.505, 50, 0.25);
  assert.equal(k.staked, 0, 'half a point of edge at 50c is not tradeable after fees');
  assert.equal(kellyNet(0.9, 0, 0.25), null);
  assert.equal(kellyNet(0.9, 100, 0.25), null);
});
