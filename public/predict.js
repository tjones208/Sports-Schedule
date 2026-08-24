/* Prediction Desk - Kalshi market edges, position tracking and bankroll.
   Read-only against Kalshi: it never authenticates and never places an order.
   Positions live in this browser's localStorage. */

const STORE_KEY = 'ss:desk';
const GAME_SERIES = {
  nfl: 'KXNFLGAME', nba: 'KXNBAGAME', nhl: 'KXNHLGAME',
  ncaaf: 'KXNCAAFGAME', ncaab: 'KXNCAABGAME',
};
const LEAGUE_LABEL = { nfl:'NFL', nba:'NBA', nhl:'NHL', ncaaf:'CFB', ncaab:'CBB', other:'Other' };
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

const DEFAULTS = {
  bankroll: 5000,
  kellyFraction: 0.25,
  maxStakePct: 0.05,
  minEdgePts: 3,
  feeRole: 'taker',      // you are usually crossing the spread to hit an ask
  fpiWeight: 0.35,       // how much the ESPN model counts in the blend
  sortBy: 'edge',        // edge | date | stake | price
  bothSides: false,      // one row per game unless asked for both

  // FPI strategy tab. The discount is the headline number from the college
  // football backtest: how far below ESPN's own price Kalshi has to be before
  // buying at that price has been worth it historically.
  fpiDiscountPts: 5,
  fpiAddFee: false,      // treat the discount as a margin on top of the fee
  fpiLowPct: 50,
  fpiHighPct: 100,
  fpiContracts: 100,     // the backtest sized every game at 100 contracts
  fpiBothSides: false,
  fpiTriggersOnly: false,
  fpiQuotedOnly: true,
  fpiLeague: 'all',
  fpiSort: 'surplus',

  positions: [],
};

// Kalshi published fee schedule: 7% of C x P x (1-P), makers pay a quarter.
const TAKER_RATE = 0.07;
const MAKER_MULTIPLIER = 0.25;

function feePerContractCents(priceCents, role) {
  const p = Number(priceCents) / 100;
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  const rate = role === 'maker' ? TAKER_RATE * MAKER_MULTIPLIER : TAKER_RATE;
  return rate * p * (1 - p) * 100;
}
function orderFeeDollars(contracts, priceCents, role) {
  const n = Number(contracts), p = Number(priceCents) / 100;
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  const rate = role === 'maker' ? TAKER_RATE * MAKER_MULTIPLIER : TAKER_RATE;
  return Math.ceil(Number((rate * n * p * (1 - p) * 100).toFixed(9))) / 100;
}
const effectivePriceCents = (c, role) => Number(c) + feePerContractCents(c, role);

let state = load();
let games = [];        // ESPN games for the selected league
let kalshiEvents = []; // open Kalshi events for that league
let matched = [];      // joined rows
let fpiCache = new Map(); // ESPN FPI projections by raw event id
let tab = 'edges';
let dateFrom = '';
let dateTo = '';

/* ---------- storage ---------- */

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return { ...DEFAULTS, ...raw, positions: Array.isArray(raw.positions) ? raw.positions : [] };
  } catch { return { ...DEFAULTS }; }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch { toast('Could not save - this browser is blocking local storage.'); }
}

/* ---------- helpers ---------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const money = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n, d = 1) => `${(n * 100).toFixed(d)}%`;
const pts = (n) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}`;
const cents = (c) => (c == null ? '--'
  : `${Number.isInteger(Number(c)) ? c : Number(c).toFixed(1)}\u00A2`);
function todayMT() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
const uid = () => `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

function toast(msg) {
  const el = document.getElementById('notice');
  el.classList.remove('hidden');
  el.dataset.tone = 'info';
  el.innerHTML = `<div>${esc(msg)}</div>`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add('hidden'), 6000);
}

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) {
    let d = `${r.status}`;
    try { const j = await r.json(); if (j.error) d = j.error; } catch {}
    throw new Error(d);
  }
  return r.json();
}

/* ---------- Kalshi <-> ESPN matching ---------- */

/** KXNFLGAME-26OCT20BOSDET -> { date: '2026-10-20', teams: 'BOSDET' } */
function parseEventTicker(ticker) {
  const m = /-(\d{2})([A-Z]{3})(\d{2})([A-Z0-9]*)$/.exec(ticker || '');
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]);
  if (month < 0) return null;
  return {
    date: `20${m[1]}-${String(month + 1).padStart(2, '0')}-${m[3]}`,
    teams: m[4] || '',
  };
}

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z]/g, '');

/**
 * Does this Kalshi event refer to this ESPN game?
 *
 * Kalshi encodes the pairing in the ticker as AWAY+HOME abbreviations
 * (KXNFLGAME-26SEP13TBCIN) and titles it by city ("Tampa Bay vs Cincinnati").
 * Abbreviations alone are unreliable - "TB" and "GB" are two letters and would
 * match almost anything - so the ticker segment is checked as a pair, with the
 * city names as the fallback.
 */
function eventMatchesGame(ev, game, parsed) {
  if (parsed.date !== game.date) return false;

  const seg = norm(parsed.teams);
  const away = norm(game.away.abbrev);
  const home = norm(game.home.abbrev);

  // Strongest signal: the segment is exactly the two abbreviations, in order.
  if (seg && away && home) {
    if (seg === away + home) return true;
    if (seg === home + away) return true;
  }

  // Fallback: both cities appear in the event title.
  const hay = norm(`${ev.title} ${ev.subtitle || ''}`);
  const nameHit = (t) => [t.location, t.short, t.name]
    .filter(Boolean)
    .map(norm)
    .some((c) => c.length >= 4 && hay.includes(c));
  return nameHit(game.home) && nameHit(game.away);
}

/** Which market in the event is "this team wins"? */
function marketForTeam(ev, team) {
  const ab = norm(team.abbrev);
  // Kalshi suffixes the market ticker with the team abbreviation.
  if (ab) {
    const bySuffix = ev.markets.find((m) => norm((m.ticker || '').split('-').pop()) === ab);
    if (bySuffix) return bySuffix;
  }
  const cands = [team.location, team.short, team.name].filter(Boolean).map(norm);
  return ev.markets.find((m) => {
    const hay = norm(m.title);
    return cands.some((c) => c.length >= 4 && hay.includes(c));
  }) || null;
}

/**
 * Days since each team last played, from the league schedule already loaded.
 * Short rest is a real effect the market prices in, and a large rest gap is
 * worth seeing next to a price.
 */
