/* Sports Schedule - client for the generated schedule data.
   Loads data/<league>.json when a real pull exists, otherwise falls back to the
   labelled demo fixture. All times arrive pre-converted to Mountain time. */

const LEAGUE_ORDER = ['nfl', 'nba', 'nhl', 'ncaaf', 'ncaab'];
const LEAGUE_LABEL = {
  nfl: 'NFL', nba: 'NBA', nhl: 'NHL',
  ncaaf: 'CFB', ncaab: 'CBB',
};
const PAGE_SIZE = 250;

const state = {
  games: [],
  league: 'all',
  query: '',
  network: 'all',
  nationalOnly: false,
  favoritesOnly: false,
  from: '',
  rendered: 0,
  filtered: [],
  favorites: loadFavorites(),
  isDemo: false,
};

/* ---------- storage ---------- */

function loadFavorites() {
  try {
    return new Set(JSON.parse(localStorage.getItem('ss:favorites') || '[]'));
  } catch { return new Set(); }
}
function saveFavorites() {
  try {
    localStorage.setItem('ss:favorites', JSON.stringify([...state.favorites]));
  } catch { /* private mode - favourites just won't persist */ }
}

/* ---------- data ---------- */

async function loadJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

async function loadData() {
  // Prefer a real pull; fall back to the demo fixture.
  try {
    const index = await loadJSON('../data/index.json');
    const leagues = (index.leagues || []).filter((l) => l.gameCount > 0);
    if (leagues.length === 0) throw new Error('index has no games');
    const sets = await Promise.all(
      leagues.map((l) => loadJSON(`../data/${l.league}.json`).catch(() => null)),
    );
    const games = sets.filter(Boolean).flatMap((s) => s.games || []);
    if (games.length === 0) throw new Error('no games in league files');
    return { games, isDemo: false, generatedAt: index.generatedAt, timezone: index.timezone };
  } catch {
    const demo = await loadJSON('../data/demo.json');
    return {
      games: (demo.leagues || []).flatMap((l) => l.games || []),
      isDemo: true, warning: demo.warning, timezone: demo.timezone,
    };
  }
}

/* ---------- helpers ---------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const teamKey = (t) => (t.abbrev ? `${t.abbrev}|${t.name}` : t.name);

function todayISO() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return p;
}

function prettyDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric',
  }).format(dt);
}
function weekdayOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', weekday: 'long',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/* ---------- filtering ---------- */

