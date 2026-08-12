// Cold-load smoke for static assets (no browser).
import assert from 'node:assert/strict';

const base = process.env.APEX_BASE || 'http://127.0.0.1:8765';
const paths = [
  '/',
  '/index.html',
  '/apex.css',
  '/apex.js',
  '/apex.webmanifest',
  '/lib/engine.js',
  '/lib/market.js',
  '/lib/analytics.js',
  '/lib/store.js',
  '/lib/money.js',
  '/lib/rank.js',
  '/lib/ladder.js',
  '/lib/drive.js',
  '/RANKING.md',
  '/ROADMAP-REPLAY-DRIVE.md',
  '/study/',
  '/study/index.html',
  '/study/app.css',
  '/study/app.js',
  '/study/data/curriculum.json',
];

for (const p of paths) {
  const url = base.replace(/\/$/, '') + p.replace(/^\//, '/');
  const r = await fetch(url);
  assert.equal(r.status, 200, url);
  console.log('OK', r.status, url);
}
console.log('smoke-check OK');
