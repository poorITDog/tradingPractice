// Market data adapter: try Bybit public API, fallback to OKX (CORS/geo).

const SYMBOLS = {
  BTCUSDT: { okx: 'BTC-USDT-SWAP', tick: 0.1, lot: 0.001, mmr: 0.005 },
  ETHUSDT: { okx: 'ETH-USDT-SWAP', tick: 0.01, lot: 0.01, mmr: 0.005 },
  SOLUSDT: { okx: 'SOL-USDT-SWAP', tick: 0.001, lot: 0.1, mmr: 0.01 },
};

const INTERVAL_OKX = {
  '1': '1m', '5': '5m', '15': '15m', '60': '1H', '240': '4H', D: '1Dutc',
};
const INTERVAL_BYBIT = {
  '1': '1', '5': '5', '15': '15', '60': '60', '240': '240', D: 'D',
};

export function listSymbols() {
  return Object.keys(SYMBOLS);
}

export function symbolMeta(symbol) {
  return SYMBOLS[symbol] || SYMBOLS.BTCUSDT;
}

const INTERVAL_MS = {
  '1': 60_000, '5': 300_000, '15': 900_000, '60': 3_600_000, '240': 14_400_000, D: 86_400_000,
};

export function intervalMs(iv) {
  return INTERVAL_MS[iv] || INTERVAL_MS['5'];
}

