import assert from 'node:assert/strict';
import { createAccount, placeOrder } from '../lib/engine.js';
import {
  onCandleRisk, stepReplay, playToResult, createReplaySession, synthBook,
} from '../lib/replay.js';

const fees = { maker: 0.0002, taker: 0.00055 };

function sessionFromCandles(candles, { side = 'long', tp, sl, qty = 0.01 } = {}) {
  const account = createAccount(50000);
  const first = candles[0];
  const book = synthBook(first.open);
  const r = placeOrder(account, {
    symbol: 'BTCUSDT',
    side,
    ordType: 'market',
    qty,
    leverage: 5,
    tp: tp ?? null,
    sl: sl ?? null,
  }, {
    book,
    marks: { BTCUSDT: first.open },
    fees,
  });
  assert.equal(r.ok, true, 'open should fill');
  // Start cursor at 1 so first risk candle is candles[1] (entry on open of [0]).
  const session = createReplaySession({
    symbol: 'BTCUSDT',
    interval: '5',
    candles,
    account,
    startBalance: 50000,
    fees,
  });
  session.cursor = 1;
  return session;
}

// SL before TP on same path (long): dips to SL then rips to TP — SL wins.
{
  const candles = [
    { time: 1000, open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { time: 1300, open: 100, high: 100.5, low: 94, close: 95, volume: 1 }, // SL 95
    { time: 1600, open: 95, high: 120, low: 94, close: 118, volume: 1 },
  ];
  const session = sessionFromCandles(candles, { side: 'long', tp: 110, sl: 95 });
  const out = playToResult(session);
  assert.equal(out.reason, 'sl');
  assert.ok(session.result.pnlUsdt < 0 || session.result.reason === 'sl');
  assert.equal(session.account.positions.BTCUSDT, undefined);
}

// TP before SL (long): rallies to TP without touching SL.
{
  const candles = [
    { time: 2000, open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { time: 2300, open: 100, high: 112, low: 99.5, close: 111, volume: 1 },
    { time: 2600, open: 111, high: 113, low: 80, close: 85, volume: 1 },
  ];
  const session = sessionFromCandles(candles, { side: 'long', tp: 110, sl: 90 });
  const out = playToResult(session);
  assert.equal(out.reason, 'tp');
  assert.ok(session.result.pnlUsdt > 0);
}

// Same bar contains both SL and TP extremes — adverse (SL) wins for long.
// Keep low above ~5x liq (~80.5) so SL triggers instead of liquidation.
{
  const candles = [
    { time: 3000, open: 100, high: 100, low: 100, close: 100, volume: 1 },
    { time: 3300, open: 100, high: 120, low: 91, close: 100, volume: 1 },
  ];
  const account = createAccount(50000);
  placeOrder(account, {
    symbol: 'BTCUSDT', side: 'long', ordType: 'market', qty: 0.01, leverage: 5,
    tp: 110, sl: 92,
  }, { book: synthBook(100), marks: { BTCUSDT: 100 }, fees });
  const evs = onCandleRisk(account, 'BTCUSDT', candles[1], fees);
  assert.equal(evs[0]?.type, 'sl');
}

// stepReplay advances cursor and pauses on hit when used one-by-one.
{
  const candles = [
    { time: 4000, open: 100, high: 100, low: 100, close: 100, volume: 1 },
    { time: 4300, open: 100, high: 101, low: 99, close: 100.5, volume: 1 },
    { time: 4600, open: 100.5, high: 101, low: 89, close: 90, volume: 1 },
  ];
  const session = sessionFromCandles(candles, { side: 'long', sl: 90, tp: 200 });
  const a = stepReplay(session, 1);
  assert.equal(a.done, false);
  const b = stepReplay(session, 1);
  assert.equal(b.done, true);
  assert.equal(b.reason, 'sl');
}

console.log('replay-test OK');
