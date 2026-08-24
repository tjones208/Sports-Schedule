// FBS matchup filtering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFbsMatchup } from '../lib/divisions.mjs';

const comp = (a, b) => ({ competitors: [{ team: { id: a } }, { team: { id: b } }] });
const FBS = new Set(['2', '52', '99', '2306']);   // stand-ins for real FBS ids

test('keeps a game only when both teams are FBS', () => {
  assert.equal(isFbsMatchup(comp('2', '52'), FBS), true);
  assert.equal(isFbsMatchup(comp('2', '9999'), FBS), false, 'FBS hosting FCS must be dropped');
  assert.equal(isFbsMatchup(comp('9999', '52'), FBS), false);
  assert.equal(isFbsMatchup(comp('8888', '9999'), FBS), false);
});

test('ids are compared as strings, not by type', () => {
  assert.equal(isFbsMatchup({ competitors: [{ team: { id: 2 } }, { team: { id: 52 } }] }, FBS), true);
});

test('fails open when the FBS list is unavailable', () => {
  // Losing the roster fetch must not silently empty the whole board.
  assert.equal(isFbsMatchup(comp('2', '9999'), null), true);
  assert.equal(isFbsMatchup(comp('9999', '8888'), undefined), true);
});

test('malformed competitions are left alone', () => {
  assert.equal(isFbsMatchup({ competitors: [] }, FBS), true);
  assert.equal(isFbsMatchup({ competitors: [{ team: { id: '2' } }] }, FBS), true);
  assert.equal(isFbsMatchup({}, FBS), true);
  assert.equal(isFbsMatchup(null, FBS), true);
});