async function probePublicSource() {
  try {
    const r = await fetch('https://api.bybit.com/v5/market/time', { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    if (r.ok && j.retCode === 0) return 'bybit';
  } catch (_) { /* fall through */ }
  try {
    const r = await fetch('https://www.okx.com/api/v5/public/time', { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    if (r.ok && j.code === '0') return 'okx';
  } catch (_) { /* fall through */ }
  throw new Error('Market data unavailable');
}

function mapBybitKline(row) {
  return {
    time: Math.floor(Number(row[0]) / 1000),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
}

function mapOkxKline(row) {
  return {
    time: Math.floor(Number(row[0]) / 1000),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
}

// Paginated historical klines (public REST, no key). Oldest-first.
export async function fetchKlinesRange(sym, iv, startMs, endMs, {
  source = 'auto', maxBars = 20000, onProgress,
} = {}) {
  const src = source === 'auto' ? await probePublicSource() : source;
  const startSec = Math.floor(startMs / 1000);
  const endSec = Math.floor(endMs / 1000);
  const out = [];
  const seen = new Set();

  if (src === 'bybit') {
    let cursorEnd = endMs;
    for (let page = 0; page < 200 && out.length < maxBars; page++) {
      const u = new URL('https://api.bybit.com/v5/market/kline');
      u.searchParams.set('category', 'linear');
      u.searchParams.set('symbol', sym);
      u.searchParams.set('interval', INTERVAL_BYBIT[iv] || '5');
      u.searchParams.set('limit', '1000');
      u.searchParams.set('start', String(startMs));
      u.searchParams.set('end', String(cursorEnd));
      const r = await fetch(u);
      const j = await r.json();
      if (j.retCode !== 0) throw new Error(j.retMsg || 'kline range');
      const batch = (j.result.list || []).map(mapBybitKline);
      if (!batch.length) break;
      let oldestMs = Infinity;
      for (const c of batch) {
        if (c.time < startSec || c.time > endSec) continue;
        if (seen.has(c.time)) continue;
        seen.add(c.time);
        out.push(c);
        oldestMs = Math.min(oldestMs, c.time * 1000);
      }
      onProgress?.({ bars: out.length, source: src });
      if (oldestMs <= startMs || batch.length < 1000) break;
      cursorEnd = oldestMs - 1;
    }
  } else {
    // OKX history-candles: after=ts returns bars older than ts (ms).
    let after = endMs;
    for (let page = 0; page < 400 && out.length < maxBars; page++) {
      const u = new URL('https://www.okx.com/api/v5/market/history-candles');
      u.searchParams.set('instId', symbolMeta(sym).okx);
      u.searchParams.set('bar', INTERVAL_OKX[iv] || '5m');
      u.searchParams.set('limit', '100');
      u.searchParams.set('after', String(after));
      const r = await fetch(u);
      const j = await r.json();
      if (j.code !== '0') throw new Error(j.msg || 'kline range');
      const batch = (j.data || []).map(mapOkxKline);
      if (!batch.length) break;
      let oldestTs = Infinity;
      for (const c of batch) {
        oldestTs = Math.min(oldestTs, c.time * 1000);
        if (c.time < startSec || c.time > endSec) continue;
        if (seen.has(c.time)) continue;
        seen.add(c.time);
        out.push(c);
      }
      onProgress?.({ bars: out.length, source: src });
      if (oldestTs <= startMs) break;
      after = oldestTs;
      if (batch.length < 100) break;
    }
  }

  out.sort((a, b) => a.time - b.time);
  return { source: src, candles: out };
}

export function createMarket(options = {}) {
  const listeners = new Set();
  let source = 'none';
  let conn = 'connecting';
  let ws = null;
  let pollTimer = null;
  let symbol = options.symbol || 'BTCUSDT';
  let interval = options.interval || '5';
  let book = { bids: [], asks: [], ts: 0 };
  let ticker = null;
  let trades = [];
  let destroyed = false;
  let reconnectAttempt = 0;

  function emit(type, payload) {
    for (const fn of listeners) fn({ type, payload, source, conn });
  }

  function setConn(next) {
    if (conn === next) return;
    conn = next;
    emit('conn', conn);
  }

  async function probeBybit() {
    const url = 'https://api.bybit.com/v5/market/time';
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('bybit http ' + r.status);
    const j = await r.json();
    if (j.retCode !== 0) throw new Error('bybit ret');
    return true;
  }

  async function probeOkx() {
    const url = 'https://www.okx.com/api/v5/public/time';
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('okx http ' + r.status);
    const j = await r.json();
    if (j.code !== '0') throw new Error('okx code');
    return true;
  }

  async function selectSource() {
    setConn('connecting');
    try {
      await probeBybit();
      source = 'bybit';
      return source;
    } catch (_) {
      // Bybit often geo/CORS blocked; OKX is the fallback path.
    }
    try {
      await probeOkx();
      source = 'okx';
      return source;
    } catch (e) {
      source = 'none';
      setConn('offline');
      emit('error', { message: 'Market data unavailable (Bybit & OKX failed)' });
      throw e;
    }
  }

  async function fetchKlines(sym = symbol, iv = interval, limit = 200) {
    if (source === 'bybit') {
      const u = new URL('https://api.bybit.com/v5/market/kline');
      u.searchParams.set('category', 'linear');
      u.searchParams.set('symbol', sym);
      u.searchParams.set('interval', INTERVAL_BYBIT[iv] || '5');
      u.searchParams.set('limit', String(limit));
      const r = await fetch(u);
      const j = await r.json();
      if (j.retCode !== 0) throw new Error(j.retMsg || 'kline');
      return (j.result.list || []).map((row) => ({
        time: Math.floor(Number(row[0]) / 1000),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
      })).reverse();
    }
    const u = new URL('https://www.okx.com/api/v5/market/candles');
    u.searchParams.set('instId', symbolMeta(sym).okx);
    u.searchParams.set('bar', INTERVAL_OKX[iv] || '5m');
    u.searchParams.set('limit', String(limit));
    const r = await fetch(u);
    const j = await r.json();
    if (j.code !== '0') throw new Error(j.msg || 'kline');
    return (j.data || []).map((row) => ({
      time: Math.floor(Number(row[0]) / 1000),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    })).reverse();
  }

  async function fetchTicker(sym = symbol) {
    if (source === 'bybit') {
      const u = new URL('https://api.bybit.com/v5/market/tickers');
      u.searchParams.set('category', 'linear');
      u.searchParams.set('symbol', sym);
      const r = await fetch(u);
      const j = await r.json();
      const t = j.result?.list?.[0];
      if (!t) throw new Error('ticker');
      ticker = {
        symbol: sym,
        last: Number(t.lastPrice),
        mark: Number(t.markPrice),
        index: Number(t.indexPrice),
        bid: Number(t.bid1Price),
        ask: Number(t.ask1Price),
        high24h: Number(t.highPrice24h),
        low24h: Number(t.lowPrice24h),
        change24h: Number(t.price24hPcnt) * 100,
        turnover24h: Number(t.turnover24h),
        fundingRate: Number(t.fundingRate),
        nextFundingTime: Number(t.nextFundingTime),
        ts: Date.now(),
      };
      return ticker;
    }
    const instId = symbolMeta(sym).okx;
    const [tRes, fRes] = await Promise.all([
      fetch('https://www.okx.com/api/v5/market/ticker?instId=' + instId),
      fetch('https://www.okx.com/api/v5/public/funding-rate?instId=' + instId),
    ]);
    const tj = await tRes.json();
    const fj = await fRes.json();
    const t = tj.data?.[0];
    const f = fj.data?.[0];
    if (!t) throw new Error('ticker');
    const open = Number(t.open24h);
    const last = Number(t.last);
    ticker = {
      symbol: sym,
      last,
      mark: Number(t.last), // OKX ticker has no separate mark; mark-px via books/mark endpoint
      index: Number(t.last),
      bid: Number(t.bidPx),
      ask: Number(t.askPx),
      high24h: Number(t.high24h),
      low24h: Number(t.low24h),
      change24h: open ? ((last - open) / open) * 100 : 0,
      turnover24h: Number(t.volCcy24h || t.vol24h),
      fundingRate: f ? Number(f.fundingRate) : 0,
      nextFundingTime: f ? Number(f.fundingTime) : 0,
      ts: Date.now(),
      markApprox: true,
    };
    // Prefer mark-price endpoint when available.
    try {
      const mr = await fetch('https://www.okx.com/api/v5/public/mark-price?instId=' + instId);
      const mj = await mr.json();
      const m = mj.data?.[0];
      if (m?.markPx) {
        ticker.mark = Number(m.markPx);
        ticker.markApprox = false;
      }
    } catch (_) { /* keep last as mark */ }
    return ticker;
  }

  async function fetchBook(sym = symbol) {
    if (source === 'bybit') {
      const u = new URL('https://api.bybit.com/v5/market/orderbook');
      u.searchParams.set('category', 'linear');
      u.searchParams.set('symbol', sym);
      u.searchParams.set('limit', '25');
      const r = await fetch(u);
      const j = await r.json();
      const b = j.result;
      book = {
        bids: (b.b || []).map(([p, s]) => [Number(p), Number(s)]),
        asks: (b.a || []).map(([p, s]) => [Number(p), Number(s)]),
        ts: Number(b.ts) || Date.now(),
      };
      return book;
    }
    const u = new URL('https://www.okx.com/api/v5/market/books');
    u.searchParams.set('instId', symbolMeta(sym).okx);
    u.searchParams.set('sz', '25');
    const r = await fetch(u);
    const j = await r.json();
    const b = j.data?.[0];
    book = {
      bids: (b?.bids || []).map((row) => [Number(row[0]), Number(row[1])]),
      asks: (b?.asks || []).map((row) => [Number(row[0]), Number(row[1])]),
      ts: Number(b?.ts) || Date.now(),
    };
    return book;
  }

  async function fetchTrades(sym = symbol) {
    if (source === 'bybit') {
      const u = new URL('https://api.bybit.com/v5/market/recent-trade');
      u.searchParams.set('category', 'linear');
      u.searchParams.set('symbol', sym);
      u.searchParams.set('limit', '30');
      const r = await fetch(u);
      const j = await r.json();
      trades = (j.result?.list || []).map((t) => ({
        id: t.execId,
        price: Number(t.price),
        size: Number(t.size),
        side: t.side === 'Buy' ? 'buy' : 'sell',
        ts: Number(t.time),
      }));
      return trades;
    }
    const u = new URL('https://www.okx.com/api/v5/market/trades');
    u.searchParams.set('instId', symbolMeta(sym).okx);
    u.searchParams.set('limit', '30');
    const r = await fetch(u);
    const j = await r.json();
    trades = (j.data || []).map((t) => ({
      id: t.tradeId,
      price: Number(t.px),
      size: Number(t.sz),
      side: t.side,
      ts: Number(t.ts),
    }));
    return trades;
  }

  async function fetchHourlyCloses(sym = symbol, limit = 30) {
    if (source === 'bybit') {
      const u = new URL('https://api.bybit.com/v5/market/kline');
      u.searchParams.set('category', 'linear');
      u.searchParams.set('symbol', sym);
      u.searchParams.set('interval', '60');
      u.searchParams.set('limit', String(limit));
      const r = await fetch(u);
      const j = await r.json();
      return (j.result?.list || []).map((row) => Number(row[4])).reverse();
    }
    const u = new URL('https://www.okx.com/api/v5/market/candles');
    u.searchParams.set('instId', symbolMeta(sym).okx);
    u.searchParams.set('bar', '1H');
    u.searchParams.set('limit', String(limit));
    const r = await fetch(u);
    const j = await r.json();
    return (j.data || []).map((row) => Number(row[4])).reverse();
  }

  function stopWs() {
    if (ws) {
      try { ws.close(); } catch (_) { /* ignore */ }
      ws = null;
    }
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function refreshRest() {
    const [t, b, tr] = await Promise.all([
      fetchTicker(symbol),
      fetchBook(symbol),
      fetchTrades(symbol),
    ]);
    emit('ticker', t);
    emit('book', b);
    emit('trades', tr);
  }

  function startPoll(ms = 2000) {
    stopPoll();
    pollTimer = setInterval(() => {
      refreshRest().catch(() => setConn('reconnecting'));
    }, ms);
  }

  function connectOkxWs() {
    stopWs();
    const instId = symbolMeta(symbol).okx;
    ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
    ws.onopen = () => {
      reconnectAttempt = 0;
      setConn('live');
      ws.send(JSON.stringify({
        op: 'subscribe',
        args: [
          { channel: 'tickers', instId },
          { channel: 'books5', instId },
          { channel: 'trades', instId },
        ],
      }));
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.event === 'error') {
        emit('error', msg);
        return;
      }
      const arg = msg.arg || {};
      const data = msg.data?.[0];
      if (!data) return;
      if (arg.channel === 'tickers') {
        const last = Number(data.last);
        ticker = {
          ...(ticker || {}),
          symbol,
          last,
          mark: ticker?.markApprox === false ? ticker.mark : last,
          bid: Number(data.bidPx),
          ask: Number(data.askPx),
          high24h: Number(data.high24h),
          low24h: Number(data.low24h),
          ts: Number(data.ts) || Date.now(),
        };
        emit('ticker', ticker);
      } else if (arg.channel === 'books5') {
        book = {
          bids: (data.bids || []).map((r) => [Number(r[0]), Number(r[1])]),
          asks: (data.asks || []).map((r) => [Number(r[0]), Number(r[1])]),
          ts: Number(data.ts) || Date.now(),
        };
        emit('book', book);
      } else if (arg.channel === 'trades') {
        const row = {
          id: data.tradeId,
          price: Number(data.px),
          size: Number(data.sz),
          side: data.side,
          ts: Number(data.ts),
        };
        trades = [row, ...trades].slice(0, 40);
        emit('trade', row);
        emit('trades', trades);
      }
    };
    ws.onclose = () => {
      if (destroyed) return;
      setConn('reconnecting');
      const delay = Math.min(15000, 800 * (2 ** reconnectAttempt) + Math.random() * 400);
      reconnectAttempt += 1;
      setTimeout(() => {
        if (!destroyed) connectOkxWs();
      }, delay);
    };
    ws.onerror = () => {
      setConn('reconnecting');
    };
  }

  function connectBybitWs() {
    stopWs();
    ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');
    ws.onopen = () => {
      reconnectAttempt = 0;
      setConn('live');
      ws.send(JSON.stringify({
        op: 'subscribe',
        args: [
          `tickers.${symbol}`,
          `orderbook.50.${symbol}`,
          `publicTrade.${symbol}`,
        ],
      }));
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.topic?.startsWith('tickers.')) {
        const t = msg.data || {};
        ticker = {
          ...(ticker || {}),
          symbol,
          last: Number(t.lastPrice ?? ticker?.last),
          mark: Number(t.markPrice ?? ticker?.mark),
          bid: Number(t.bid1Price ?? ticker?.bid),
          ask: Number(t.ask1Price ?? ticker?.ask),
          fundingRate: Number(t.fundingRate ?? ticker?.fundingRate ?? 0),
          nextFundingTime: Number(t.nextFundingTime ?? ticker?.nextFundingTime ?? 0),
          high24h: Number(t.highPrice24h ?? ticker?.high24h),
          low24h: Number(t.lowPrice24h ?? ticker?.low24h),
          change24h: t.price24hPcnt != null
            ? Number(t.price24hPcnt) * 100
            : ticker?.change24h,
          markApprox: false,
          ts: Date.now(),
        };
        emit('ticker', ticker);
      } else if (msg.topic?.startsWith('orderbook.')) {
        if (msg.type === 'snapshot' && msg.data) {
          book = {
            bids: (msg.data.b || []).map(([p, s]) => [Number(p), Number(s)]),
            asks: (msg.data.a || []).map(([p, s]) => [Number(p), Number(s)]),
            ts: Number(msg.ts) || Date.now(),
          };
          emit('book', book);
        } else {
          // Delta or unknown — REST rebuild (avoid stale walkBook depth).
          fetchBook(symbol).then((b) => emit('book', b)).catch(() => {});
        }
      } else if (msg.topic?.startsWith('publicTrade.')) {
        const arr = msg.data || [];
        for (const t of arr) {
          const row = {
            id: t.i,
            price: Number(t.p),
            size: Number(t.v),
            side: t.S === 'Buy' ? 'buy' : 'sell',
            ts: Number(t.T),
          };
          trades = [row, ...trades].slice(0, 40);
          emit('trade', row);
        }
        emit('trades', trades);
      }
    };
    ws.onclose = () => {
      if (destroyed) return;
      setConn('reconnecting');
      const delay = Math.min(15000, 800 * (2 ** reconnectAttempt) + Math.random() * 400);
      reconnectAttempt += 1;
      setTimeout(() => {
        if (!destroyed) connectBybitWs();
      }, delay);
    };
  }

  async function start() {
    destroyed = false;
    await selectSource();
    await refreshRest();
    // Mark refresh for OKX periodically (not always on ticker WS).
    startPoll(source === 'okx' ? 5000 : 15000);
    if (source === 'okx') connectOkxWs();
    else if (source === 'bybit') connectBybitWs();
    else {
      setConn('degraded');
      startPoll(2000);
    }
    return { source, conn };
  }

  async function setSymbol(next) {
    symbol = next;
    stopWs();
    await refreshRest();
    if (source === 'okx') connectOkxWs();
    else if (source === 'bybit') connectBybitWs();
    emit('symbol', symbol);
  }

  function setIntervalKey(iv) {
    interval = iv;
  }

  function destroy() {
    destroyed = true;
    stopWs();
    stopPoll();
  }

  return {
    on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    start,
    destroy,
    setSymbol,
    setIntervalKey,
    fetchKlines,
    fetchHourlyCloses,
    fetchTicker,
    refreshRest,
    getSource: () => source,
    getConn: () => conn,
    getTicker: () => ticker,
    getBook: () => book,
    getTrades: () => trades,
    getSymbol: () => symbol,
    getInterval: () => interval,
  };
}
