// Simulated isolated one-way USDT-perp engine (micros ledger).

import {
  toMicros, fromMicros, floorToLot, roundToTick, clamp,
} from './money.js';
import { symbolMeta } from './market.js';

let seq = 1;
function id(prefix) {
  seq += 1;
  return prefix + '_' + Date.now().toString(36) + '_' + seq;
}

export function createAccount(startUsdt = 50000) {
  const wallet = toMicros(startUsdt);
  return {
    walletMicros: wallet,
    startMicros: wallet,
    positions: {}, // symbol -> position
    orders: [],
    fills: [],
    events: [],
    lastFundingSettle: {},
  };
}

export function liqPrice({ side, entry, leverage, mmr, feeRate }) {
  const f = feeRate;
  if (side === 'long') {
    return entry * (1 - 1 / leverage + mmr + f) / (1 - f);
  }
  return entry * (1 + 1 / leverage - mmr - f) / (1 + f);
}

export function upnlMicros(pos, mark) {
  const diff = pos.side === 'long' ? (mark - pos.entry) : (pos.entry - mark);
  return toMicros(diff * pos.qty);
}

export function positionNotional(pos, mark) {
  return pos.qty * mark;
}

export function imUsdt(pos, mark) {
  return positionNotional(pos, mark) / pos.leverage;
}

export function equityMicros(account, marks) {
  let eq = account.walletMicros;
  for (const [sym, pos] of Object.entries(account.positions)) {
    const mark = marks[sym];
    if (mark == null) continue;
    eq += upnlMicros(pos, mark);
  }
  return eq;
}

export function effectiveLeverage(pos, mark) {
  const notional = positionNotional(pos, mark);
  const im = imUsdt(pos, mark) + (Number(pos.extraMarginUsdt) || 0);
  if (!(im > 0)) return pos.leverage;
  return Math.max(1, Math.min(50, notional / im));
}

export function usedMarginMicros(account, marks) {
  let used = 0n;
  for (const [sym, pos] of Object.entries(account.positions)) {
    const mark = marks[sym];
    if (mark == null) continue;
    used += toMicros(imUsdt(pos, mark) + (Number(pos.extraMarginUsdt) || 0));
  }
  for (const o of account.orders) {
    if (o.status !== 'open') continue;
    const mark = marks[o.symbol] ?? o.price;
    const notional = o.qty * (o.price || mark);
    used += toMicros(notional / o.leverage);
  }
  return used;
}

export function availableMicros(account, marks) {
  return equityMicros(account, marks) - usedMarginMicros(account, marks);
}

function walkBook(side, qty, book) {
  // Buy long consumes asks; sell short consumes bids.
  const levels = side === 'buy' || side === 'long' ? book.asks : book.bids;
  if (!levels?.length) return { ok: false, reason: 'empty_book' };
  let remain = qty;
  let cost = 0;
  const legs = [];
  for (const [px, sz] of levels) {
    if (remain <= 0) break;
    const take = Math.min(remain, sz);
    cost += take * px;
    remain -= take;
    legs.push({ price: px, qty: take });
  }
  if (remain > 1e-12) return { ok: false, reason: 'insufficient_depth' };
  const avg = cost / qty;
  return { ok: true, avg, legs };
}

