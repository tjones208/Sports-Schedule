// Finished games must not appear on any forward-looking view. The API drops
// them, but its responses are edge-cached for six hours, so the client needs
// the same judgement - and both sides read it from here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isFinished, CERTAINLY_OVER_HOURS } from '../public/simulate.mjs';

const NOW = Date.parse('2026-08-29T20:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const inHours = (h) => new Date(NOW + h * 3600000).toISOString();

test('ESPN saying the game is complete is enough', () => {
  assert.equal(isFinished({ completed: true, startUTC: inHours(3) }, NOW), true);
});

test('a postponed or cancelled game is also not upcoming', () => {
  // Those reach 'post' without ever being completed, and a board that lists
  // them is telling you about a game that will not be played.
  assert.equal(isFinished({ state: 'post', completed: false, startUTC: inHours(2) }, NOW), true);
});

test('a game not yet started stays', () => {
  assert.equal(isFinished({ state: 'pre', completed: false, startUTC: inHours(1) }, NOW), false);
  assert.equal(isFinished({ state: 'pre', completed: false, startUTC: inHours(240) }, NOW), false);
});

test('a game underway stays - it is not finished', () => {
  assert.equal(isFinished({ state: 'in', completed: false, startUTC: hoursAgo(1) }, NOW), false);
  assert.equal(isFinished({ state: 'in', completed: false, startUTC: hoursAgo(3) }, NOW), false);
});

test('elapsed time closes the cache gap', () => {
  // A stale cached response can still carry state 'pre' for a game that has
  // already been played. Long enough past the start, it is over regardless.
  const stale = { state: 'pre', completed: false, startUTC: hoursAgo(CERTAINLY_OVER_HOURS + 1) };
  assert.equal(isFinished(stale, NOW), true);
});

test('the elapsed-time cutoff does not catch a long game', () => {
  // Football with overtime and a weather delay is the worst case, and it is
  // still comfortably inside the window.
  assert.equal(isFinished({ state: 'in', startUTC: hoursAgo(CERTAINLY_OVER_HOURS - 0.5) }, NOW), false);
  assert.ok(CERTAINLY_OVER_HOURS >= 5, 'the cutoff must clear a delayed game');
});

test('a game with no announced time is never judged by elapsed time', () => {
  // ESPN gives those a placeholder start that is frequently in the past.
  const tbd = { timeTBD: true, state: 'pre', startUTC: hoursAgo(48) };
  assert.equal(isFinished(tbd, NOW), false);
  // An explicit completion still counts, though.
  assert.equal(isFinished({ ...tbd, completed: true }, NOW), true);
});

test('missing fields are not treated as finished', () => {
  assert.equal(isFinished({}, NOW), false);
  assert.equal(isFinished({ startUTC: 'nonsense' }, NOW), false);
  assert.equal(isFinished(null, NOW), false);
});