function computeRest(list) {
  const last = new Map();
  const byDate = list.slice().sort((a, b) => a.date.localeCompare(b.date));
  const days = (a, b) => Math.round(
    (Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);

  for (const g of byDate) {
    for (const side of ['home', 'away']) {
      const key = g[side].abbrev || g[side].name;
      const prev = last.get(key);
      g[`${side}Rest`] = prev ? days(prev, g.date) : null;
      last.set(key, g.date);
    }
  }
  return list;
}

/* ---------- edge math (mirrors lib/odds.mjs) ---------- */

/** Kelly against the fee-inclusive price: you risk (c + fee) to win (100 - c). */
function kellyNet(p, priceCents, fraction, role) {
  const c = Number(priceCents);
  if (!Number.isFinite(p) || !Number.isFinite(c) || c <= 0 || c >= 100) return null;
  const cost = effectivePriceCents(c, role) / 100;
  const win = (100 - effectivePriceCents(c, role)) / 100;
  if (cost <= 0 || cost >= 1 || win <= 0) return null;
  const b = win / cost;
  const full = (p * b - (1 - p)) / b;
  return { full: Math.max(0, full), staked: Math.max(0, full * fraction),
    edge: p - cost, breakeven: cost };
}
const grossEvCents = (p, c) => p * (100 - c) - (1 - p) * c;
const netEvCents = (p, c, role) => grossEvCents(p, c) - feePerContractCents(c, role);

/** Build the joined view: ESPN fair probability vs Kalshi ask, per side. */
function buildRows() {
  const rows = [];
  for (const ev of kalshiEvents) {
    const parsed = parseEventTicker(ev.ticker);
    if (!parsed) continue;
    const game = games.find((g) => eventMatchesGame(ev, g, parsed));
    if (!game || !game.fair) continue;

    const fpi = fpiCache.get(String(game.id).replace(/^[a-z]+-/, ''));

    for (const [side, team, fairP, fpiP] of [
      ['home', game.home, game.fair.home, fpi?.homeWin ?? null],
      ['away', game.away, game.fair.away, fpi?.awayWin ?? null],
    ]) {
      // Blend the book with the ESPN model. The book gets most of the weight:
      // it has real money behind it and updates continuously.
      const w = fpiP == null ? 0 : state.fpiWeight;
      const blend = fairP * (1 - w) + (fpiP ?? 0) * w;
      const disagree = fpiP == null ? null : Math.abs(fairP - fpiP);
      const mkt = marketForTeam(ev, team);
      if (!mkt) continue;
      const ask = mkt.yesAsk ?? mkt.last ?? null;
      const quoted = ask != null && ask > 0 && ask < 100;

      // Kalshi lists game markets well before it opens an order book on them,
      // so an unquoted market is normal - keep the row and mark it pending.
      if (!quoted) {
        rows.push({ game, kEvent: ev, mkt, side, team, fair: fairP, fpi: fpiP, blend,
          disagree, quoted: false, ask: null, edge: null, netEv: null,
          stakeDollars: 0, contracts: 0, fee: 0, source: game.fair.source });
        continue;
      }

      const k = kellyNet(blend, ask, state.kellyFraction, state.feeRole);
      if (!k) continue;
      const capped = Math.min(k.staked, state.maxStakePct);
      const stakeDollars = capped * state.bankroll;
      const contracts = Math.floor(stakeDollars / (ask / 100));
      rows.push({
        game, kEvent: ev, mkt, side, team, quoted: true,
        fair: fairP, fpi: fpiP, blend, disagree, ask,
        grossEdge: blend - ask / 100,
        edge: k.edge,                      // net of fees
        netEv: netEvCents(blend, ask, state.feeRole),
        grossEv: grossEvCents(blend, ask),
        breakeven: k.breakeven,
        kellyFull: k.full,
        stakeDollars, contracts,
        fee: orderFeeDollars(contracts, ask, state.feeRole),
        source: game.fair.source,
      });
    }
  }
  rows.sort((a, b) => (b.edge ?? -1) - (a.edge ?? -1));

  if (!state.bothSides) {
    // Both sides of a market can never both be worth taking, so show only the
    // better one. Rows are edge-sorted, so the first hit per game is the pick.
    const seen = new Set();
    return rows.filter((r) => {
      if (seen.has(r.game.id)) return false;
      seen.add(r.game.id);
      return true;
    });
  }
  return rows;
}

/* ---------- bankroll ---------- */

function positionCost(p) { return p.contracts * (p.entryPrice / 100); }

function positionPnl(p, markCents) {
  const cost = positionCost(p);
  if (p.status === 'won') return p.contracts * 1 - cost;
  if (p.status === 'lost') return -cost;
  if (p.status === 'closed') return p.contracts * ((p.exitPrice - p.entryPrice) / 100);
  if (markCents == null) return null;
  return p.contracts * ((markCents - p.entryPrice) / 100);
}

function bankrollSummary(marks) {
  const open = state.positions.filter((p) => p.status === 'open');
  const settled = state.positions.filter((p) => p.status !== 'open');

  const realized = settled.reduce((s, p) => s + (positionPnl(p) || 0), 0);
  const deployed = open.reduce((s, p) => s + positionCost(p), 0);
  let unrealized = 0;
  let marked = 0;
  for (const p of open) {
    const m = marks?.get(p.marketTicker);
    const mark = m ? (p.side === 'YES' ? m.yesBid : m.noBid) : null;
    const pl = positionPnl(p, mark);
    if (pl != null) { unrealized += pl; marked++; }
  }

  const wins = settled.filter((p) => (positionPnl(p) || 0) > 0).length;
  const staked = settled.reduce((s, p) => s + positionCost(p), 0);

  return {
    starting: state.bankroll,
    cash: state.bankroll + realized - deployed,
    deployed, realized, unrealized, marked,
    equity: state.bankroll + realized + unrealized,
    openCount: open.length,
    settledCount: settled.length,
    wins, losses: settled.length - wins,
    winRate: settled.length ? wins / settled.length : null,
    roi: staked ? realized / staked : null,
    exposure: state.bankroll ? deployed / state.bankroll : 0,
  };
}

let markCache = new Map();

function renderBank() {
  const s = bankrollSummary(markCache);
  const cell = (k, v, cls = '') => `<div class="bank-cell"><span class="n ${cls}">${v}</span><span class="k">${k}</span></div>`;
  const sign = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
  document.getElementById('bankbar').innerHTML = [
    cell('Equity', money(s.equity)),
    cell('Cash free', money(s.cash)),
    cell('Deployed', money(s.deployed)),
    cell('Realized P&L', money(s.realized), sign(s.realized)),
    cell('Unrealized', s.marked ? money(s.unrealized) : '--', sign(s.unrealized)),
    cell('Record', s.settledCount ? `${s.wins}-${s.losses}` : '--'),
    cell('Win rate', s.winRate == null ? '--' : pct(s.winRate, 0)),
    cell('ROI', s.roi == null ? '--' : pct(s.roi, 1), sign(s.roi || 0)),
    cell('Exposure', pct(s.exposure, 0), s.exposure > 0.35 ? 'down' : ''),
  ].join('');
  document.getElementById('posCount').textContent = String(s.openCount);
}

/* ---------- rendering: edges ---------- */

/** "6d/3d rest" when either side is on an unusual turnaround. */
function restNote(g) {
  const h = g.homeRest, a = g.awayRest;
  if (h == null && a == null) return '';
  const odd = (h != null && h <= 4) || (a != null && a <= 4)
    || (h != null && a != null && Math.abs(h - a) >= 3);
  if (!odd) return '';
  return ` &middot; <span class="restchip">rest ${a ?? '?'}d away / ${h ?? '?'}d home</span>`;
}

function renderEdges() {
  const el = document.getElementById('edges');
  const minEdge = state.minEdgePts / 100;
  const onlyEdges = document.getElementById('onlyEdges').checked;

  let rows = matched;
  if (dateFrom) rows = rows.filter((r) => r.game.date >= dateFrom);
  if (dateTo) rows = rows.filter((r) => r.game.date <= dateTo);
  if (onlyEdges) rows = rows.filter((r) => r.quoted && r.edge >= minEdge && r.netEv > 0);

  // Unquoted rows have no edge, price or stake to sort on, so they sink.
  const last = (v) => (v == null ? Number.NEGATIVE_INFINITY : v);
  const byDate = (a, b) => a.game.date.localeCompare(b.game.date)
    || (a.game.sortKey ?? 0) - (b.game.sortKey ?? 0)
    || last(b.edge) - last(a.edge);
  rows = rows.slice().sort(
    state.sortBy === 'date' ? byDate
      : state.sortBy === 'stake' ? ((a, b) => b.stakeDollars - a.stakeDollars || byDate(a, b))
        : state.sortBy === 'price' ? ((a, b) => (a.ask ?? 999) - (b.ask ?? 999) || byDate(a, b))
          : ((a, b) => last(b.edge) - last(a.edge) || byDate(a, b)),
  );

  if (!rows.length) {
    const ranged = dateFrom || dateTo;
    el.innerHTML = `<div class="empty">
      <h3>No qualifying edges${ranged ? ' in that date range' : ''}</h3>
      <p>${matched.length
        ? (matched.some((r) => r.quoted)
          ? `${matched.length} market${matched.length === 1 ? '' : 's'} matched, but none clear a ${state.minEdgePts}-point edge. Lower the threshold or untick <em>Only +EV</em> to see them all.`
          : `${matched.length} markets matched their games, but Kalshi has not opened an order book on any of them yet, so there is no price to compare against. Untick <em>Only +EV</em> to see the matched slate. Quotes usually appear in the days before kickoff.`)
        : 'No Kalshi markets line up with a game that has a posted betting line yet.'}</p>
    </div>`;
    return;
  }

  el.innerHTML = `<div class="tablewrap"><table class="tbl">
    <thead><tr>
      <th>Game</th><th>Pick</th>
      <th class="r">Book</th><th class="r">ESPN FPI</th><th class="r">Blend</th>
      <th class="r">Kalshi ask</th><th class="r">Net edge</th><th class="r">Net EV</th>
      <th class="r">Stake</th><th></th>
    </tr></thead><tbody>
    ${rows.map((r, i) => {
      const g = r.game;
      const good = r.quoted && r.edge >= minEdge && r.netEv > 0;
      return `<tr class="${good ? 'good' : ''}">
        <td data-label="Game">
          <div class="g-teams">${esc(g.away.short || g.away.name)} at ${esc(g.home.short || g.home.name)}</div>
          <div class="g-meta">${esc(g.weekday)} ${esc(g.date)} &middot; ${esc(g.time)} ${esc(g.tz)}
            ${g.networks?.length ? `&middot; ${esc(g.networks.join(', '))}` : ''}${restNote(g)}</div>
        </td>
        <td data-label="Pick"><strong>${esc(r.team.short || r.team.name)}</strong>
          <div class="g-meta">${r.source === 'spread' ? 'from spread' : 'from moneyline'}</div>
          ${r.disagree != null && r.disagree >= 0.08
            ? `<div class="g-meta"><span class="warnchip">models differ ${pts(r.disagree)}</span></div>` : ''}</td>
        <td class="r mono" data-label="Book">${pct(r.fair, 1)}</td>
        <td class="r mono" data-label="ESPN FPI">${r.fpi == null ? '<span class="pending">--</span>' : pct(r.fpi, 1)}</td>
        <td class="r mono" data-label="Blend"><strong>${pct(r.blend, 1)}</strong></td>
        <td class="r mono" data-label="Kalshi ask">${r.quoted ? cents(r.ask) : '<span class="pending">no book</span>'}</td>
        <td class="r mono" data-label="Net edge" data-tone="${!r.quoted ? '' : r.edge > 0 ? 'up' : 'down'}">${
          r.quoted ? `${pts(r.edge)}<div class="g-meta">${pts(r.grossEdge)} gross</div>` : '--'}</td>
        <td class="r mono" data-label="Net EV" data-tone="${!r.quoted ? '' : r.netEv > 0 ? 'up' : 'down'}">${
          r.quoted ? `${r.netEv.toFixed(1)}&cent;` : '--'}</td>
        <td class="r mono" data-label="Stake">${r.quoted
          ? `${money(r.stakeDollars)}<div class="g-meta">${r.contracts} @ ${cents(r.ask)} &middot; ${money(r.fee)} fee</div>`
          : '--'}</td>
        <td class="r act"><button class="btn sm" data-log="${i}"${r.quoted ? '' : ' disabled'}>Log</button></td>
      </tr>`;
    }).join('')}
  </tbody></table></div>
  ${dateFrom || dateTo ? `<p class="fineprint">Showing games${
    dateFrom ? ` from <strong>${esc(dateFrom)}</strong>` : ''}${
    dateTo ? ` to <strong>${esc(dateTo)}</strong>` : ''} &mdash; ${rows.length} of ${matched.length} markets.</p>` : ''}
  <p class="fineprint"><strong>Book</strong> is the sportsbook line with the vig removed.
  <strong>ESPN FPI</strong> is ESPN's own model, independent of the betting line.
  <strong>Blend</strong> weights them ${pct(1 - state.fpiWeight, 0)}/${pct(state.fpiWeight, 0)} and is what
  the edge and stake are computed from. <strong>Net edge</strong> and <strong>Net EV</strong> are
  after Kalshi's ${state.feeRole} fee, which peaks at 1.75&cent; per contract near 50&cent; -
  that is why a thin gross edge often nets out to nothing. Stake is
  ${pct(state.kellyFraction, 0)} Kelly on the fee-inclusive price, capped at
  ${pct(state.maxStakePct, 0)} of bankroll.</p>`;

  el.querySelectorAll('[data-log]').forEach((b) => {
    b.addEventListener('click', () => openLog(rows[Number(b.dataset.log)]));
  });
}

/* ---------- FPI strategy tab ----------

   A single, mechanical rule, kept deliberately separate from the Edges tab:

     buy when the Kalshi ask sits at least N points below ESPN's own FPI price.

   The Edges tab blends the sportsbook line with FPI and sizes by Kelly. This
   tab does none of that. It takes FPI at face value, subtracts a fixed
   discount, and tells you whether the market is offering that price. That is
   exactly the rule the college-football backtest measured, so the numbers here
   mean the same thing the backtest numbers meant.

   Calibration caveat, repeated on screen: the discount was fitted on FBS
   college football only (2023-2025). NFL, NBA, NHL and college basketball are
   shown because you asked for every sport, but no equivalent backtest has been
   run on them.                                                              */

const ALL_LEAGUES = ['nfl', 'ncaaf', 'nba', 'nhl', 'ncaab'];
const FPI_WINDOW_DAYS = 14;
const FPI_MAX_IDS_PER_LEAGUE = 240;

// Pooled 2023-2025 FBS requirement by FPI band, and the worst single season.
// Shown as a reference so you can set the discount per band rather than flat.
const BAND_REFERENCE = [
  { lo: 50, hi: 60, pooled: 3.42, worst: 6.52, fee: 1.73, games: 584 },
  { lo: 60, hi: 70, pooled: 2.31, worst: 7.80, fee: 1.59, games: 518 },
  { lo: 70, hi: 80, pooled: 3.36, worst: 5.05, fee: 1.31, games: 512 },
  { lo: 80, hi: 90, pooled: -1.00, worst: 2.00, fee: 0.91, games: 438 },
  { lo: 90, hi: 100, pooled: 1.00, worst: 1.34, fee: 0.34, games: 344 },
];

let fpiRows = [];          // every matched side, before filters
let fpiDiag = [];          // per-league load report
let fpiLoading = false;
let fpiLoaded = false;
let fpiFrom = '';
let fpiTo = '';

/* ---------- loading ---------- */

async function loadFpiUniverse() {
  if (fpiLoading) return;
  fpiLoading = true;
  fpiRows = [];
  fpiDiag = [];

  const from = fpiFrom || todayMT();
  const to = fpiTo || addDays(from, FPI_WINDOW_DAYS);
  const el = document.getElementById('fpiOut');
  el.innerHTML = `<div class="empty"><h3>Loading every sport</h3>
    <p>Pulling schedules, Kalshi order books and ESPN FPI projections for
    <strong>${esc(from)}</strong> to <strong>${esc(to)}</strong> across NFL, college football,
    NBA, NHL and college basketball. This is five sports at once, so give it a few seconds.</p></div>`;

  const perLeague = await Promise.all(ALL_LEAGUES.map(async (league) => {
    const [sRes, kRes] = await Promise.allSettled([
      getJSON(`/api/schedule?league=${league}&start=${from}&end=${to}`),
      getJSON(`/api/kalshi?series=${GAME_SERIES[league]}`),
    ]);

    // Out of season, the schedule endpoint reports "no games" rather than an
    // outage. That is an empty league, not a failure, and should not read as one.
    const noGames = sRes.status === 'rejected' && /no games/i.test(sRes.reason.message || '');
    const games = sRes.status === 'fulfilled' ? (sRes.value.games || []) : [];
    const events = kRes.status === 'fulfilled' ? (kRes.value.events || []) : [];

    const pairs = [];
    for (const ev of events) {
      const parsed = parseEventTicker(ev.ticker);
      if (!parsed) continue;
      const game = games.find((g) => eventMatchesGame(ev, g, parsed));
      if (game) pairs.push({ game, ev });
    }

    return {
      league, games, events, pairs, noGames,
      scheduleError: sRes.status === 'rejected' && !noGames ? sRes.reason.message : null,
      kalshiError: kRes.status === 'rejected' ? kRes.reason.message : null,
    };
  }));

  // FPI, one batched call per 60 matched games. Only matched games are asked
  // for - an unmatched game has no market to compare a projection against.
  await Promise.all(perLeague.map(async (L) => {
    const ids = [...new Set(L.pairs.map((p) => String(p.game.id).replace(/^[a-z]+-/, '')))]
      .slice(0, FPI_MAX_IDS_PER_LEAGUE);
    L.fpi = new Map();
    for (let i = 0; i < ids.length; i += 60) {
      try {
        const j = await getJSON(`/api/predictor?league=${L.league}&ids=${ids.slice(i, i + 60).join(',')}`);
        for (const [k, v] of Object.entries(j.predictions || {})) L.fpi.set(k, v);
      } catch { /* a league without projections simply contributes no rows */ }
    }
  }));

  const rows = [];
  for (const L of perLeague) {
    let withFpi = 0;
    for (const { game, ev } of L.pairs) {
      const p = L.fpi.get(String(game.id).replace(/^[a-z]+-/, ''));
      if (!p) continue;
      withFpi++;
      for (const [side, team, opp, prob] of [
        ['home', game.home, game.away, p.homeWin],
        ['away', game.away, game.home, p.awayWin],
      ]) {
        if (prob == null || !Number.isFinite(prob)) continue;
        const mkt = marketForTeam(ev, team);
        if (!mkt) continue;
        rows.push({
          league: L.league, game, ev, mkt, side, team, opp,
          fpi: prob,
          ask: mkt.yesAsk ?? null,
          bid: mkt.yesBid ?? null,
          last: mkt.last ?? null,
          book: game.fair ? game.fair[side] ?? null : null,
          volume: mkt.volume || 0,
          openInterest: mkt.openInterest || 0,
          predPointDiff: p.predPointDiff ?? null,
        });
      }
    }
    fpiDiag.push({
      league: L.league, games: L.games.length, events: L.events.length,
      matched: L.pairs.length, withFpi,
      noGames: L.noGames, scheduleError: L.scheduleError, kalshiError: L.kalshiError,
    });
  }

  fpiRows = rows;
  fpiLoaded = true;
  fpiLoading = false;
  renderFpi();
}

/* ---------- the rule ---------- */

/**
 * What the ask has to be for this side to trigger.
 *
 * The fee component is priced at the FPI probability rather than at the ask, so
 * the target is a fixed property of the game and does not slide around as the
 * market moves. That also matches how the backtest computed the fee share of
 * each band's requirement.
 */
function fpiTarget(r) {
  const fpiCents = r.fpi * 100;
  const feePts = state.fpiAddFee ? feePerContractCents(fpiCents, state.feeRole) : 0;
  const required = state.fpiDiscountPts + feePts;
  return { required, feePts, target: fpiCents - required };
}

function decorateFpi(r) {
  const { required, feePts, target } = fpiTarget(r);
  const qty = Math.max(1, Math.round(state.fpiContracts) || 1);
  const out = { ...r, required, feePts, target, qty };

  if (r.ask == null) {
    return { ...out, quoted: false, gap: null, surplus: null, trigger: false,
      cost: null, fee: null, evDollars: null, evPerContract: null };
  }

  const gap = r.fpi * 100 - r.ask;           // points the market sits below FPI
  const surplus = gap - required;            // how far past the threshold
  const fee = orderFeeDollars(qty, r.ask, state.feeRole);
  const cost = qty * (r.ask / 100);
  // If FPI is the truth, this is what the position is worth on average.
  const evDollars = qty * (r.fpi - r.ask / 100) - fee;

  return { ...out, quoted: true, gap, surplus, trigger: surplus >= 0,
    cost, fee, evDollars, evPerContract: evDollars / qty * 100 };
}

/* ---------- filtering ---------- */

function visibleFpiRows() {
  let rows = fpiRows.map(decorateFpi);

  if (state.fpiLeague !== 'all') rows = rows.filter((r) => r.league === state.fpiLeague);
  if (fpiFrom) rows = rows.filter((r) => r.game.date >= fpiFrom);
  if (fpiTo) rows = rows.filter((r) => r.game.date <= fpiTo);

  if (!state.fpiBothSides) {
    // One row per game: the side FPI actually favours.
    const best = new Map();
    for (const r of rows) {
      const cur = best.get(r.game.id);
      if (!cur || r.fpi > cur.fpi) best.set(r.game.id, r);
    }
    rows = [...best.values()];
  }

  const lo = Math.min(state.fpiLowPct, state.fpiHighPct);
  const hi = Math.max(state.fpiLowPct, state.fpiHighPct);
  rows = rows.filter((r) => r.fpi * 100 >= lo && r.fpi * 100 <= hi);

  if (state.fpiQuotedOnly) rows = rows.filter((r) => r.quoted);
  if (state.fpiTriggersOnly) rows = rows.filter((r) => r.trigger);

  const low = (v) => (v == null ? Number.NEGATIVE_INFINITY : v);
  const byDate = (a, b) => a.game.date.localeCompare(b.game.date)
    || (a.game.sortKey ?? 0) - (b.game.sortKey ?? 0)
    || low(b.surplus) - low(a.surplus);

  const sorters = {
    surplus: (a, b) => low(b.surplus) - low(a.surplus) || byDate(a, b),
    fpi: (a, b) => b.fpi - a.fpi || byDate(a, b),
    date: byDate,
    price: (a, b) => (a.ask ?? 999) - (b.ask ?? 999) || byDate(a, b),
    pnl: (a, b) => low(b.evDollars) - low(a.evDollars) || byDate(a, b),
  };
  return rows.sort(sorters[state.fpiSort] || sorters.surplus);
}

/* ---------- rendering ---------- */

function fpiLoadNote() {
  const parts = fpiDiag.map((d) => {
    const label = LEAGUE_LABEL[d.league] || d.league;
    if (d.scheduleError) return `${label}: schedule failed (${esc(d.scheduleError)})`;
    if (d.kalshiError) return `${label}: Kalshi failed (${esc(d.kalshiError)})`;
    if (d.noGames) return `${label}: no games in range`;
    if (!d.events) return `${label}: no open Kalshi events`;
    return `${label}: ${d.withFpi}/${d.matched} matched games with a projection`;
  });
  return parts.join(' &middot; ');
}

function renderFpi() {
  const el = document.getElementById('fpiOut');
  if (fpiLoading) return;
  if (!fpiLoaded) {
    el.innerHTML = '<div class="empty"><h3>Not loaded yet</h3><p>Press <em>Reload all sports</em>.</p></div>';
    return;
  }

  const rows = visibleFpiRows();
  const triggers = rows.filter((r) => r.trigger);
  const totalCost = triggers.reduce((s, r) => s + r.cost, 0);
  const totalEv = triggers.reduce((s, r) => s + r.evDollars, 0);
  const totalFee = triggers.reduce((s, r) => s + r.fee, 0);
  const avgGap = triggers.length
    ? triggers.reduce((s, r) => s + r.gap, 0) / triggers.length : null;

  document.getElementById('fpiCount').textContent = triggers.length ? String(triggers.length) : '';

  const ruleLine = state.fpiAddFee
    ? `ask &le; FPI &minus; (fee + ${state.fpiDiscountPts} pts)`
    : `ask &le; FPI &minus; ${state.fpiDiscountPts} pts`;

  const summary = `<div class="summary">
    <div class="stat"><span class="n">${triggers.length}</span><span class="k">Triggers</span></div>
    <div class="stat"><span class="n">${rows.length}</span><span class="k">Games shown</span></div>
    <div class="stat"><span class="n">${avgGap == null ? '--' : avgGap.toFixed(1)}</span><span class="k">Avg pts below FPI</span></div>
    <div class="stat"><span class="n">${money(totalCost)}</span><span class="k">Cost to take all</span></div>
    <div class="stat"><span class="n ${totalEv > 0 ? 'up' : totalEv < 0 ? 'down' : ''}">${money(totalEv)}</span><span class="k">Expected P&amp;L if FPI is right</span></div>
  </div>`;

  // The results area swaps between a table and an empty state, but the rule
  // explainer and the band reference below it always render - they are
  // documentation, and a filter that matches nothing is exactly when you need
  // them. (Losing the Apply-band buttons there would strand you.)
  const body = !rows.length
    ? `<div class="empty"><h3>Nothing matches those filters</h3>
      <p>${fpiRows.length
        ? `${fpiRows.length} sides are loaded. Widen the FPI range, lower the discount, untick
           <em>Triggers only</em>, or clear the sport filter.`
        : 'No Kalshi market lined up with a game that has an ESPN FPI projection in this window. '
          + 'Kalshi opens most game books only in the days before tip-off.'}</p></div>`
    : `<div class="tablewrap"><table class="tbl">
    <thead><tr>
      <th>Game</th><th>Pick</th>
      <th class="r">ESPN FPI</th><th class="r">Kalshi ask</th><th class="r">Target</th>
      <th class="r">Gap</th><th class="r">vs target</th>
      <th>Signal</th><th class="r">Expected P&amp;L</th><th></th>
    </tr></thead><tbody>
    ${rows.map((r, i) => {
      const g = r.game;
      return `<tr class="${r.trigger ? 'good' : ''}">
        <td data-label="Game">
          <div class="g-teams">${esc(r.game.away.short || r.game.away.name)} at ${esc(r.game.home.short || r.game.home.name)}</div>
          <div class="g-meta"><span class="lgchip">${esc(LEAGUE_LABEL[r.league] || r.league)}</span>
            ${esc(g.weekday)} ${esc(g.date)} &middot; ${esc(g.time)} ${esc(g.tz)}
            ${g.networks?.length ? `&middot; ${esc(g.networks.join(', '))}` : ''}</div>
        </td>
        <td data-label="Pick"><strong>${esc(r.team.short || r.team.name)}</strong>
          <div class="g-meta">${r.side === 'home' ? 'home' : 'away'}${
            r.book == null ? '' : ` &middot; book ${pct(r.book, 0)}`}</div></td>
        <td class="r mono" data-label="ESPN FPI"><strong>${pct(r.fpi, 1)}</strong></td>
        <td class="r mono" data-label="Kalshi ask">${r.quoted ? cents(r.ask)
          : '<span class="pending">no book</span>'}
          ${r.quoted && r.bid != null ? `<div class="g-meta">bid ${cents(r.bid)}</div>` : ''}</td>
        <td class="r mono" data-label="Target"><strong>${r.target.toFixed(1)}&cent;</strong>
          <div class="g-meta">need ${r.required.toFixed(1)} pts${
            state.fpiAddFee ? ` (${r.feePts.toFixed(2)} fee)` : ''}</div></td>
        <td class="r mono" data-label="Gap" data-tone="${!r.quoted ? '' : r.gap > 0 ? 'up' : 'down'}">${
          r.quoted ? `${r.gap >= 0 ? '+' : ''}${r.gap.toFixed(1)}` : '--'}</td>
        <td class="r mono" data-label="vs target" data-tone="${!r.quoted ? '' : r.surplus >= 0 ? 'up' : 'down'}">${
          r.quoted ? `${r.surplus >= 0 ? '+' : ''}${r.surplus.toFixed(1)}` : '--'}</td>
        <td data-label="Signal">${r.quoted
          ? (r.trigger
            ? '<span class="trigchip">TRADE</span>'
            : `<span class="passchip">pass</span><div class="g-meta">${
              Math.abs(r.surplus).toFixed(1)} pts too rich</div>`)
          : '<span class="pending">no quote</span>'}</td>
        <td class="r mono" data-label="Expected P&amp;L" data-tone="${
          !r.quoted ? '' : r.evDollars > 0 ? 'up' : 'down'}">${r.quoted
            ? `${money(r.evDollars)}<div class="g-meta">${r.qty} @ ${cents(r.ask)} = ${money(r.cost)} &middot; ${money(r.fee)} fee</div>`
            : '--'}</td>
        <td class="r act"><button class="btn sm" data-fpilog="${i}"${r.quoted ? '' : ' disabled'}>Log</button></td>
      </tr>`;
    }).join('')}
  </tbody></table></div>`;

  el.innerHTML = `${summary}${body}

  <p class="fineprint"><strong>The rule on this tab is ${ruleLine}.</strong>
  <strong>Target</strong> is the highest price you should pay for that side.
  <strong>Gap</strong> is how many points below FPI the ask already sits, and
  <strong>vs target</strong> is what is left after the discount is taken out &mdash; anything
  at or above zero is flagged TRADE. <strong>Expected P&amp;L</strong> assumes FPI is exactly
  right and is net of Kalshi's ${state.feeRole} fee at ${state.fpiContracts} contracts; it is
  the average outcome over many trades, not what any single game pays.
  One point of discount is worth exactly $1 per game per 100 contracts, which is why the
  backtest and this tab both speak in points.</p>

  <h3 class="sec">Where the 5 points came from &mdash; and where it does not apply</h3>
  <p class="fineprint">The discount was fitted on <strong>FBS college football only</strong>,
  2,396 games across 2023-2025, comparing ESPN FPI against closing market prices. Five points is
  roughly the <em>pooled average</em> requirement across all bands and seasons. It is not a
  per-band number and it is not stable year to year: the 60-70% band needed no discount at all in
  2023 and 2025 but 7.8 points in 2024. A single threshold that survives every band in every
  season would have to be 7.8. Use the table below to set the discount for the band you are
  actually trading, and treat NFL, NBA, NHL and college basketball rows as untested &mdash; no
  equivalent backtest has been run on them.</p>
  <div class="tablewrap"><table class="tbl">
    <thead><tr><th>FPI band</th><th class="r">Games</th><th class="r">Pooled need</th>
      <th class="r">Worst season</th><th class="r">Fee share</th><th></th></tr></thead>
    <tbody>${BAND_REFERENCE.map((b) => `<tr>
      <td class="mono" data-label="FPI band">${b.lo}-${b.hi}%</td>
      <td class="r mono" data-label="Games">${b.games}</td>
      <td class="r mono" data-label="Pooled need">${b.pooled.toFixed(2)}</td>
      <td class="r mono" data-label="Worst season">${b.worst.toFixed(2)}</td>
      <td class="r mono" data-label="Fee share">${b.fee.toFixed(2)}</td>
      <td class="r act"><button class="btn sm" data-band="${b.lo}-${b.hi}">Apply band</button></td>
    </tr>`).join('')}</tbody></table></div>
  <p class="fineprint">All figures in points below FPI. <strong>Pooled need</strong> is the
  game-weighted 2023-2025 requirement; a negative number means that band was profitable at FPI's
  own price, with no discount. <strong>Worst season</strong> is the single worst of the three, and
  is the number to use if you cannot tolerate a losing year. <strong>Fee share</strong> is how much
  of the requirement is Kalshi's fee rather than model error &mdash; it collapses toward the tails
  because the fee is 7% x price x (1 - price). <em>Apply band</em> sets the FPI range and the
  discount to that band's worst-season requirement.</p>
  <p class="fineprint">${fpiLoadNote()}</p>`;

  el.querySelectorAll('[data-fpilog]').forEach((b) => {
    b.addEventListener('click', () => openFpiLog(rows[Number(b.dataset.fpilog)]));
  });
  el.querySelectorAll('[data-band]').forEach((b) => {
    b.addEventListener('click', () => {
      const [lo, hi] = b.dataset.band.split('-').map(Number);
      const ref = BAND_REFERENCE.find((x) => x.lo === lo && x.hi === hi);
      state.fpiLowPct = lo;
      state.fpiHighPct = hi;
      // Round the requirement *up* to the input's step. Rounding 5.05 down to
      // 5.0 would quietly apply a thinner discount than the season demanded.
      state.fpiDiscountPts = ref
        ? Math.max(0, Math.ceil(ref.worst * 10) / 10)
        : state.fpiDiscountPts;
      state.fpiAddFee = false;
      save(); syncFpiControls(); renderFpi();
      toast(`Filtering ${lo}-${hi}% at a ${state.fpiDiscountPts}-point discount (that band's worst season).`);
    });
  });
}