export function placeOrder(account, input, ctx) {
  const {
    symbol, side, ordType, qty: rawQty, price, leverage,
    reduceOnly = false, tp, sl, triggerPrice, tif = 'GTC',
  } = input;
  const { book, marks, fees, challengeLocked } = ctx;
  void challengeLocked;
  const meta = symbolMeta(symbol);
  const qty = floorToLot(rawQty, meta.lot);
  if (!(qty > 0)) return { ok: false, reason: 'qty' };
  if (!(leverage >= 1 && leverage <= 50)) return { ok: false, reason: 'leverage' };

  const pos = account.positions[symbol];
  if (reduceOnly) {
    if (!pos) return { ok: false, reason: 'no_position' };
    // One-way: reduce-only must be opposite side of the open position.
    if (pos.side === side) return { ok: false, reason: 'reduce_side' };
    if (qty > pos.qty + 1e-12) return { ok: false, reason: 'reduce_qty' };
  }
  const mark = marks[symbol];

  if (ordType === 'stop_market' || ordType === 'stop_limit' || ordType === 'conditional') {
    if (!(triggerPrice > 0)) return { ok: false, reason: 'trigger' };
    const isStopLimit = ordType === 'stop_limit';
    if (isStopLimit && !(price > 0)) return { ok: false, reason: 'price' };
    const order = {
      id: id('ord'),
      symbol,
      side,
      ordType: isStopLimit ? 'stop_limit' : 'stop_market',
      qty,
      triggerPrice: Number(triggerPrice),
      price: isStopLimit ? roundToTick(price, meta.tick) : null,
      leverage,
      reduceOnly: !!reduceOnly,
      tp: tp ?? null,
      sl: sl ?? null,
      tif: 'GTC',
      status: 'open',
      createdAt: Date.now(),
    };
    account.orders.push(order);
    return { ok: true, order };
  }

  if (ordType === 'market') {
    const walkSide = side === 'long' ? 'buy' : 'sell';
    const walked = walkBook(walkSide, qty, book);
    if (!walked.ok) return { ok: false, reason: walked.reason };
    return fillOrder(account, {
      symbol, side, qty, price: walked.avg, leverage,
      reduceOnly: !!reduceOnly, tp, sl,
      feeRate: fees.taker, liquidity: 'taker', mark,
    }, ctx);
  }

  // Limit
  if (!(price > 0)) return { ok: false, reason: 'price' };
  const metaTick = symbolMeta(symbol);
  const limitPx = roundToTick(price, metaTick.tick);
  const orderTif = tif === 'IOC' || tif === 'PostOnly' ? tif : 'GTC';
  // IOC / PostOnly immediate-cross check against mark/last
  if (orderTif === 'PostOnly' && mark != null) {
    const wouldTake = side === 'long' ? mark <= limitPx : mark >= limitPx;
    if (wouldTake) return { ok: false, reason: 'post_only' };
  }
  const order = {
    id: id('ord'),
    symbol,
    side,
    ordType: 'limit',
    qty,
    price: limitPx,
    leverage,
    reduceOnly: !!reduceOnly,
    tp: tp ?? null,
    sl: sl ?? null,
    tif: orderTif,
    status: 'open',
    createdAt: Date.now(),
  };
  // Freeze margin check
  const notional = qty * limitPx;
  const need = toMicros(notional / leverage + notional * fees.maker);
  if (!reduceOnly && availableMicros(account, marks) < need) {
    return { ok: false, reason: 'margin' };
  }
  account.orders.push(order);
  if (orderTif === 'IOC') {
    const filled = maybeFillLimits(account, { last: mark, mark, symbol }, fees);
    if (order.status === 'open') {
      order.status = 'cancelled';
      order.cancelReason = 'ioc';
    }
    return { ok: true, order, iocFills: filled };
  }
  maybeFillLimits(account, { last: mark, mark, symbol }, fees);
  return { ok: true, order };
}

