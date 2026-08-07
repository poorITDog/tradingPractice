import assert from 'node:assert/strict';
import {
  createAccount, placeOrder, onMarkUpdate, settleFunding, liqPrice,
  accountSnapshot, cancelOrder,
} from '../lib/engine.js';

const fees = { maker: 0.0002, taker: 0.00055 };
const book = {
  asks: [[100, 10], [100.5, 10]],
  bids: [[99.5, 10], [99, 10]],
};

// Liq formula golden values (plan §2.1.12)
const longLiq = liqPrice({ side: 'long', entry: 100, leverage: 10, mmr: 0.005, feeRate: 0.00055 });
const shortLiq = liqPrice({ side: 'short', entry: 100, leverage: 10, mmr: 0.005, feeRate: 0.00055 });
const longExpect = 100 * (1 - 1 / 10 + 0.005 + 0.00055) / (1 - 0.00055);
const shortExpect = 100 * (1 + 1 / 10 - 0.005 - 0.00055) / (1 + 0.00055);
assert.ok(Math.abs(longLiq - longExpect) < 1e-9);
assert.ok(Math.abs(shortLiq - shortExpect) < 1e-9);

let acc = createAccount(10000);
let r = placeOrder(acc, {
  symbol: 'BTCUSDT', side: 'long', ordType: 'market', qty: 0.01, leverage: 5,
}, { book, marks: { BTCUSDT: 100 }, fees });
assert.equal(r.ok, true);
assert.ok(acc.positions.BTCUSDT);
assert.ok(acc.walletMicros < acc.startMicros);

// Add to position — weighted avg
r = placeOrder(acc, {
  symbol: 'BTCUSDT', side: 'long', ordType: 'market', qty: 0.01, leverage: 5,
}, { book: { asks: [[110, 10]], bids: book.bids }, marks: { BTCUSDT: 110 }, fees });
assert.equal(r.ok, true);
assert.ok(Math.abs(acc.positions.BTCUSDT.entry - 105) < 1e-6);

// Partial close
r = placeOrder(acc, {
  symbol: 'BTCUSDT', side: 'short', ordType: 'market', qty: 0.01, leverage: 5, reduceOnly: true,
}, { book: { asks: book.asks, bids: [[120, 10]] }, marks: { BTCUSDT: 120 }, fees });
assert.equal(r.ok, true);
assert.ok(acc.positions.BTCUSDT);
assert.ok(Math.abs(acc.positions.BTCUSDT.qty - 0.01) < 1e-9);

// Funding long pays positive rate
const before = acc.walletMicros;
settleFunding(acc, 'BTCUSDT', 120, 0.01);
assert.ok(acc.walletMicros < before);

// SL trigger
acc.positions.BTCUSDT.sl = 100;
acc.positions.BTCUSDT.tp = null;
const ev = onMarkUpdate(acc, 'BTCUSDT', 99, fees);
assert.ok(ev.some((e) => e.type === 'sl'));
assert.equal(acc.positions.BTCUSDT, undefined);

// Liquidation priority
acc = createAccount(1000);
placeOrder(acc, {
  symbol: 'BTCUSDT', side: 'long', ordType: 'market', qty: 0.05, leverage: 20,
  sl: 90,
}, { book: { asks: [[100, 1]], bids: [[99, 1]] }, marks: { BTCUSDT: 100 }, fees });
const liq = liqPrice({
  side: 'long',
  entry: acc.positions.BTCUSDT.entry,
  leverage: 20,
  mmr: 0.005,
  feeRate: fees.taker,
});
const ev2 = onMarkUpdate(acc, 'BTCUSDT', liq - 0.01, fees);
assert.ok(ev2.some((e) => e.type === 'liquidation'));

// Insufficient depth reject
acc = createAccount(50000);
r = placeOrder(acc, {
  symbol: 'BTCUSDT', side: 'long', ordType: 'market', qty: 100, leverage: 2,
}, { book: { asks: [[100, 0.001]], bids: [] }, marks: { BTCUSDT: 100 }, fees });
assert.equal(r.ok, false);
assert.equal(r.reason, 'insufficient_depth');

// Limit + cancel
acc = createAccount(50000);
r = placeOrder(acc, {
  symbol: 'BTCUSDT', side: 'long', ordType: 'limit', qty: 0.01, price: 50, leverage: 5,
}, { book, marks: { BTCUSDT: 100 }, fees });
assert.equal(r.ok, true);
assert.equal(cancelOrder(acc, r.order.id).ok, true);

// Reduce-only same side rejected
acc = createAccount(10000);
placeOrder(acc, {
  symbol: 'BTCUSDT', side: 'long', ordType: 'market', qty: 0.02, leverage: 5,
}, { book, marks: { BTCUSDT: 100 }, fees });
r = placeOrder(acc, {
  symbol: 'BTCUSDT', side: 'long', ordType: 'market', qty: 0.01, leverage: 5, reduceOnly: true,
}, { book, marks: { BTCUSDT: 100 }, fees });
assert.equal(r.ok, false);
assert.equal(r.reason, 'reduce_side');

// Funding idempotent per fundingTime
acc = createAccount(10000);
placeOrder(acc, {
  symbol: 'BTCUSDT', side: 'long', ordType: 'market', qty: 0.01, leverage: 5,
}, { book, marks: { BTCUSDT: 100 }, fees });
const w0 = acc.walletMicros;
const f1 = settleFunding(acc, 'BTCUSDT', 100, 0.01, Date.now(), 111);
const w1 = acc.walletMicros;
const f2 = settleFunding(acc, 'BTCUSDT', 100, 0.01, Date.now(), 111);
assert.ok(f1);
assert.equal(f2, null);
assert.equal(acc.walletMicros, w1);
assert.ok(w1 < w0);

const snap = accountSnapshot(acc, { BTCUSDT: 100 }, fees);
assert.ok(snap.equity > 0);

// Mark null pauses liquidation
acc = createAccount(1000);
placeOrder(acc, {
  symbol: 'BTCUSDT', side: 'long', ordType: 'market', qty: 0.05, leverage: 20,
}, { book: { asks: [[100, 1]], bids: [[99, 1]] }, marks: { BTCUSDT: 100 }, fees });
assert.ok(acc.positions.BTCUSDT);
const paused = onMarkUpdate(acc, 'BTCUSDT', null, fees);
assert.equal(paused.length, 0);
assert.ok(acc.positions.BTCUSDT);

console.log('engine-test OK');
