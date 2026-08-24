// Betting-market math: implied probability, vig removal, and Kelly sizing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  americanToProb, devig, spreadToProb, kelly, expectedValue,
  extractOdds, fairProbabilities, fairProbabilityConsensus, DEVIG_METHODS,
} from '../lib/odds.mjs';

const close = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;

test('american odds convert to implied probability', () => {
  assert.ok(close(americanToProb(-165), 0.622641));
  assert.ok(close(americanToProb(140), 0.416667));
  assert.ok(close(americanToProb(-110), 0.523810));
  assert.ok(close(americanToProb(100), 0.5));
  assert.equal(americanToProb(0), null);
  assert.equal(americanToProb('n/a'), null);
  assert.ok(close(americanToProb('-165'), 0.622641), 'string moneylines are accepted');
});

test('devigging removes the overround and normalises to 1', () => {
  const d = devig(americanToProb(-110), americanToProb(-110));
  assert.ok(close(d.a, 0.5) && close(d.b, 0.5));
  assert.ok(close(d.overround, 0.047619), 'standard -110/-110 is a 4.76% overround');
  const sum = d.a + d.b;
  assert.ok(close(sum, 1), 'fair probabilities must sum to exactly 1');
});

test('spread converts to a plausible win probability', () => {
  assert.ok(close(spreadToProb(0, 'nfl'), 0.5), 'a pick-em is a coin flip');
  const fav = spreadToProb(-3.5, 'nfl');
  assert.ok(fav > 0.58 && fav < 0.63, `NFL -3.5 should be about 60%, got ${fav}`);
  const dog = spreadToProb(3.5, 'nfl');
  assert.ok(close(fav + dog, 1), 'both sides must sum to 1');
  // A 40-point college spread is close to a certainty
  assert.ok(spreadToProb(-40.5, 'ncaaf') > 0.99);
  // The same spread is worth more in a low-scoring sport
  assert.ok(spreadToProb(-2, 'nhl') > spreadToProb(-2, 'nba'));
});

test('kelly sizes a real edge and refuses a bad price', () => {
  const good = kelly(0.60, 42, 0.25);
  assert.ok(close(good.edge, 0.18));
  assert.ok(good.full > good.staked, 'fractional Kelly must stake less than full');
  assert.ok(close(good.staked, good.full * 0.25));

  assert.equal(kelly(0.42, 42, 0.25).staked, 0, 'no edge means no stake');
  assert.equal(kelly(0.30, 60, 0.25).staked, 0, 'negative edge never stakes');
  assert.equal(kelly(0.9, 0, 0.25), null, 'a 0c price is not tradeable');
  assert.equal(kelly(0.9, 100, 0.25), null, 'a 100c price has no upside');
});

test('expected value is positive only when the price is below fair', () => {
  assert.ok(expectedValue(0.60, 42) > 0);
  assert.ok(expectedValue(0.40, 42) < 0);
  assert.ok(close(expectedValue(0.42, 42), 0), 'fair price has zero EV');
});

test('extracts ESPN odds across the shapes ESPN actually returns', () => {
  const flat = extractOdds({ odds: [{
    provider: { name: 'DraftKings' }, details: 'CIN -3.5', spread: -3.5, overUnder: 51.5,
    homeTeamOdds: { moneyLine: -180, favorite: true }, awayTeamOdds: { moneyLine: 155 },
  }] });
  assert.equal(flat.spread, -3.5);
  assert.equal(flat.total, 51.5);
  assert.equal(flat.homeML, -180);
  assert.equal(flat.awayML, 155);

  // Far-out games nest the moneyline instead of exposing it on the team object
  const nested = extractOdds({ odds: [{
    provider: { name: 'ESPN BET' }, spread: -7,
    moneyline: { home: { close: { odds: '-320' } }, away: { current: { odds: '+250' } } },
  }] });
  assert.equal(nested.homeML, -320);
  assert.equal(nested.awayML, 250);

  assert.equal(extractOdds({}), null, 'a game with no line returns null');
});

test('fair probabilities prefer moneylines and fall back to the spread', () => {
  const fromML = fairProbabilities(
    { homeML: -165, awayML: 140, spread: -3.5 }, 'nfl');
  assert.equal(fromML.source, 'moneyline');
  assert.ok(close(fromML.home + fromML.away, 1));
  assert.ok(fromML.overround > 0);

  const fromSpread = fairProbabilities({ homeML: null, awayML: null, spread: -3.5 }, 'nfl');
  assert.equal(fromSpread.source, 'spread');
  assert.ok(fromSpread.home > 0.5);

  assert.equal(fairProbabilities({ homeML: null, awayML: null, spread: null }, 'nfl'), null);
  assert.equal(fairProbabilities(null, 'nfl'), null);
});


test('every devig method returns a proper probability pair', () => {
  for (const m of DEVIG_METHODS) {
    const d = devig(americanToProb(-320), americanToProb(250), m);
    assert.ok(close(d.a + d.b, 1, 1e-9), `${m} must sum to 1`);
    assert.ok(d.a > 0 && d.a < 1 && d.b > 0 && d.b < 1, `${m} must stay inside (0,1)`);
    assert.ok(d.a > d.b, `${m} must keep the favourite ahead`);
  }
});

test('multiplicative devig gives the underdog the most probability', () => {
  // This is the whole reason a multiplicative-only model favours underdogs:
  // it assumes margin is proportional to price, so the longshot keeps too much.
  const raw = [americanToProb(-320), americanToProb(250)];
  const dog = (m) => devig(raw[0], raw[1], m).b;
  for (const m of ['additive', 'power', 'shin']) {
    assert.ok(dog('multiplicative') > dog(m),
      `multiplicative should credit the underdog more than ${m}`);
  }
  // And the gap widens as the game gets more lopsided.
  const longshot = [americanToProb(-1200), americanToProb(750)];
  const gapBig = devig(longshot[0], longshot[1], 'multiplicative').b
    - devig(longshot[0], longshot[1], 'power').b;
  const gapSmall = dog('multiplicative') - dog('power');
  assert.ok(gapBig > gapSmall, 'the bias grows with the price of the longshot');
});

test('methods barely disagree on a coin flip and diverge on a lopsided game', () => {
  const flip = fairProbabilityConsensus({ homeML: -115, awayML: -105 }, 'nfl');
  const lopsided = fairProbabilityConsensus({ homeML: -1200, awayML: 750 }, 'nfl');
  assert.ok(flip.awaySpread < 0.005, 'near 50/50 the method hardly matters');
  assert.ok(lopsided.awaySpread > 0.02, 'on a longshot the method is worth points');
  assert.ok(lopsided.awaySpread > flip.awaySpread * 5);
});

test('consensus takes the most conservative estimate for each side', () => {
  const c = fairProbabilityConsensus({ homeML: -320, awayML: 250 }, 'nfl');
  const homes = DEVIG_METHODS.map((m) => c.byMethod[m].home);
  const aways = DEVIG_METHODS.map((m) => c.byMethod[m].away);
  assert.ok(close(c.home, Math.min(...homes)));
  assert.ok(close(c.away, Math.min(...aways)));
  assert.ok(c.home + c.away < 1, 'being conservative on both sides cannot sum to 1');
  assert.equal(fairProbabilityConsensus({ homeML: null, awayML: null, spread: null }, 'nfl'), null);
});