function openFpiLog(r) {
  const f = document.getElementById('logForm');
  document.getElementById('logTitle').textContent = 'Log position';
  f.ticker.value = r.mkt.ticker;
  f.title.value = `${r.team.short || r.team.name} to beat ${r.opp.short || r.opp.name}`;
  f.league.value = r.game.league;
  f.side.value = 'YES';
  f.price.value = Number(r.ask).toFixed(1);
  f.contracts.value = r.qty;
  f.note.value = `FPI rule: ${pct(r.fpi, 1)} FPI, target ${r.target.toFixed(1)}c, `
    + `ask ${cents(r.ask)} (${r.gap.toFixed(1)} pts below FPI, ${r.surplus >= 0 ? '+' : ''}${r.surplus.toFixed(1)} vs target)`;
  updateCost();
  document.getElementById('logDialog').showModal();
}

/* ---------- controls ---------- */

function syncFpiControls() {
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
  const check = (id, v) => { const e = document.getElementById(id); if (e) e.checked = v; };
  set('fpiDisc', state.fpiDiscountPts);
  set('fpiLow', state.fpiLowPct);
  set('fpiHigh', state.fpiHighPct);
  set('fpiQty', state.fpiContracts);
  set('fpiLeague', state.fpiLeague);
  set('fpiSort', state.fpiSort);
  set('fpiFrom', fpiFrom);
  set('fpiTo', fpiTo);
  check('fpiAddFee', state.fpiAddFee);
  check('fpiTrigOnly', state.fpiTriggersOnly);
  check('fpiQuotedOnly', state.fpiQuotedOnly);
  check('fpiBoth', state.fpiBothSides);
}