function fillOrder(account, fill, ctx) {
  const {
    symbol, side, qty, price, leverage, reduceOnly, tp, sl, feeRate, liquidity, mark,
  } = fill;
  const fee = toMicros(qty * price * feeRate);
  const marks = { ...ctx.marks, [symbol]: mark ?? price };
  let pos = account.positions[symbol];

  // Closing / reducing
  if (pos && (reduceOnly || pos.side !== side)) {
    const closeQty = Math.min(qty, pos.qty);
    const pnl = upnlMicros({ ...pos, qty: closeQty }, price);
    account.walletMicros += pnl - fee;
    if (account.walletMicros < 0n) account.walletMicros = 0n;
    const closed = {
      id: id('tr'),
      symbol,
      side: pos.side,
      qty: closeQty,
      entry: pos.entry,
      exit: price,
      leverage: pos.leverage,
      pnlUsdt: fromMicros(pnl - fee),
      feeUsdt: fromMicros(fee),
      openedAt: pos.openedAt,
      closedAt: Date.now(),
      hadTp: pos.tp != null,
      hadSl: pos.sl != null,
      entryVsMa: pos.entryVsMa ?? null,
      liquidity,
      reason: fill.reason || 'close',
    };
    account.fills.push({
      id: id('fill'), symbol, side: pos.side === 'long' ? 'sell' : 'buy',
      qty: closeQty, price, feeUsdt: fromMicros(fee), ts: Date.now(), liquidity,
      reason: fill.reason || 'close',
    });
    pos.qty -= closeQty;
    if (pos.qty <= 1e-12) delete account.positions[symbol];
    account.events.push({ type: 'close', trade: closed });
    // leftover qty opening opposite is not supported unless not reduceOnly
    const leftover = qty - closeQty;
    if (leftover > 1e-12 && !reduceOnly) {
      return fillOrder(account, {
        ...fill, qty: leftover, reduceOnly: false, reason: 'flip',
      }, ctx);
    }
    return { ok: true, trade: closed, fillPrice: price, feeUsdt: fromMicros(fee) };
  }

  // Opening / adding
  const notional = qty * price;
  const im = toMicros(notional / leverage);
  if (account.walletMicros < fee || availableMicros(account, marks) < im + fee) {
    return { ok: false, reason: 'margin' };
  }
  account.walletMicros -= fee;
  if (!pos) {
    pos = {
      symbol,
      side,
      qty,
      entry: price,
      leverage,
      tp: tp ?? null,
      sl: sl ?? null,
      openedAt: Date.now(),
      entryVsMa: fill.entryVsMa ?? null,
      mmr: symbolMeta(symbol).mmr,
    };
    account.positions[symbol] = pos;
  } else {
    if (pos.side !== side) return { ok: false, reason: 'side' };
    const newQty = pos.qty + qty;
    pos.entry = (pos.entry * pos.qty + price * qty) / newQty;
    pos.qty = newQty;
    pos.leverage = leverage;
    if (tp != null) pos.tp = tp;
    if (sl != null) pos.sl = sl;
  }
  account.fills.push({
    id: id('fill'), symbol, side: side === 'long' ? 'buy' : 'sell',
    qty, price, feeUsdt: fromMicros(fee), ts: Date.now(), liquidity,
    reason: fill.reason || 'open',
  });
  account.events.push({ type: 'open', symbol, side, qty, price });
  return {
    ok: true,
    position: account.positions[symbol],
    fillPrice: price,
    feeUsdt: fromMicros(fee),
  };
}

export function topUp(account, usdt) {
  const amt = toMicros(usdt);
  if (amt <= 0n) return { ok: false, reason: 'amount' };
  account.walletMicros += amt;
  account.events.push({ type: 'topup', usdt: fromMicros(amt), ts: Date.now() });
  return { ok: true };
}

export function cancelOrder(account, orderId) {
  const o = account.orders.find((x) => x.id === orderId && x.status === 'open');
  if (!o) return { ok: false, reason: 'not_found' };
  o.status = 'cancelled';
  return { ok: true };
}

export function cancelAllOrders(account, symbol = null) {
  let count = 0;
  for (const o of account.orders) {
    if (o.status !== 'open') continue;
    if (symbol && o.symbol !== symbol) continue;
    o.status = 'cancelled';
    count += 1;
  }
  return { ok: true, count };
}

export function amendOrder(account, orderId, patch = {}) {
  const o = account.orders.find((x) => x.id === orderId && x.status === 'open');
  if (!o) return { ok: false, reason: 'not_found' };
  const meta = symbolMeta(o.symbol);
  if (o.ordType === 'limit' || o.ordType === 'stop_limit') {
    if (patch.price != null) {
      if (!(patch.price > 0)) return { ok: false, reason: 'price' };
      o.price = roundToTick(Number(patch.price), meta.tick);
    }
  }
  if (o.ordType === 'stop_market' || o.ordType === 'stop_limit') {
    if (patch.triggerPrice != null) {
      if (!(patch.triggerPrice > 0)) return { ok: false, reason: 'trigger' };
      o.triggerPrice = Number(patch.triggerPrice);
    }
  } else if (o.ordType !== 'limit') {
    return { ok: false, reason: 'not_amendable' };
  }
  if (patch.qty != null) {
    const q = floorToLot(Number(patch.qty), meta.lot);
    if (!(q > 0)) return { ok: false, reason: 'qty' };
    o.qty = q;
  }
  return { ok: true, order: o };
}

export function updatePositionBrackets(account, symbol, { tp, sl } = {}) {
  const pos = account.positions[symbol];
  if (!pos) return { ok: false, reason: 'no_position' };
  if (tp !== undefined) pos.tp = tp;
  if (sl !== undefined) pos.sl = sl;
  return { ok: true, position: pos };
}

