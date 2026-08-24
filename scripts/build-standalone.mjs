#!/usr/bin/env node
/* Bundles the app into one self-contained HTML file with its data inlined,
   for sharing or hosting without a server.

   Usage: node scripts/build-standalone.mjs [--data data/demo.json] [--out dist/sports-schedule.html]
          --fragment  omit <!doctype>/<html>/<head>/<body> (for embedding hosts) */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
};
const FRAGMENT = process.argv.includes('--fragment');
const dataPath = arg('data', 'data/demo.json');
const outPath = arg('out', FRAGMENT ? 'dist/sports-schedule.fragment.html' : 'dist/sports-schedule.html');

const [html, css, js, raw] = await Promise.all([
  readFile(join(ROOT, 'web/index.html'), 'utf8'),
  readFile(join(ROOT, 'web/styles.css'), 'utf8'),
  readFile(join(ROOT, 'web/app.js'), 'utf8'),
  readFile(join(ROOT, dataPath), 'utf8'),
]);

// If given a real pull (index.json style), stitch the league files together.
let data = JSON.parse(raw);
if (!data.leagues || !data.leagues[0]?.games) {
  const sets = await Promise.all((data.leagues || []).map(async (l) => {
    try { return JSON.parse(await readFile(join(ROOT, `data/${l.league}.json`), 'utf8')); }
    catch { return null; }
  }));
  data = { generatedAt: data.generatedAt, timezone: data.timezone, leagues: sets.filter(Boolean) };
}

const body = html
  .slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
  // Downloads are blocked in sandboxed embeds, so drop the export control there.
  .replace(FRAGMENT ? /\s*<button class="btn" id="ics"[^<]*<\/button>/ : /$^/, '')
  .replace('<script src="app.js"></script>', '');

const title = (html.match(/<title>([^<]*)<\/title>/) || [, 'Sports Schedule'])[1];
const fonts = (html.match(/<link rel="stylesheet" href="https:\/\/fonts[^>]*>/) || [''])[0];

// </script> inside the JSON would close the tag early.
const payload = JSON.stringify(data).replace(/<\//g, '<\\/');
// Sandboxed embeds cannot hand the viewer a file, so strip the export code
// entirely rather than shipping a control that silently does nothing.
let guard = js;
if (FRAGMENT) {
  const from = guard.indexOf('/* ---------- calendar export ---------- */');
  const to = guard.indexOf('/* ---------- wiring ---------- */');
  if (from > -1 && to > from) guard = guard.slice(0, from) + guard.slice(to);
  guard = guard.replace("  document.getElementById('ics').addEventListener('click', downloadICS);\n", '');
}

const inner = `${fonts}
<style>
${css}</style>
${body}
<script>
window.__SCHEDULE_DATA__ = ${payload};
${guard}</script>`;

const out = FRAGMENT
  ? `<title>${title}</title>\n${inner}`
  : `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
</head>
<body>
${inner}
</body>
</html>`;

await mkdir(join(ROOT, dirname(outPath)), { recursive: true });
await writeFile(join(ROOT, outPath), out);
const games = (data.leagues || []).reduce((n, l) => n + (l.games?.length || 0), 0);
console.log(`${outPath} - ${games} games, ${(out.length / 1024).toFixed(0)} KB`);