function wireFpi() {
  const num = (id, key, lo, hi) => document.getElementById(id).addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v)) { e.target.value = state[key]; return; }
    state[key] = Math.min(hi, Math.max(lo, v));
    e.target.value = state[key];
    save(); renderFpi();
  });
  num('fpiDisc', 'fpiDiscountPts', 0, 40);
  num('fpiLow', 'fpiLowPct', 0, 100);
  num('fpiHigh', 'fpiHighPct', 0, 100);
  num('fpiQty', 'fpiContracts', 1, 10000);

  const flag = (id, key) => document.getElementById(id).addEventListener('change', (e) => {
    state[key] = e.target.checked; save(); renderFpi();
  });
  flag('fpiAddFee', 'fpiAddFee');
  flag('fpiTrigOnly', 'fpiTriggersOnly');
  flag('fpiQuotedOnly', 'fpiQuotedOnly');
  flag('fpiBoth', 'fpiBothSides');

  document.getElementById('fpiLeague').addEventListener('change', (e) => {
    state.fpiLeague = e.target.value; save(); renderFpi();
  });
  document.getElementById('fpiSort').addEventListener('change', (e) => {
    state.fpiSort = e.target.value; save(); renderFpi();
  });

  // Dates bound the schedule request, so a change means a refetch.
  document.getElementById('fpiFrom').addEventListener('change', (e) => {
    fpiFrom = e.target.value; loadFpiUniverse();
  });
  document.getElementById('fpiTo').addEventListener('change', (e) => {
    fpiTo = e.target.value; loadFpiUniverse();
  });

  document.getElementById('fpiReload').addEventListener('click', () => loadFpiUniverse());
  document.getElementById('fpiReset').addEventListener('click', () => {
    for (const k of ['fpiDiscountPts', 'fpiAddFee', 'fpiLowPct', 'fpiHighPct',
      'fpiContracts', 'fpiBothSides', 'fpiTriggersOnly', 'fpiQuotedOnly',
      'fpiLeague', 'fpiSort']) state[k] = DEFAULTS[k];
    save();
    const from = todayMT();
    const to = addDays(from, FPI_WINDOW_DAYS);
    const refetch = fpiFrom !== from || fpiTo !== to;
    fpiFrom = from; fpiTo = to;
    syncFpiControls();
    if (refetch) loadFpiUniverse(); else renderFpi();
  });
}

