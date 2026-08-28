// Pairing an ESPN game with its Kalshi market. A game that fails to match reads
// as "not on Kalshi", which is indistinguishable from one that genuinely has no
// market - so a silent failure here is invisible. Both bugs found this way are
// pinned below.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEventTicker, gameDates, eventMatchesGame, marketForTeam } from '../public/simulate.mjs';

const team = (name, short, abbrev, location) => ({ name, short, abbrev, location });
const game = (over) => ({
  date: '2026-08-29',
  home: team('Virginia Cavaliers', 'Virginia', 'UVA', 'Virginia'),
  away: team('Coastal Carolina Chanticleers', 'Coastal Car', 'CCU', 'Coastal Carolina'),
  ...over,
});
const ev = (ticker, title) => ({ ticker, title, subtitle: null, markets: [] });

test('an event ticker yields its date and team segment', () => {
  assert.deepEqual(parseEventTicker('KXNFLGAME-26SEP13TBCIN'),
    { date: '2026-09-13', teams: 'TBCIN' });
  assert.deepEqual(parseEventTicker('KXNCAAFGAME-26AUG30CCUUVA'),
    { date: '2026-08-30', teams: 'CCUUVA' });
  assert.equal(parseEventTicker('NOT-A-TICKER'), null);
  assert.equal(parseEventTicker(''), null);
  assert.equal(parseEventTicker('KXNFLGAME-26XXX13TBCIN'), null);   // bad month
});

test('a day game is filed under one date only', () => {
  // Noon Mountain is the same calendar day everywhere that matters.
  assert.deepEqual(gameDates(game({ startUTC: '2026-08-29T18:00:00Z' })), ['2026-08-29']);
});

test('an evening game is also filed under the next day in UTC', () => {
  // 8pm Mountain is already tomorrow in UTC. Kalshi stamps its own date into
  // the ticker, so comparing only against the Mountain date made every night
  // game read as having no market at all.
  const d = gameDates(game({ startUTC: '2026-08-30T02:00:00Z' }));
  assert.ok(d.includes('2026-08-29'), 'the Mountain date must come first');
  assert.equal(d[0], '2026-08-29');
  assert.ok(d.includes('2026-08-30'), 'the UTC date must be a candidate');
});

test('a late game is also filed under the next day in Eastern', () => {
  // 10:30pm Mountain is 12:30am Eastern.
  const d = gameDates(game({ startUTC: '2026-08-30T04:30:00Z' }));
  assert.ok(d.includes('2026-08-29') && d.includes('2026-08-30'));
});

test('a game with no start time falls back to its own date', () => {
  assert.deepEqual(gameDates({ date: '2026-08-29' }), ['2026-08-29']);
  assert.deepEqual(gameDates({ date: '2026-08-29', startUTC: 'nonsense' }), ['2026-08-29']);
});

test('a night game matches a ticker dated the following day', () => {
  const g = game({ startUTC: '2026-08-30T02:00:00Z' });
  const t = 'KXNCAAFGAME-26AUG30CCUUVA';
  assert.equal(eventMatchesGame(ev(t, 'Coastal Carolina vs Virginia'), g, parseEventTicker(t)), true);
});

test('the same-day ticker still matches, by abbreviation pair in either order', () => {
  const g = game({ startUTC: '2026-08-29T18:00:00Z' });
  for (const t of ['KXNCAAFGAME-26AUG29CCUUVA', 'KXNCAAFGAME-26AUG29UVACCU']) {
    assert.equal(eventMatchesGame(ev(t, 'x'), g, parseEventTicker(t)), true, t);
  }
});

test('city names in the title carry a match when abbreviations do not', () => {
  const g = game({ startUTC: '2026-08-29T18:00:00Z',
    home: team('Virginia Cavaliers', 'Virginia', 'ZZZ', 'Virginia') });
  const t = 'KXNCAAFGAME-26AUG29QQQWWW';
  assert.equal(eventMatchesGame(ev(t, 'Coastal Carolina vs Virginia'), g, parseEventTicker(t)), true);
});

test('off the primary date only an exact abbreviation pair counts', () => {
  // The looser title check could otherwise pair a team with its own game a day
  // later, so it is not allowed to reach across a date boundary.
  const g = game({ startUTC: '2026-08-30T02:00:00Z',
    home: team('Virginia Cavaliers', 'Virginia', 'ZZZ', 'Virginia') });
  const t = 'KXNCAAFGAME-26AUG30QQQWWW';
  assert.equal(eventMatchesGame(ev(t, 'Coastal Carolina vs Virginia'), g, parseEventTicker(t)), false);
});

test('an unrelated date never matches', () => {
  const g = game({ startUTC: '2026-08-29T18:00:00Z' });
  const t = 'KXNCAAFGAME-26SEP05CCUUVA';
  assert.equal(eventMatchesGame(ev(t, 'Coastal Carolina vs Virginia'), g, parseEventTicker(t)), false);
});

test('a different matchup on the same date does not match', () => {
  const g = game({ startUTC: '2026-08-29T18:00:00Z' });
  const t = 'KXNCAAFGAME-26AUG29ALAWIS';
  assert.equal(eventMatchesGame(ev(t, 'Alabama vs Wisconsin'), g, parseEventTicker(t)), false);
});

test('the right market is picked out of an event by ticker suffix', () => {
  const e = { ticker: 'KXNCAAFGAME-26AUG30CCUUVA', title: 'Coastal Carolina vs Virginia',
    markets: [
      { ticker: 'KXNCAAFGAME-26AUG30CCUUVA-UVA', title: 'Virginia' },
      { ticker: 'KXNCAAFGAME-26AUG30CCUUVA-CCU', title: 'Coastal Carolina' },
    ] };
  assert.equal(marketForTeam(e, team('Virginia Cavaliers', 'Virginia', 'UVA', 'Virginia')).title, 'Virginia');
  assert.equal(marketForTeam(e, team('Coastal Carolina Chanticleers', 'Coastal Car', 'CCU', 'Coastal Carolina')).title,
    'Coastal Carolina');
  assert.equal(marketForTeam(e, team('Alabama Crimson Tide', 'Alabama', 'ALA', 'Alabama')), null);
});

test('a market is found by name when the suffix does not match', () => {
  const e = { ticker: 'KXNCAAFGAME-26AUG30CCUUVA', title: 'x', markets: [
    { ticker: 'KXNCAAFGAME-26AUG30CCUUVA-1', title: 'Virginia to win' },
  ] };
  assert.equal(marketForTeam(e, team('Virginia Cavaliers', 'Virginia', 'ZZZ', 'Virginia')).title,
    'Virginia to win');
});
