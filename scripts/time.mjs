// Time conversion helpers.
//
// Two modes:
//   'denver' (default) - true Mountain local time, which is MDT (UTC-6) during
//                        daylight saving and MST (UTC-7) otherwise. This is the
//                        wall-clock time a viewer in the Mountain zone reads.
//   'mst'              - strict MST (UTC-7) year round, ignoring daylight saving.
//
// Most of the football season runs under MDT, so the two modes differ by an hour
// until early November. Each game records which label applies.

const DENVER = 'America/Denver';

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: DENVER,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
  weekday: 'short', timeZoneName: 'short',
});

const utcPartsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
  weekday: 'short',
});

function grab(fmt, date) {
  const out = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return out;
}

function to12Hour(hour24, minute) {
  const h = Number(hour24) % 24;
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return { display: `${h12}:${minute} ${suffix}`, suffix };
}

/**
 * Convert a UTC instant into Mountain-time fields.
 * @param {string|Date} input ISO timestamp (ESPN returns e.g. 2026-09-14T00:20Z)
 * @param {'denver'|'mst'} mode
 */
export function toMountain(input, mode = 'denver') {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return null;

  let p, tzLabel;
  if (mode === 'mst') {
    // Shift back 7 hours and read the clock in UTC -> fixed UTC-7.
    p = grab(utcPartsFmt, new Date(date.getTime() - 7 * 3600 * 1000));
    tzLabel = 'MST';
  } else {
    p = grab(partsFmt, date);
    tzLabel = p.timeZoneName; // MST or MDT
  }

  const { display } = to12Hour(p.hour, p.minute);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: display,
    tz: tzLabel,
    weekday: p.weekday,
    // minutes past midnight, for sorting within a day
    minuteOfDay: Number(p.hour) * 60 + Number(p.minute),
  };
}

/** Inclusive list of YYYYMMDD strings between two YYYY-MM-DD dates. */
export function dateRange(startISO, endISO) {
  const out = [];
  const cur = new Date(`${startISO}T12:00:00Z`);
  const end = new Date(`${endISO}T12:00:00Z`);
  while (cur <= end) {
    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth() + 1).padStart(2, '0');
    const d = String(cur.getUTCDate()).padStart(2, '0');
    out.push(`${y}${m}${d}`);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}