/* ---------- rendering: positions ---------- */

function renderPositions() {
  const el = document.getElementById('positions');
  const showSettled = document.getElementById('showSettled').checked;
  const list = state.positions
    .filter((p) => showSettled || p.status === 'open')
    .slice()
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  if (!list.length) {
    el.innerHTML = `<div class="empty"><h3>No positions yet</h3>
      <p>Log one from the Edges tab, or add it manually if you traded on Kalshi directly.</p></div>`;
    return;
  }

  el.innerHTML = `<div class="tablewrap"><table class="tbl">
    <thead><tr>
      <th>Position</th><th class="r">Side</th><th class="r">Qty</th><th class="r">Entry</th>
      <th class="r">Mark</th><th class="r">Cost</th><th class="r">P&amp;L</th><th>Status</th><th></th>
    </tr></thead><tbody>
    ${list.map((p) => {
      const m = markCache.get(p.marketTicker);
      const mark = p.status === 'open'
        ? (m ? (p.side === 'YES' ? m.yesBid : m.noBid) : null) : null;
      const pl = positionPnl(p, mark);
      const cost = positionCost(p);
      return `<tr>
        <td data-label="Position"><div class="g-teams">${esc(p.title || p.marketTicker)}</div>
          <div class="g-meta mono">${esc(p.marketTicker)}</div>
          ${p.note ? `<div class="g-meta">${esc(p.note)}</div>` : ''}</td>
        <td class="r" data-label="Side"><span class="side ${p.side.toLowerCase()}">${p.side}</span></td>
        <td class="r mono" data-label="Qty">${p.contracts}</td>
        <td class="r mono" data-label="Entry">${cents(p.entryPrice)}</td>
        <td class="r mono" data-label="Mark">${mark != null ? cents(mark) : '--'}</td>
        <td class="r mono" data-label="Cost">${money(cost)}</td>
        <td class="r mono" data-label="P&amp;L" data-tone="${pl == null ? '' : pl > 0 ? 'up' : pl < 0 ? 'down' : ''}">${pl == null ? '--' : money(pl)}</td>
        <td data-label="Status"><span class="status ${p.status}">${p.status}</span></td>
        <td class="r nowrap act">${p.status === 'open' ? `
          <button class="btn sm" data-win="${p.id}">Won</button>
          <button class="btn sm" data-lose="${p.id}">Lost</button>` : ''}
          <button class="btn sm danger" data-del="${p.id}">&times;</button></td>
      </tr>`;
    }).join('')}
  </tbody></table></div>`;

  el.querySelectorAll('[data-win]').forEach((b) => b.addEventListener('click', () => settle(b.dataset.win, 'won')));
  el.querySelectorAll('[data-lose]').forEach((b) => b.addEventListener('click', () => settle(b.dataset.lose, 'lost')));
  el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => removePosition(b.dataset.del)));
}

