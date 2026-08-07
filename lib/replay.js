// Historical candle replay clock — reuses engine mark/limit fills.

import { maybeFillLimits, onMarkUpdate, accountSnapshot } from './engine.js';

export function synthBook(px) {
  const p = Number(px);
  return {
    asks: [[p * 1.00005, 1e9]],
    bids: [[p * 0.99995, 1e9]],
    ts: Date.now(),
  };
}

export function synthTicker(symbol, candle, fundingRate = 0) {
  const last = candle.close;
  return {
    symbol,
    last,
    mark: last,
    index: last,
    bid: last * 0.99995,
    ask: last * 1.00005,
    high24h: candle.high,
    low24h: candle.low,
    change24h: 0,
    turnover24h: 0,
    fundingRate,
    nextFundingTime: 0,
    markApprox: false,
    ts: candle.time * 1000,
    replay: true,
  };
}

// Per-candle risk: adverse extreme first (SL/liq), then favorable (TP).
// Same-bar both hit → SL/liq wins (conservative, matches engine priority).
export function onCandleRisk(account, symbol, candle, fees) {
  const pos = account.positions[symbol];
  const lastBySymbol = { [symbol]: candle.close };
  const marks = { [symbol]: candle.close };
  maybeFillLimits(account, { lastBySymbol, marks, last: candle.close, mark: candle.close, symbol }, fees);
  if (!account.positions[symbol] && !pos) return [];

  const side = account.positions[symbol]?.side || pos?.side;
  if (!side) return [];

  const adverse = side === 'long' ? candle.low : candle.high;
  const favorable = side === 'long' ? candle.high : candle.low;

  let evs = onMarkUpdate(account, symbol, adverse, fees);
  if (evs.length) return evs;
  if (!account.positions[symbol]) return [];

  evs = onMarkUpdate(account, symbol, favorable, fees);
  if (evs.length) return evs;
  if (!account.positions[symbol]) return [];

  return onMarkUpdate(account, symbol, candle.close, fees);
}

export function createReplaySession({
  symbol, interval, candles, account, startBalance, fees,
}) {
  return {
    active: true,
    symbol,
    interval,
    candles,
    cursor: 0,
    speed: 1,
    playing: false,
    account,
    startBalance,
    fees,
    openedAt: Date.now(),
    startEquity: startBalance,
    maxUpnl: 0,
    minUpnl: 0,
    result: null,
    source: null,
  };
}

export function currentCandle(session) {
  if (!session?.candles?.length) return null;
  const i = Math.min(session.cursor, session.candles.length - 1);
  return session.candles[i];
}

export function replayProgress(session) {
  const n = session.candles?.length || 0;
  if (!n) return { i: 0, n: 0, pct: 0 };
  const i = Math.min(session.cursor, n - 1);
  return { i, n, pct: ((i + 1) / n) * 100 };
}

function trackExtremes(session) {
  const c = currentCandle(session);
  if (!c) return;
  const snap = accountSnapshot(session.account, { [session.symbol]: c.close }, session.fees);
  const upnl = snap.equity - snap.wallet;
  if (upnl > session.maxUpnl) session.maxUpnl = upnl;
  if (upnl < session.minUpnl) session.minUpnl = upnl;
}

// Advance one candle; returns { done, events, candle, reason }.
export function stepReplay(session, n = 1) {
  const events = [];
  let lastCandle = null;
  for (let k = 0; k < n; k++) {
    if (session.cursor >= session.candles.length) {
      return { done: true, reason: 'end', events, candle: lastCandle };
    }
    const candle = session.candles[session.cursor];
    lastCandle = candle;
    const evs = onCandleRisk(session.account, session.symbol, candle, session.fees);
    events.push(...evs);
    trackExtremes(session);
    session.cursor += 1;
    const hit = evs.find((e) => e.type === 'sl' || e.type === 'tp' || e.type === 'liquidation');
    if (hit) {
      return { done: true, reason: hit.type, events, candle, hit };
    }
  }
  if (session.cursor >= session.candles.length) {
    return { done: true, reason: 'end', events, candle: lastCandle };
  }
  return { done: false, reason: null, events, candle: lastCandle };
}

// Fast-forward until TP/SL/liq/end (no UI). Cap steps for safety.
export function playToResult(session, { maxSteps = 200000 } = {}) {
  const all = [];
  for (let i = 0; i < maxSteps; i++) {
    const r = stepReplay(session, 1);
    all.push(...r.events);
    if (r.done) {
      return finishResult(session, r.reason, r.hit, all);
    }
  }
  return finishResult(session, 'cap', null, all);
}

export function finishResult(session, reason, hit, events = []) {
  const c = currentCandle(session) || session.candles[session.candles.length - 1];
  const mark = c ? c.close : 0;
  const snap = accountSnapshot(session.account, { [session.symbol]: mark }, session.fees);
  const closeEv = [...(session.account.events || [])].reverse()
    .find((e) => e.type === 'close' && e.trade);
  const trade = closeEv?.trade || hit?.trade || null;
  const result = {
    id: 'rp_' + Date.now().toString(36),
    symbol: session.symbol,
    interval: session.interval,
    reason,
    exitPrice: trade?.exit ?? mark,
    pnlUsdt: trade?.pnlUsdt ?? (snap.equity - session.startEquity),
    feeUsdt: trade?.feeUsdt ?? 0,
    durationBars: session.cursor,
    maxUpnl: session.maxUpnl,
    minUpnl: session.minUpnl,
    startTime: session.candles[0]?.time ? session.candles[0].time * 1000 : null,
    endTime: c ? c.time * 1000 : null,
    ts: Date.now(),
  };
  session.result = result;
  session.playing = false;
  return { result, events, reason };
}

// Tick interval ms for UI timer from speed multiplier.
export function replayTickMs(speed) {
  const s = Math.max(1, Number(speed) || 1);
  return Math.max(16, Math.floor(200 / s));
}
