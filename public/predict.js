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
  positions: [],
};

let state = load();
let games = [];        // ESPN games for the selected league
let kalshiEvents = []; // open Kalshi events for that league
let matched = [];      // joined rows
let tab = 'edges';

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

/* ---------- edge math (mirrors lib/odds.mjs) ---------- */

function kelly(p, priceCents, fraction) {
  const c = Number(priceCents);
  if (!Number.isFinite(p) || !Number.isFinite(c) || c <= 0 || c >= 100) return null;
  const price = c / 100;
  const b = (1 - price) / price;
  const full = (p * b - (1 - p)) / b;
  return { full: Math.max(0, full), staked: Math.max(0, full * fraction), edge: p - price };
}
const evCents = (p, c) => p * (100 - c) - (1 - p) * c;

/** Build the joined view: ESPN fair probability vs Kalshi ask, per side. */
function buildRows() {
  const rows = [];
  for (const ev of kalshiEvents) {
    const parsed = parseEventTicker(ev.ticker);
    if (!parsed) continue;
    const game = games.find((g) => eventMatchesGame(ev, g, parsed));
    if (!game || !game.fair) continue;

    for (const [side, team, fairP] of [
      ['home', game.home, game.fair.home],
      ['away', game.away, game.fair.away],
    ]) {
      const mkt = marketForTeam(ev, team);
      if (!mkt) continue;
      const ask = mkt.yesAsk ?? (mkt.last != null ? mkt.last : null);
      if (ask == null || ask <= 0 || ask >= 100) continue;

      const k = kelly(fairP, ask, state.kellyFraction);
      if (!k) continue;
      const capped = Math.min(k.staked, state.maxStakePct);
      const stakeDollars = capped * state.bankroll;
      rows.push({
        game, ev, mkt, side, team,
        fair: fairP, ask,
        edge: fairP - ask / 100,
        ev: evCents(fairP, ask),
        kellyFull: k.full,
        stakeDollars,
        contracts: Math.floor(stakeDollars / (ask / 100)),
        source: game.fair.source,
      });
    }
  }
  return rows.sort((a, b) => b.edge - a.edge);
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

function renderEdges() {
  const el = document.getElementById('edges');
  const minEdge = state.minEdgePts / 100;
  const onlyEdges = document.getElementById('onlyEdges').checked;

  let rows = matched;
  if (onlyEdges) rows = rows.filter((r) => r.edge >= minEdge && r.ev > 0);

  if (!rows.length) {
    el.innerHTML = `<div class="empty">
      <h3>No qualifying edges</h3>
      <p>${matched.length
        ? `${matched.length} market${matched.length === 1 ? '' : 's'} matched, but none clear a ${state.minEdgePts}-point edge. Lower the threshold or untick <em>Only +EV</em> to see them all.`
        : 'No Kalshi markets are open yet for this league that line up with a game that has a posted betting line. Kalshi lists most game markets in the days before kickoff.'}</p>
    </div>`;
    return;
  }

  el.innerHTML = `<div class="tablewrap"><table class="tbl">
    <thead><tr>
      <th>Game</th><th>Pick</th><th class="r">Book fair</th><th class="r">Kalshi ask</th>
      <th class="r">Edge</th><th class="r">EV/contract</th><th class="r">Kelly stake</th><th></th>
    </tr></thead><tbody>
    ${rows.map((r, i) => {
      const g = r.game;
      const good = r.edge >= minEdge && r.ev > 0;
      return `<tr class="${good ? 'good' : ''}">
        <td>
          <div class="g-teams">${esc(g.away.short || g.away.name)} at ${esc(g.home.short || g.home.name)}</div>
          <div class="g-meta">${esc(g.weekday)} ${esc(g.date)} &middot; ${esc(g.time)} ${esc(g.tz)}
            ${g.networks?.length ? `&middot; ${esc(g.networks.join(', '))}` : ''}</div>
        </td>
        <td><strong>${esc(r.team.short || r.team.name)}</strong>
          <div class="g-meta">${r.source === 'spread' ? 'from spread' : 'from moneyline'}</div></td>
        <td class="r mono">${pct(r.fair, 1)}</td>
        <td class="r mono">${r.ask}&cent;</td>
        <td class="r mono ${r.edge > 0 ? 'up' : 'down'}">${pts(r.edge)}</td>
        <td class="r mono ${r.ev > 0 ? 'up' : 'down'}">${r.ev.toFixed(1)}&cent;</td>
        <td class="r mono">${money(r.stakeDollars)}<div class="g-meta">${r.contracts} contracts</div></td>
        <td class="r"><button class="btn sm" data-log="${i}">Log</button></td>
      </tr>`;
    }).join('')}
  </tbody></table></div>
  <p class="fineprint">Book fair is the sportsbook line with the vig removed. Edge is that
  probability minus the Kalshi ask. Stake is ${pct(state.kellyFraction, 0)} Kelly, capped at
  ${pct(state.maxStakePct, 0)} of bankroll.</p>`;

  el.querySelectorAll('[data-log]').forEach((b) => {
    b.addEventListener('click', () => openLog(rows[Number(b.dataset.log)]));
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
        <td><div class="g-teams">${esc(p.title || p.marketTicker)}</div>
          <div class="g-meta mono">${esc(p.marketTicker)}</div>
          ${p.note ? `<div class="g-meta">${esc(p.note)}</div>` : ''}</td>
        <td class="r"><span class="side ${p.side.toLowerCase()}">${p.side}</span></td>
        <td class="r mono">${p.contracts}</td>
        <td class="r mono">${p.entryPrice}&cent;</td>
        <td class="r mono">${mark != null ? mark + '&cent;' : '--'}</td>
        <td class="r mono">${money(cost)}</td>
        <td class="r mono ${pl == null ? '' : pl > 0 ? 'up' : pl < 0 ? 'down' : ''}">${pl == null ? '--' : money(pl)}</td>
        <td><span class="status ${p.status}">${p.status}</span></td>
        <td class="r nowrap">${p.status === 'open' ? `
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
      <td class="mono">${b.lo}-${b.hi}&cent;</td>
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
    <label>Minimum edge to flag (points)
      <input type="number" id="setEdge" min="0" max="50" step="0.5" value="${state.minEdgePts}">
      <span class="hint">Kalshi charges trading fees, so a small nominal edge can still lose money.</span></label>
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
    f.price.value = row.ask;
    f.contracts.value = Math.max(1, row.contracts);
    f.note.value = `${pts(row.edge)} pts edge vs ${row.source}`;
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

  matched = buildRows();
  renderEdges();

  const withLine = games.filter((g) => g.fair).length;
  document.getElementById('deskGenerated').textContent =
    `${games.length} games · ${withLine} with a line · ${kalshiEvents.length} Kalshi events · ${matched.length} matched`;
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
  for (const p of ['edges', 'positions', 'performance', 'settings']) {
    document.getElementById(`panel-${p}`).hidden = p !== name;
  }
  document.querySelectorAll('#tabs .lg').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.tab === name));
  });
  if (name === 'positions') { renderPositions(); refreshMarks(); }
  if (name === 'performance') renderPerformance();
  if (name === 'settings') renderSettings();
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
document.getElementById('refresh').addEventListener('click', () => loadLeague(document.getElementById('edgeLeague').value));
document.getElementById('addManual').addEventListener('click', () => openLog(null));
document.getElementById('showSettled').addEventListener('change', renderPositions);
document.getElementById('markAll').addEventListener('click', refreshMarks);

/* ---------- boot ---------- */

document.getElementById('minEdge').value = state.minEdgePts;
renderBank();
renderPositions();
showTab('edges');
loadLeague(document.getElementById('edgeLeague').value);
refreshMarks();