function applyFilters() {
  const q = state.query.trim().toLowerCase();
  state.filtered = state.games.filter((g) => {
    if (state.league !== 'all' && g.league !== state.league) return false;
    if (state.from && g.date < state.from) return false;
    if (state.nationalOnly && !g.national) return false;
    if (state.network !== 'all' && !g.networks.includes(state.network)) return false;
    if (state.favoritesOnly
      && !state.favorites.has(teamKey(g.home))
      && !state.favorites.has(teamKey(g.away))) return false;
    if (q) {
      const hay = `${g.home.name} ${g.away.name} ${g.home.abbrev || ''} ${g.away.abbrev || ''} ${g.networks.join(' ')} ${g.venue.name || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  state.rendered = 0;
}

/* ---------- rendering ---------- */

function gameRow(g) {
  const favHome = state.favorites.has(teamKey(g.home));
  const favAway = state.favorites.has(teamKey(g.away));
  const rank = (t) => (t.rank ? `<span class="rank">#${t.rank}</span>` : '');
  const nets = g.networks.length
    ? g.networks.map((n) => `<span class="net${g.national ? ' natl' : ''}">${esc(n)}</span>`).join('')
    : '<span class="net none">Not announced</span>';

  const bits = [`<span class="lchip" data-league="${g.league}">${LEAGUE_LABEL[g.league] || g.league}</span>`];
  if (g.venue.name) {
    const loc = [g.venue.city, g.venue.state].filter(Boolean).join(', ');
    bits.push(`<span>${esc(g.venue.name)}${loc ? ` &middot; ${esc(loc)}` : ''}</span>`);
  }
  if (g.neutralSite) bits.push('<span>Neutral site</span>');
  if (g.notes) bits.push(`<span>${esc(g.notes)}</span>`);
  if (g.week) bits.push(`<span>Week ${g.week}</span>`);

  return `<div class="row">
  <div class="slot">
    <span class="t${g.timeTBD ? ' tbd' : ''}">${esc(g.time)}</span>
    <span class="z">${esc(g.timeTBD ? 'time TBD' : g.tz)}</span>
  </div>
  <div class="match">
    <div class="teams">
      <button class="star" aria-pressed="${favAway}" data-team="${esc(teamKey(g.away))}"
        title="Follow ${esc(g.away.name)}">${favAway ? '★' : '☆'}</button>${rank(g.away)}<span class="${favAway ? 'fav' : ''}">${esc(g.away.name)}</span>
      <span class="at">at</span>
      <button class="star" aria-pressed="${favHome}" data-team="${esc(teamKey(g.home))}"
        title="Follow ${esc(g.home.name)}">${favHome ? '★' : '☆'}</button>${rank(g.home)}<span class="${favHome ? 'fav' : ''}">${esc(g.home.name)}</span>
    </div>
    <div class="meta">${bits.join('')}</div>
  </div>
  <div class="nets">${nets}</div>
</div>`;
}

function renderChunk(reset) {
  const list = document.getElementById('listings');
  if (reset) { list.innerHTML = ''; state.rendered = 0; }

  if (state.filtered.length === 0) {
    list.innerHTML = `<div class="empty">
      <h3>No games match</h3>
      <p>Try clearing the search box, or switching the league filter back to All.</p>
    </div>`;
    document.getElementById('more').textContent = '';
    return;
  }

  const slice = state.filtered.slice(state.rendered, state.rendered + PAGE_SIZE);
  let html = '';
  let lastDate = state.rendered > 0 ? state.filtered[state.rendered - 1].date : null;

  for (const g of slice) {
    if (g.date !== lastDate) {
      const count = state.filtered.filter((x) => x.date === g.date).length;
      html += `<div class="day"><div class="day-head">
        <span class="dow">${weekdayOf(g.date)}</span>
        <span class="dt">${prettyDate(g.date)}</span>
        <span class="n">${count} game${count === 1 ? '' : 's'}</span>
      </div></div>`;
      lastDate = g.date;
    }
    html += gameRow(g);
  }
  list.insertAdjacentHTML('beforeend', html);
  state.rendered += slice.length;

  const left = state.filtered.length - state.rendered;
  document.getElementById('more').textContent = left > 0
    ? `Showing ${state.rendered.toLocaleString()} of ${state.filtered.length.toLocaleString()} - scroll for more`
    : `${state.filtered.length.toLocaleString()} game${state.filtered.length === 1 ? '' : 's'}`;
}

function renderSummary() {
  const games = state.filtered;
  const networks = new Set();
  let natl = 0;
  let unannounced = 0;
  for (const g of games) {
    g.networks.forEach((n) => networks.add(n));
    if (g.national) natl++;
    if (g.networks.length === 0) unannounced++;
  }
  const days = new Set(games.map((g) => g.date));
  const stats = [
    ['Games', games.length.toLocaleString()],
    ['Game days', days.size.toLocaleString()],
    ['Networks', networks.size.toLocaleString()],
    ['National TV', natl.toLocaleString()],
    ['No network yet', unannounced.toLocaleString()],
  ];
  document.getElementById('summary').innerHTML = stats
    .map(([k, n]) => `<div class="stat"><span class="n">${n}</span><span class="k">${k}</span></div>`)
    .join('');
}

function renderLeagueTabs() {
  const counts = { all: state.games.length };
  for (const g of state.games) counts[g.league] = (counts[g.league] || 0) + 1;
  const present = LEAGUE_ORDER.filter((l) => counts[l]);
  const tabs = [['all', 'All'], ...present.map((l) => [l, LEAGUE_LABEL[l]])];
  document.getElementById('leagues').innerHTML = tabs.map(([id, label]) => `
    <button class="lg" data-league="${id}" aria-pressed="${state.league === id}">
      ${id === 'all' ? '' : '<span class="dot"></span>'}${label}
      <span class="ct">${(counts[id] || 0).toLocaleString()}</span>
    </button>`).join('');
}

function renderNetworkOptions() {
  const counts = new Map();
  for (const g of state.games) {
    if (state.league !== 'all' && g.league !== state.league) continue;
    for (const n of g.networks) counts.set(n, (counts.get(n) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const sel = document.getElementById('network');
  const current = state.network;
  sel.innerHTML = '<option value="all">All networks</option>'
    + sorted.map(([n, c]) => `<option value="${esc(n)}">${esc(n)} (${c})</option>`).join('');
  sel.value = sorted.some(([n]) => n === current) ? current : 'all';
  state.network = sel.value;
}

function refresh({ tabs = false } = {}) {
  if (tabs) renderNetworkOptions();
  applyFilters();
  renderSummary();
  renderChunk(true);
  document.querySelectorAll('.lg').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.league === state.league));
  });
}

/* ---------- calendar export ---------- */

function toICS(games) {
  const pad = (n) => String(n).padStart(2, '0');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Sports Schedule//EN', 'CALSCALE:GREGORIAN'];
  for (const g of games.slice(0, 2000)) {
    if (!g.startUTC && g.timeTBD) continue;
    let stamp;
    if (g.startUTC) {
      stamp = g.startUTC.replace(/[-:]/g, '').replace(/\.\d+/, '');
      if (!stamp.endsWith('Z')) stamp += 'Z';
    } else {
      // demo rows carry no UTC instant; approximate from the Mountain clock
      const [y, m, d] = g.date.split('-').map(Number);
      const match = /(\d+):(\d+)\s*(AM|PM)/i.exec(g.time);
      if (!match) continue;
      let hh = Number(match[1]) % 12;
      if (/pm/i.test(match[3])) hh += 12;
      const offset = g.tz === 'MDT' ? 6 : 7;
      const dt = new Date(Date.UTC(y, m - 1, d, hh + offset, Number(match[2])));
      stamp = `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}00Z`;
    }
    const net = g.networks.length ? g.networks.join(', ') : 'Network not announced';
    lines.push('BEGIN:VEVENT', `UID:${g.id}@sports-schedule`, `DTSTAMP:${stamp}`,
      `DTSTART:${stamp}`, `SUMMARY:${g.away.name} at ${g.home.name} (${LEAGUE_LABEL[g.league] || g.league})`,
      `DESCRIPTION:${net}`, `LOCATION:${(g.venue.name || '').replace(/,/g, '\\,')}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function downloadICS() {
  const blob = new Blob([toICS(state.filtered)], { type: 'text/calendar' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'sports-schedule.ics';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- wiring ---------- */

function wire() {
  document.getElementById('leagues').addEventListener('click', (e) => {
    const btn = e.target.closest('.lg');
    if (!btn) return;
    state.league = btn.dataset.league;
    refresh({ tabs: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  let timer;
  document.getElementById('q').addEventListener('input', (e) => {
    clearTimeout(timer);
    const v = e.target.value;
    timer = setTimeout(() => { state.query = v; refresh(); }, 140);
  });

  document.getElementById('network').addEventListener('change', (e) => {
    state.network = e.target.value; refresh();
  });
  document.getElementById('from').addEventListener('change', (e) => {
    state.from = e.target.value; refresh();
  });
  document.getElementById('natl').addEventListener('change', (e) => {
    state.nationalOnly = e.target.checked; refresh();
  });
  document.getElementById('favs').addEventListener('change', (e) => {
    state.favoritesOnly = e.target.checked; refresh();
  });
  document.getElementById('today').addEventListener('click', () => {
    const t = todayISO();
    document.getElementById('from').value = t;
    state.from = t; refresh();
  });
  document.getElementById('reset').addEventListener('click', () => {
    state.query = ''; state.network = 'all'; state.from = '';
    state.nationalOnly = false; state.favoritesOnly = false; state.league = 'all';
    document.getElementById('q').value = '';
    document.getElementById('from').value = '';
    document.getElementById('natl').checked = false;
    document.getElementById('favs').checked = false;
    refresh({ tabs: true });
  });
  document.getElementById('ics').addEventListener('click', downloadICS);

  document.getElementById('listings').addEventListener('click', (e) => {
    const star = e.target.closest('.star');
    if (!star) return;
    const key = star.dataset.team;
    if (state.favorites.has(key)) state.favorites.delete(key);
    else state.favorites.add(key);
    saveFavorites();
    refresh();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
      e.preventDefault();
      document.getElementById('q').focus();
    }
  });

  const io = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && state.rendered < state.filtered.length) renderChunk(false);
  }, { rootMargin: '600px' });
  io.observe(document.getElementById('sentinel'));
}

/* ---------- boot ---------- */

(async function init() {
  try {
    const data = await loadData();
    state.games = data.games.sort(
      (a, b) => a.date.localeCompare(b.date) || a.sortKey - b.sortKey
        || a.home.name.localeCompare(b.home.name),
    );
    state.isDemo = data.isDemo;

    const notice = document.getElementById('notice');
    if (data.isDemo) {
      notice.innerHTML = `<div><strong>Sample data.</strong> These are illustrative
        matchups, not the published schedules. Run <code>npm run fetch</code> to pull
        the real NFL, NBA, NHL, college football and college basketball seasons.</div>`;
    } else {
      notice.classList.add('hidden');
      document.getElementById('generated').textContent =
        `Data pulled ${new Date(data.generatedAt).toLocaleString('en-US', { timeZone: 'America/Denver' })} MT`;
    }
    if (data.timezone) document.getElementById('tzname').textContent = data.timezone;

    renderLeagueTabs();
    renderNetworkOptions();
    wire();
    refresh();
  } catch (err) {
    document.getElementById('listings').innerHTML = `<div class="empty">
      <h3>Could not load schedules</h3>
      <p>${esc(err.message)}. Serve this folder over HTTP (<code>npm start</code>) rather than
      opening the file directly, so the browser can read the data files.</p></div>`;
  }
})();
