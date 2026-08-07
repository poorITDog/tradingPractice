import { toMicros, fromMicros, floorToLot, clamp } from '../lib/money.js';
import assert from 'node:assert/strict';

assert.equal(fromMicros(toMicros(50000)), 50000);
assert.equal(floorToLot(0.0015, 0.001), 0.001);
assert.equal(clamp(120, 0, 100), 100);
console.log('money-test OK');