function settle(id, status) {
  const p = state.positions.find((x) => x.id === id);
  if (!p) return;
  p.status = status;
  p.settledAt = new Date().toISOString();
  save(); renderBank(); renderPositions(); renderPerformance();
}

function removePosition(id) {
  const p = state.positions.find((x) => x.id === id);
  if (!p) return;
  if (!confirm(`Delete this position?\n\n${p.title || p.marketTicker}\n${p.contracts} @ ${p.entryPrice}c\n\nThis cannot be undone.`)) return;
  state.positions = state.positions.filter((x) => x.id !== id);
  save(); renderBank(); renderPositions(); renderPerformance();
}

/* ---------- rendering: performance ---------- */

function renderPerformance() {
  const el = document.getElementById('performance');
  const settled = state.positions.filter((p) => p.status !== 'open');
  if (!settled.length) {
    el.innerHTML = `<div class="empty"><h3>Nothing settled yet</h3>
      <p>Mark positions won or lost and this fills in: record, ROI, and whether the
      prices you paid actually matched how often you were right.</p></div>`;
    return;
  }

  const s = bankrollSummary(markCache);
  const byLeague = {};
  for (const p of settled) {
    const k = p.league || 'other';
    byLeague[k] = byLeague[k] || { n: 0, pnl: 0, staked: 0, wins: 0 };
    const pl = positionPnl(p) || 0;
    byLeague[k].n++; byLeague[k].pnl += pl; byLeague[k].staked += positionCost(p);
    if (pl > 0) byLeague[k].wins++;
  }

  // Calibration: did contracts bought near Xc win about X% of the time?
  const buckets = [[0,20],[20,40],[40,60],[60,80],[80,100]];
  const cal = buckets.map(([lo, hi]) => {
    const inb = settled.filter((p) => p.entryPrice >= lo && p.entryPrice < hi);
    const wins = inb.filter((p) => p.status === 'won').length;
    return { lo, hi, n: inb.length, actual: inb.length ? wins / inb.length : null,
      implied: (lo + hi) / 200 };
  });

  el.innerHTML = `
  <div class="summary">
    <div class="stat"><span class="n">${s.wins}-${s.losses}</span><span class="k">Record</span></div>
    <div class="stat"><span class="n">${s.winRate == null ? '--' : pct(s.winRate, 0)}</span><span class="k">Win rate</span></div>
    <div class="stat"><span class="n ${s.realized > 0 ? 'up' : s.realized < 0 ? 'down' : ''}">${money(s.realized)}</span><span class="k">Realized P&amp;L</span></div>
    <div class="stat"><span class="n ${(s.roi || 0) > 0 ? 'up' : (s.roi || 0) < 0 ? 'down' : ''}">${s.roi == null ? '--' : pct(s.roi, 1)}</span><span class="k">ROI on stake</span></div>
    <div class="stat"><span class="n">${money(s.equity)}</span><span class="k">Equity</span></div>
  </div>

  <h3 class="sec">By league</h3>
  <div class="tablewrap"><table class="tbl">
    <thead><tr><th>League</th><th class="r">Settled</th><th class="r">Record</th><th class="r">Staked</th><th class="r">P&amp;L</th><th class="r">ROI</th></tr></thead>
    <tbody>${Object.entries(byLeague).map(([k, v]) => `<tr>
      <td>${LEAGUE_LABEL[k] || k}</td><td class="r mono">${v.n}</td>
      <td class="r mono">${v.wins}-${v.n - v.wins}</td>
      <td class="r mono">${money(v.staked)}</td>
      <td class="r mono ${v.pnl > 0 ? 'up' : v.pnl < 0 ? 'down' : ''}">${money(v.pnl)}</td>
      <td class="r mono">${v.staked ? pct(v.pnl / v.staked, 1) : '--'}</td></tr>`).join('')}
    </tbody></table></div>

  <h3 class="sec">Calibration</h3>
  <p class="fineprint">If you are pricing well, contracts bought around 60&cent; should win
  about 60% of the time. Large gaps mean you are systematically over- or under-paying.</p>
  <div class="tablewrap"><table class="tbl">
    <thead><tr><th>Entry price</th><th class="r">Positions</th><th class="r">Implied</th><th class="r">Actual</th><th class="r">Gap</th></tr></thead>
    <tbody>${cal.map((b) => `<tr>
      <td class="mono" data-label="Entry price">${b.lo}-${b.hi}&cent;</td>
      <td class="r mono">${b.n}</td>
      <td class="r mono">${pct(b.implied, 0)}</td>
      <td class="r mono">${b.actual == null ? '--' : pct(b.actual, 0)}</td>
      <td class="r mono ${b.actual == null ? '' : b.actual - b.implied > 0 ? 'up' : 'down'}">${
        b.actual == null ? '--' : pts(b.actual - b.implied)}</td></tr>`).join('')}
    </tbody></table></div>`;
}

