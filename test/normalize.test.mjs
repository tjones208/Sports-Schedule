// Verifies the ESPN -> app normalization against fixtures shaped like real
// scoreboard payloads. Run with: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent, extractNetworks } from '../lib/normalize.mjs';
import { LEAGUES } from '../lib/leagues.mjs';

const nflEvent = {
  id: '401800001',
  date: '2026-09-14T00:20Z',
  name: 'Dallas Cowboys at New York Giants',
  week: { number: 1 },
  season: { slug: 'regular-season' },
  competitions: [{
    timeValid: true,
    neutralSite: false,
    venue: { fullName: 'MetLife Stadium', address: { city: 'East Rutherford', state: 'NJ' } },
    status: { type: { name: 'STATUS_SCHEDULED' } },
    broadcasts: [{ market: 'national', names: ['NBC'] }],
    geoBroadcasts: [{ media: { shortName: 'NBC' }, market: { type: 'National' }, type: { shortName: 'TV' } }],
    competitors: [
      { homeAway: 'home', team: { id: '19', displayName: 'New York Giants', shortDisplayName: 'Giants', abbreviation: 'NYG', color: '0b2265', logo: 'https://a.espncdn.com/nyg.png' } },
      { homeAway: 'away', team: { id: '6', displayName: 'Dallas Cowboys', shortDisplayName: 'Cowboys', abbreviation: 'DAL', color: '002244', logo: 'https://a.espncdn.com/dal.png' } },
    ],
  }],
};

test('normalizes an NFL night game into Mountain time', () => {
  const g = normalizeEvent(nflEvent, LEAGUES.nfl);
  // 00:20 UTC on the 14th is 6:20 PM on the 13th in Denver (MDT in September)
  assert.equal(g.date, '2026-09-13');
  assert.equal(g.time, '6:20 PM');
  assert.equal(g.tz, 'MDT');
  assert.equal(g.weekday, 'Sun');
  assert.equal(g.home.name, 'New York Giants');
  assert.equal(g.away.name, 'Dallas Cowboys');
  assert.deepEqual(g.networks, ['NBC']);
  assert.equal(g.national, true);
  assert.equal(g.venue.city, 'East Rutherford');
  assert.equal(g.league, 'nfl');
  assert.equal(g.week, 1);
});

test('strict MST mode drops the daylight-saving hour', () => {
  const g = normalizeEvent(nflEvent, LEAGUES.nfl, 'mst');
  assert.equal(g.time, '5:20 PM');
  assert.equal(g.tz, 'MST');
});

test('merges networks from both ESPN shapes without duplicating', () => {
  const { networks, national } = extractNetworks({
    broadcasts: [{ market: 'national', names: ['ESPN', 'ESPN2'] }],
    geoBroadcasts: [{ media: { shortName: 'ESPN' }, market: { type: 'National' } }],
  });
  assert.deepEqual(networks.sort(), ['ESPN', 'ESPN2']);
  assert.equal(national, true);
});

test('keeps AP rankings for college teams and flags neutral sites', () => {
  const g = normalizeEvent({
    id: '401700500',
    date: '2026-11-21T21:00Z',
    competitions: [{
      neutralSite: true,
      notes: [{ headline: 'Maui Invitational' }],
      venue: { fullName: 'Lahaina Civic Center', address: { city: 'Lahaina', state: 'HI' } },
      broadcasts: [{ market: 'national', names: ['ESPN2'] }],
      competitors: [
        { homeAway: 'home', team: { displayName: 'Duke Blue Devils', abbreviation: 'DUKE' }, curatedRank: { current: 3 } },
        { homeAway: 'away', team: { displayName: 'Kansas Jayhawks', abbreviation: 'KU' }, curatedRank: { current: 99 } },
      ],
    }],
  }, LEAGUES.ncaab);
  assert.equal(g.home.rank, 3);
  assert.equal(g.away.rank, null, 'unranked teams use 99 as a sentinel and must be dropped');
  assert.equal(g.neutralSite, true);
  assert.equal(g.notes, 'Maui Invitational');
  assert.equal(g.time, '2:00 PM');
});

test('marks unannounced tip times as TBD and sorts them last', () => {
  const g = normalizeEvent({
    id: '401700600',
    date: '2026-12-05T00:00Z',
    competitions: [{
      timeValid: false,
      status: { type: { name: 'STATUS_SCHEDULED' } },
      broadcasts: [],
      competitors: [
        { homeAway: 'home', team: { displayName: 'Gonzaga Bulldogs' } },
        { homeAway: 'away', team: { displayName: 'Santa Clara Broncos' } },
      ],
    }],
  }, LEAGUES.ncaab);
  assert.equal(g.time, 'TBD');
  assert.equal(g.timeTBD, true);
  assert.equal(g.sortKey, 9999);
  assert.deepEqual(g.networks, []);
});

test('skips malformed events instead of throwing', () => {
  assert.equal(normalizeEvent({ id: 'x', date: '2026-01-01T00:00Z', competitions: [] }, LEAGUES.nfl), null);
  assert.equal(normalizeEvent({ id: 'x', date: 'not-a-date', competitions: [{ competitors: [
    { homeAway: 'home', team: {} }, { homeAway: 'away', team: {} }] }] }, LEAGUES.nfl), null);
});