// Move available → position extra margin (virtual IM). Does not debit wallet;
// usedMarginMicros includes extraMarginUsdt so available shrinks correctly.
export function adjustIsolatedMargin(account, symbol, deltaUsdt, marks = {}) {
  const pos = account.positions[symbol];
  if (!pos) return { ok: false, reason: 'no_position' };
  const delta = Number(deltaUsdt);
  if (!Number.isFinite(delta) || delta === 0) return { ok: false, reason: 'amount' };
  const next = (Number(pos.extraMarginUsdt) || 0) + delta;
  if (next < -1e-9) return { ok: false, reason: 'margin' };
  if (delta > 0) {
    const avail = fromMicros(availableMicros(account, marks));
    if (avail + 1e-9 < delta) return { ok: false, reason: 'margin' };
  }
  pos.extraMarginUsdt = Math.max(0, next);
  return { ok: true, position: pos };
}

export function setPositionLeverage(account, symbol, leverage) {
  const pos = account.positions[symbol];
  if (!pos) return { ok: false, reason: 'no_position' };
  if (!(leverage >= 1 && leverage <= 50)) return { ok: false, reason: 'leverage' };
  pos.leverage = leverage;
  return { ok: true, position: pos };
}

// market: { last, mark } OR { lastBySymbol, marks } — only fill orders for known symbols.
export function maybeFillLimits(account, market, fees) {
  const results = [];
  for (const o of account.orders) {
    if (o.status !== 'open') continue;
    let last;
    let mark;
    if (market.lastBySymbol) {
      last = market.lastBySymbol[o.symbol];
      if (last == null) continue;
      mark = market.marks?.[o.symbol] ?? last;
    } else {
      // Single-symbol snapshot: skip other contracts.
      if (market.symbol && o.symbol !== market.symbol) continue;
      last = market.last;
      mark = market.mark ?? last;
    }
    if (o.ordType === 'stop_market' || o.ordType === 'stop_limit') {
      const trig = o.triggerPrice;
      if (!(trig > 0) || last == null) continue;
      const hit = o.side === 'long' ? last >= trig : last <= trig;
      if (!hit) continue;
      o.status = 'filled';
      const fillPx = o.ordType === 'stop_limit' ? o.price : last;
      const r = fillOrder(account, {
        symbol: o.symbol,
        side: o.side,
        qty: o.qty,
        price: fillPx,
        leverage: o.leverage,
        reduceOnly: o.reduceOnly,
        tp: o.tp,
        sl: o.sl,
        feeRate: o.ordType === 'stop_limit' ? fees.maker : fees.taker,
        liquidity: o.ordType === 'stop_limit' ? 'maker' : 'taker',
        mark,
        reason: 'stop',
      }, { marks: { [o.symbol]: mark } });
      results.push(r);
      continue;
    }
    if (o.ordType !== 'limit') continue;
    const hit = o.side === 'long' ? last <= o.price : last >= o.price;
    if (!hit) continue;
    o.status = 'filled';
    const r = fillOrder(account, {
      symbol: o.symbol,
      side: o.side,
      qty: o.qty,
      price: o.price,
      leverage: o.leverage,
      reduceOnly: o.reduceOnly,
      tp: o.tp,
      sl: o.sl,
      feeRate: fees.maker,
      liquidity: 'maker',
      mark,
      reason: 'limit',
    }, { marks: { [o.symbol]: mark } });
    results.push(r);
  }
  return results;
}