/* ---------- rendering: settings ---------- */

function renderSettings() {
  const el = document.getElementById('settings');
  el.innerHTML = `
    <label>Starting bankroll ($)
      <input type="number" id="setBankroll" min="0" step="50" value="${state.bankroll}">
      <span class="hint">Your season budget. Equity and stake sizes are derived from it.</span></label>
    <label>Kelly fraction
      <input type="number" id="setKelly" min="0.05" max="1" step="0.05" value="${state.kellyFraction}">
      <span class="hint">0.25 stakes a quarter of the full Kelly bet. Full Kelly (1.0) maximises
      long-run growth only if your probabilities are exactly right, and is brutally volatile when they are not.</span></label>
    <label>Max stake per position (% of bankroll)
      <input type="number" id="setMax" min="0.5" max="100" step="0.5" value="${(state.maxStakePct * 100).toFixed(1)}">
      <span class="hint">A hard cap applied after Kelly, so one position cannot dominate the season.</span></label>
    <label>Fee role
      <select id="setFeeRole">
        <option value="taker"${state.feeRole === 'taker' ? ' selected' : ''}>Taker (hitting the ask)</option>
        <option value="maker"${state.feeRole === 'maker' ? ' selected' : ''}>Maker (resting a bid)</option>
      </select>
      <span class="hint">Kalshi charges takers 7% of price x (1 - price), peaking at 1.75c per
      contract at 50c. Makers pay a quarter of that. Taker is the honest default if you are
      lifting an offer.</span></label>
    <label>ESPN FPI weight in the blend
      <input type="number" id="setFpi" min="0" max="1" step="0.05" value="${state.fpiWeight}">
      <span class="hint">0 uses the sportsbook line alone. 0.35 lets ESPN's model pull the
      estimate about a third of the way. The book deserves most of the weight - it has real
      money behind it and moves continuously.</span></label>
    <label>Minimum edge to flag (points)
      <input type="number" id="setEdge" min="0" max="50" step="0.5" value="${state.minEdgePts}">
      <span class="hint">Applied to the <em>net</em> edge, after fees.</span></label>
    <div class="dlg-wide settings-actions">
      <button class="btn" id="exportBtn" type="button">Export positions (JSON)</button>
      <label class="btn filelabel">Import<input type="file" id="importFile" accept="application/json" hidden></label>
      <button class="btn danger" id="resetBtn" type="button">Reset everything</button>
    </div>`;

  const bind = (id, key, transform = Number) => {
    document.getElementById(id).addEventListener('change', (e) => {
      const v = transform(e.target.value);
      if (Number.isFinite(v)) { state[key] = v; save(); renderBank(); refreshDerived(); }
    });
  };
  bind('setBankroll', 'bankroll');
  bind('setKelly', 'kellyFraction');
  bind('setMax', 'maxStakePct', (v) => Number(v) / 100);
  bind('setEdge', 'minEdgePts');
  bind('setFpi', 'fpiWeight');
  document.getElementById('setFeeRole').addEventListener('change', (e) => {
    state.feeRole = e.target.value === 'maker' ? 'maker' : 'taker';
    save(); refreshDerived();
  });

  document.getElementById('exportBtn').addEventListener('click', exportJSON);
  document.getElementById('importFile').addEventListener('change', importJSON);
  document.getElementById('resetBtn').addEventListener('click', () => {
    if (!confirm('Delete all positions and settings? This cannot be undone.')) return;
    state = { ...DEFAULTS, positions: [] };
    save(); renderBank(); renderSettings(); renderPositions(); renderPerformance();
  });
}

