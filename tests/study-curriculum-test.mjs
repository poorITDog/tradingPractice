import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const c = JSON.parse(readFileSync(join(root, 'study/data/curriculum.json'), 'utf8'));

assert.equal(c.cardCount, 118);
assert.equal(c.cards.length, 118);
assert.equal(c.chapters.length, 9);
assert.equal(c.glossary.length >= 10, true);

const ids = new Set();
for (const card of c.cards) {
  assert.ok(card.id && !ids.has(card.id), 'unique id');
  ids.add(card.id);
  const ch = c.chapters.find((x) => x.id === card.chapter);
  assert.ok(ch, 'chapter exists ' + card.chapter);
  assert.ok(ch.lessons.some((l) => l.id === card.lesson), 'lesson ' + card.lesson);
  assert.ok(card.front.length > 0, 'front');
  assert.ok(card.back.length > 0, 'back non-empty');
}

// lesson size budget
const counts = new Map();
for (const card of c.cards) {
  const k = card.chapter + '/' + card.lesson;
  counts.set(k, (counts.get(k) || 0) + 1);
}
for (const [k, n] of counts) {
  assert.ok(n <= 15, 'lesson too big ' + k + ' ' + n);
}

// ch5 optional
assert.equal(c.chapters.find((x) => x.id === 'ch5').optional, true);
// PO3 in ch7
assert.ok(c.cards.some((x) => x.chapter === 'ch7' && /po3/i.test(x.front)));
// RSI correction present
const rsi = c.cards.find((x) => /^rsi/i.test(x.front));
assert.ok(rsi && rsi.back.includes('超買'));

console.log('study-curriculum-test OK', counts.size, 'lessons');
