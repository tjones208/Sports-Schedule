// Two ESPN endpoints carry the pregame projection in different shapes, and
// which one answers depends on the sport. These pin the parsing of both, plus
// the fallback order, so a sport served by only one still populates.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fromSummary, fromCorePredictor, fetchProjection } from '../lib/projection.mjs';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

const CORE = {
  homeTeam: { statistics: [
    { name: 'gameProjection', value: 67.3 },
    { name: 'teamPredPtDiff', value: 4.5 },
    { name: 'matchupQuality', value: 61.2 },
  ] },
  awayTeam: { statistics: [{ name: 'gameProjection', value: 32.7 }] },
};

// The site summary reports the same numbers as STRINGS.
const SUMMARY = {
  predictor: {
    header: 'Matchup Predictor',
    homeTeam: { id: '9', gameProjection: '67.3', teamChanceLoss: '32.7' },
    awayTeam: { id: '21', gameProjection: '32.7', teamChanceLoss: '67.3' },
  },
};

test('the core shape parses, numbers and all', () => {
  const r = fromCorePredictor(CORE);
  close(r.homeWin, 0.673); close(r.awayWin, 0.327);
  assert.equal(r.source, 'core');
  assert.equal(r.stat, 'gameProjection');
  close(r.predPointDiff, 4.5);
  close(r.matchupQuality, 61.2);
});

test('the summary shape parses despite string values', () => {
  const r = fromSummary(SUMMARY);
  close(r.homeWin, 0.673); close(r.awayWin, 0.327);
  assert.equal(r.source, 'summary');
});

test('both endpoints agree on the same game', () => {
  const a = fromCorePredictor(CORE);
  const b = fromSummary(SUMMARY);
  close(a.homeWin, b.homeWin);
  close(a.awayWin, b.awayWin);
});

test('one populated side implies the other', () => {
  const r = fromSummary({ predictor: { homeTeam: { gameProjection: '71.0' }, awayTeam: {} } });
  close(r.homeWin, 0.71);
  close(r.awayWin, 0.29);
});

test('a chance-of-loss field is read as its complement', () => {
  const r = fromSummary({ predictor: { homeTeam: { teamChanceLoss: '40.0' }, awayTeam: {} } });
  close(r.homeWin, 0.60);
  close(r.awayWin, 0.40);
  assert.equal(r.stat, 'teamChanceLoss');
});

test('fractions and percentages both normalise to 0..1', () => {
  close(fromSummary({ predictor: { homeTeam: { gameProjection: '0.82' }, awayTeam: {} } }).homeWin, 0.82);
  close(fromSummary({ predictor: { homeTeam: { gameProjection: '82' }, awayTeam: {} } }).homeWin, 0.82);
});

test('an absent or empty predictor yields nothing rather than a fake number', () => {
  assert.equal(fromSummary({}), null);
  assert.equal(fromSummary({ predictor: {} }), null);
  assert.equal(fromSummary(null), null);
  assert.equal(fromCorePredictor({ homeTeam: { statistics: [] } }), null);
  assert.equal(fromCorePredictor(null), null);
  // Stats present but none of them a projection.
  assert.equal(fromCorePredictor({ homeTeam: { statistics: [{ name: 'matchupQuality', value: 5 }] } }), null);
});

test('the summary is used when the core endpoint 404s - the NBA case', () => {
  const calls = [];
  const fetchJSON = async (url) => {
    calls.push(url);
    if (url.includes('sports.core.api')) throw new Error('HTTP 404');
    return SUMMARY;
  };
  return fetchProjection({
    sitePath: 'basketball/nba', corePath: 'basketball/leagues/nba', id: '401', fetchJSON,
  }).then((r) => {
    close(r.homeWin, 0.673);
    assert.equal(r.source, 'summary');
    assert.equal(calls.length, 2, 'should try core first, then fall back');
    assert.match(calls[0], /sports\.core\.api/);
    assert.match(calls[1], /summary\?event=401/);
  });
});

test('the core endpoint short-circuits the fallback when it answers', async () => {
  const calls = [];
  const r = await fetchProjection({
    sitePath: 'football/nfl', corePath: 'football/leagues/nfl', id: '77',
    fetchJSON: async (url) => { calls.push(url); return CORE; },
  });
  assert.equal(r.source, 'core');
  assert.equal(calls.length, 1, 'no second request when the first works');
});

test('a preloaded summary avoids the network entirely', async () => {
  let called = 0;
  const r = await fetchProjection({
    sitePath: 'football/nfl', corePath: 'football/leagues/nfl', id: '5',
    fetchJSON: async () => { called++; return CORE; },
    preloadedSummary: SUMMARY,
  });
  assert.equal(called, 0);
  assert.equal(r.source, 'summary');
  close(r.homeWin, 0.673);
});

test('both endpoints failing reports null, not a guess', async () => {
  const r = await fetchProjection({
    sitePath: 'hockey/nhl', corePath: 'hockey/leagues/nhl', id: '1',
    fetchJSON: async () => { throw new Error('HTTP 500'); },
  });
  assert.equal(r.homeWin, null);
  assert.equal(r.awayWin, null);
  assert.equal(r.source, null);
  assert.equal(r.coreErr, 'HTTP 500');
});