function exportJSON() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `prediction-desk-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importJSON(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.positions)) throw new Error('no positions array');
    state = { ...DEFAULTS, ...data };
    save(); renderBank(); renderSettings(); renderPositions(); renderPerformance();
    toast(`Imported ${data.positions.length} position(s).`);
  } catch (err) {
    toast(`Could not import that file: ${err.message}`);
  }
  e.target.value = '';
}

/* ---------- log dialog ---------- */

const dlg = document.getElementById('logDialog');

function openLog(row) {
  const f = document.getElementById('logForm');
  if (row) {
    document.getElementById('logTitle').textContent = 'Log position';
    f.ticker.value = row.mkt.ticker;
    f.title.value = `${row.team.short || row.team.name} to beat ${
      (row.side === 'home' ? row.game.away : row.game.home).short || ''}`.trim();
    f.league.value = row.game.league;
    f.side.value = 'YES';
    f.price.value = Number(row.ask).toFixed(1);
    f.contracts.value = Math.max(1, row.contracts);
    f.note.value = `${pts(row.edge)} pts net edge (blend ${pct(row.blend, 1)} vs ${cents(row.ask)})`;
  } else {
    document.getElementById('logTitle').textContent = 'Log a position manually';
    f.reset();
  }
  updateCost();
  dlg.showModal();
}

function updateCost() {
  const f = document.getElementById('logForm');
  const c = Number(f.contracts.value), p = Number(f.price.value);
  const el = document.getElementById('dlgCost');
  if (!Number.isFinite(c) || !Number.isFinite(p) || c <= 0) { el.textContent = ''; return; }
  const cost = c * (p / 100);
  const s = bankrollSummary(markCache);
  el.innerHTML = `Cost <strong>${money(cost)}</strong> &middot; max win
    <strong>${money(c * (100 - p) / 100)}</strong> &middot;
    ${pct(cost / (state.bankroll || 1), 1)} of bankroll${
    cost > s.cash ? ' &middot; <span class="down">more than your free cash</span>' : ''}`;
}

document.getElementById('logForm').addEventListener('input', updateCost);
document.getElementById('logForm').addEventListener('submit', (e) => {
  const f = e.target;
  if (dlg.returnValue === 'cancel' || e.submitter?.value === 'cancel') return;
  const contracts = Number(f.contracts.value);
  const price = Number(f.price.value);
  if (!f.ticker.value.trim() || !Number.isFinite(contracts) || contracts <= 0
    || !Number.isFinite(price) || price < 1 || price > 99) {
    e.preventDefault(); toast('Check the ticker, quantity and price.'); return;
  }
  state.positions.push({
    id: uid(),
    createdAt: new Date().toISOString(),
    marketTicker: f.ticker.value.trim(),
    title: f.title.value.trim(),
    league: f.league.value,
    side: f.side.value,
    contracts, entryPrice: price,
    note: f.note.value.trim(),
    status: 'open',
  });
  save(); renderBank(); renderPositions(); renderPerformance();
  toast('Position logged.');
});

/* ---------- data loading ---------- */

async function loadLeague(league) {
  const el = document.getElementById('edges');
  el.innerHTML = '<div class="empty"><h3>Loading</h3><p>Fetching schedule, betting lines and Kalshi markets.</p></div>';

  const [gamesRes, kalshiRes] = await Promise.allSettled([
    getJSON(`/api/schedule?league=${league}`),
    getJSON(`/api/kalshi?series=${GAME_SERIES[league]}`),
  ]);

  games = gamesRes.status === 'fulfilled' ? (gamesRes.value.games || []) : [];
  kalshiEvents = kalshiRes.status === 'fulfilled' ? (kalshiRes.value.events || []) : [];

  const problems = [];
  if (gamesRes.status === 'rejected') problems.push(`schedule (${gamesRes.reason.message})`);
  if (kalshiRes.status === 'rejected') problems.push(`Kalshi (${kalshiRes.reason.message})`);
  if (problems.length) toast(`Could not load ${problems.join(' and ')}.`);

  computeRest(games);
  matched = buildRows();
  renderEdges();

  // Pull ESPN's model only for the games that actually matched a market.
  const ids = [...new Set(matched.map((r) => String(r.game.id).replace(/^[a-z]+-/, '')))].slice(0, 60);
  if (ids.length) {
    try {
      const fp = await getJSON(`/api/predictor?league=${league}&ids=${ids.join(',')}`);
      fpiCache = new Map(Object.entries(fp.predictions || {}));
      matched = buildRows();
      renderEdges();
    } catch { /* the blend simply falls back to the book alone */ }
  }

  const withLine = games.filter((g) => g.fair).length;
  document.getElementById('deskGenerated').textContent =
    `${games.length} games · ${withLine} with a line · ${kalshiEvents.length} Kalshi events · `
    + `${matched.length} ${state.bothSides ? 'sides' : 'games'} matched · `
    + `${matched.filter((r) => r.quoted).length} quoted · `
    + `${fpiCache.size} with an ESPN projection`;
}

async function refreshMarks() {
  const open = state.positions.filter((p) => p.status === 'open');
  if (!open.length) return;
  const tickers = [...new Set(open.map((p) => p.marketTicker))].slice(0, 60);
  try {
    const j = await getJSON(`/api/kalshi?tickers=${encodeURIComponent(tickers.join(','))}`);
    markCache = new Map((j.markets || []).map((m) => [m.ticker, m]));
    renderBank(); renderPositions();
  } catch (err) {
    toast(`Could not refresh marks: ${err.message}`);
  }
}

function refreshDerived() { matched = buildRows(); renderEdges(); }

/* ---------- tabs + wiring ---------- */

function showTab(name) {
  tab = name;
  for (const p of ['edges', 'fpi', 'positions', 'performance', 'settings']) {
    document.getElementById(`panel-${p}`).hidden = p !== name;
  }
  document.querySelectorAll('#tabs .lg').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.tab === name));
  });
  if (name === 'positions') { renderPositions(); refreshMarks(); }
  if (name === 'performance') renderPerformance();
  if (name === 'settings') renderSettings();
  // Five sports at once is an expensive load, so it waits until the tab is opened.
  if (name === 'fpi') { if (fpiLoaded || fpiLoading) renderFpi(); else loadFpiUniverse(); }
}

document.getElementById('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.lg');
  if (b) showTab(b.dataset.tab);
});
document.getElementById('edgeLeague').addEventListener('change', (e) => loadLeague(e.target.value));
document.getElementById('minEdge').addEventListener('change', (e) => {
  state.minEdgePts = Number(e.target.value) || 0; save(); renderEdges();
});
document.getElementById('onlyEdges').addEventListener('change', renderEdges);
document.getElementById('bothSides').addEventListener('change', (e) => {
  state.bothSides = e.target.checked; save(); refreshDerived();
});
document.getElementById('edgeFrom').addEventListener('change', (e) => { dateFrom = e.target.value; renderEdges(); });
document.getElementById('edgeTo').addEventListener('change', (e) => { dateTo = e.target.value; renderEdges(); });
document.getElementById('edgeSort').addEventListener('change', (e) => {
  state.sortBy = e.target.value; save(); renderEdges();
});
document.getElementById('edgeWeek').addEventListener('click', () => {
  dateFrom = todayMT();
  dateTo = addDays(dateFrom, 7);
  document.getElementById('edgeFrom').value = dateFrom;
  document.getElementById('edgeTo').value = dateTo;
  renderEdges();
});
document.getElementById('edgeClear').addEventListener('click', () => {
  dateFrom = ''; dateTo = '';
  document.getElementById('edgeFrom').value = '';
  document.getElementById('edgeTo').value = '';
  renderEdges();
});
document.getElementById('refresh').addEventListener('click', () => loadLeague(document.getElementById('edgeLeague').value));
document.getElementById('addManual').addEventListener('click', () => openLog(null));
document.getElementById('showSettled').addEventListener('change', renderPositions);
document.getElementById('markAll').addEventListener('click', refreshMarks);

/* ---------- boot ---------- */

document.getElementById('minEdge').value = state.minEdgePts;
document.getElementById('edgeSort').value = state.sortBy;
document.getElementById('bothSides').checked = state.bothSides;
fpiFrom = todayMT();
fpiTo = addDays(fpiFrom, FPI_WINDOW_DAYS);
syncFpiControls();
wireFpi();
renderBank();
renderPositions();
showTab('edges');
loadLeague(document.getElementById('edgeLeague').value);
refreshMarks();