export function onMarkUpdate(account, symbol, mark, fees) {
  const pos = account.positions[symbol];
  const out = [];
  if (!pos) return out;
  if (mark == null || !Number.isFinite(mark)) return out; // degraded: pause liq

  // Liquidation first (respect extra isolated margin via effective leverage)
  const liq = liqPrice({
    side: pos.side,
    entry: pos.entry,
    leverage: effectiveLeverage(pos, mark),
    mmr: pos.mmr ?? symbolMeta(symbol).mmr,
    feeRate: fees.taker,
  });
  const liqHit = pos.side === 'long' ? mark <= liq : mark >= liq;
  if (liqHit) {
    const r = fillOrder(account, {
      symbol,
      side: pos.side === 'long' ? 'short' : 'long',
      qty: pos.qty,
      price: liq,
      leverage: pos.leverage,
      reduceOnly: true,
      feeRate: fees.taker,
      liquidity: 'taker',
      mark,
      reason: 'liquidation',
    }, { marks: { [symbol]: mark } });
    out.push({ type: 'liquidation', ...r });
    return out;
  }

  // SL / TP
  if (pos.sl != null) {
    const slHit = pos.side === 'long' ? mark <= pos.sl : mark >= pos.sl;
    if (slHit) {
      const r = fillOrder(account, {
        symbol,
        side: pos.side === 'long' ? 'short' : 'long',
        qty: pos.qty,
        price: mark,
        leverage: pos.leverage,
        reduceOnly: true,
        feeRate: fees.taker,
        liquidity: 'taker',
        mark,
        reason: 'sl',
      }, { marks: { [symbol]: mark } });
      out.push({ type: 'sl', ...r });
      return out;
    }
  }
  if (pos.tp != null) {
    const tpHit = pos.side === 'long' ? mark >= pos.tp : mark <= pos.tp;
    if (tpHit) {
      const r = fillOrder(account, {
        symbol,
        side: pos.side === 'long' ? 'short' : 'long',
        qty: pos.qty,
        price: mark,
        leverage: pos.leverage,
        reduceOnly: true,
        feeRate: fees.taker,
        liquidity: 'taker',
        mark,
        reason: 'tp',
      }, { marks: { [symbol]: mark } });
      out.push({ type: 'tp', ...r });
    }
  }
  return out;
}

export function settleFunding(account, symbol, mark, rate, now = Date.now(), fundingTime = null) {
  const pos = account.positions[symbol];
  if (!pos || mark == null) return null;
  const key = fundingTime != null ? String(fundingTime) : 't:' + Math.floor(now / 60_000);
  if (!account.lastFundingSettle) account.lastFundingSettle = {};
  if (account.lastFundingSettle[symbol] === key) return null;
  const signedQty = pos.side === 'long' ? pos.qty : -pos.qty;
  const paymentUsdt = -signedQty * mark * rate;
  const payment = toMicros(paymentUsdt);
  account.walletMicros += payment;
  if (account.walletMicros < 0n) account.walletMicros = 0n;
  const ev = {
    type: 'funding',
    symbol,
    rate,
    paymentUsdt: fromMicros(payment),
    mark,
    ts: now,
    fundingTime: fundingTime ?? now,
  };
  account.events.push(ev);
  account.fills.push({
    id: id('fund'),
    symbol,
    side: 'funding',
    qty: pos.qty,
    price: mark,
    feeUsdt: fromMicros(payment),
    ts: now,
    liquidity: 'funding',
    reason: 'funding',
  });
  account.lastFundingSettle[symbol] = key;
  return ev;
}

export function resetAccount(startUsdt = 50000) {
  return createAccount(startUsdt);
}

export function positionView(pos, mark, feeRate) {
  if (!pos) return null;
  const upnl = fromMicros(upnlMicros(pos, mark));
  const notional = positionNotional(pos, mark);
  const baseIm = imUsdt(pos, mark);
  const extra = Number(pos.extraMarginUsdt) || 0;
  const im = baseIm + extra;
  const effLev = effectiveLeverage(pos, mark);
  const liq = liqPrice({
    side: pos.side,
    entry: pos.entry,
    leverage: effLev,
    mmr: pos.mmr ?? symbolMeta(pos.symbol).mmr,
    feeRate,
  });
  const dist = mark > 0 ? Math.abs(mark - liq) / mark : 1;
  const roiPct = im > 0 ? (upnl / im) * 100 : 0;
  return {
    ...pos,
    mark,
    upnl,
    roiPct,
    liqPrice: liq,
    distToLiq: dist,
    notional,
    im,
    effLeverage: effLev,
  };
}

export function accountSnapshot(account, marks, fees) {
  const eq = equityMicros(account, marks);
  const avail = availableMicros(account, marks);
  const positions = Object.values(account.positions).map((p) =>
    positionView(p, marks[p.symbol], fees.taker));
  return {
    wallet: fromMicros(account.walletMicros),
    equity: fromMicros(eq),
    available: fromMicros(avail),
    positions,
    openOrders: account.orders.filter((o) => o.status === 'open'),
    fills: account.fills.slice(-100).reverse(),
    returnPct: fromMicros(account.startMicros) > 0
      ? (fromMicros(eq) / fromMicros(account.startMicros) - 1) * 100
      : 0,
  };
}

export { fromMicros, toMicros, clamp };
