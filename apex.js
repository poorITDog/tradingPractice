import { createMarket, listSymbols, symbolMeta, fetchKlinesRange } from './lib/market.js';
import {
  createAccount, placeOrder, cancelOrder, cancelAllOrders, amendOrder,
  maybeFillLimits, onMarkUpdate, settleFunding, accountSnapshot, liqPrice,
  resetAccount, topUp, updatePositionBrackets, adjustIsolatedMargin,
  setPositionLeverage,
} from './lib/engine.js';
import { loadState, saveState, exportState, importState } from './lib/store.js';
import {
  abilityScore, sixDimensions, rankTier, ma, entryVsMaSign,
  maxDrawdownPct, sharpeLike, dayKey, buildDailyLedger, periodPnLStats,
  aggregateCosts, pickEquitySeries, exportDailyStatementCsv, taipeiYMD, filterClosedTrades,
} from './lib/analytics.js';
import {
  startChallenge, challengeRemaining, settleChallenge, pushLeaderboard, exportScoreCard,
  defaultLadder,
} from './lib/rank.js';
import {
  formatRank, nextRankHint, displayTier, TIER_LABEL,
} from './lib/ladder.js';
import { createDriveClient, DRIVE_FILE } from './lib/drive.js';
import {
  createReplaySession, stepReplay, playToResult, finishResult, synthBook, synthTicker,
  currentCandle, replayProgress, replayTickMs,
} from './lib/replay.js';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const loaded = loadState();
let state = loaded.state;
if (!state.account) state.account = createAccount(state.settings.startBalance);
if (!state.ladder) state.ladder = defaultLadder();
if (!Array.isArray(state.replayResults)) state.replayResults = [];

const market = createMarket({
  symbol: state.ui.symbol || 'BTCUSDT',
  interval: state.ui.interval || '5',
});

let chartApi = null;
let candleSeries = null;
let marks = {}; // mark for liq (null when degraded)
let lastPrices = {}; // last trade price for UI / margin fallback
let hourlyCloses = {};
let lastFundingCheck = 0;
let markDegraded = false;
let posTab = 'positions';
let ordType = 'market';
let submitSide = 'long';
let coachStep = 0;
let rankSort = 'score';
let lastLiqWarnAt = 0;
let driveSyncStatus = 'disconnected';
let lastOffSymbolPoll = 0;
let portfolioMonth = null; // Date at month start
let portfolioRange = '30';
let portfolioDay = null;
let portfolioFilterSym = '';
let portfolioFilterFrom = '';
let portfolioFilterTo = '';
let blotterFilterSym = '';
let blotterFilterFrom = '';
let blotterFilterTo = '';
let lastHourlySample = 0;
// Replay session (isolated from live practice account).
let replaySession = null;
let liveBackup = null;
let replayTimer = null;
let replayLoadPct = 0;
const FILL_TYPE = {
  liquidation: '強平', funding: '資金費', sl: '停損', tp: '止盈',
  stop: '條件', trail: '追蹤', taker: '吃單', maker: '掛單', limit: '限價', close: '平倉', open: '開倉',
};
const FILL_SIDE = { buy: '買', sell: '賣', long: '多', short: '空', funding: '資金費' };

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2800);
}

const drive = createDriveClient({
  getState: () => state,
  setState: (next) => { state = next; },
  saveLocal: () => {
    try { saveState(state); } catch (e) { console.warn(e); }
  },
  onStatus: (s) => {
    driveSyncStatus = s;
    const pill = $('#drivePill');
    if (pill) pill.textContent = '雲端 · ' + drive.statusLabel(s);
  },
  toast,
});

function isReplay() {
  return !!(replaySession && replaySession.active);
}

function persist() {
  // During replay the live account is swapped out — never write that to disk.
  if (isReplay()) return;
  try {
    state.syncUpdatedAt = Date.now();
    const r = saveState(state);
    if (!r.ok && r.reason === 'quota') toast('儲存空間不足');
    else if (!r.ok) console.warn('saveState', r.reason);
    else drive.scheduleUpload();
  } catch (e) {
    console.warn('persist failed', e);
  }
}

function persistReplayResultsOnly() {
  if (!liveBackup) return;
  const bak = {
    account: state.account,
    closedTrades: state.closedTrades,
    equitySamples: state.equitySamples,
  };
  state.account = liveBackup.account;
  state.closedTrades = liveBackup.closedTrades;
  state.equitySamples = liveBackup.equitySamples;
  try {
    state.syncUpdatedAt = Date.now();
    saveState(state);
  } catch (e) {
    console.warn('persistReplayResultsOnly', e);
  } finally {
    state.account = bak.account;
    state.closedTrades = bak.closedTrades;
    state.equitySamples = bak.equitySamples;
  }
}

function activeTicker() {
  if (isReplay()) {
    const c = currentCandle(replaySession);
    return c ? synthTicker(replaySession.symbol, c) : null;
  }
  return market.getTicker();
}

function activeBook() {
  if (isReplay()) {
    const c = currentCandle(replaySession);
    return c ? synthBook(c.close) : null;
  }
  return market.getBook();
}

function activeSymbol() {
  return isReplay() ? replaySession.symbol : market.getSymbol();
}

// Book for the active symbol, or a deep synthetic book for off-symbol close.
function bookFor(sym) {
  if (isReplay() && sym === replaySession.symbol) return activeBook();
  if (sym === market.getSymbol()) return market.getBook();
  const px = marks[sym] ?? lastPrices[sym];
  if (!(px > 0)) return null;
  return synthBook(px);
}

function markFor(sym) {
  if (marks[sym] != null) return marks[sym];
  if (lastPrices[sym] != null) return lastPrices[sym];
  const t = activeTicker();
  if (t && activeSymbol() === sym) return t.markApprox ? t.last : t.mark;
  return null;
}

function confirmTradeAction({ title, body, confirmLabel = '確認', danger = false }) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'confirm-sheet';
    el.innerHTML = `<div class="card" role="dialog" aria-modal="true">
      <h3>${title}</h3>
      <p class="confirm-body">${body}</p>
      <div class="side-actions">
        <button type="button" class="btn ghost" data-a="cancel">取消</button>
        <button type="button" class="btn ${danger ? 'danger' : 'accent'}" data-a="ok">${confirmLabel}</button>
      </div></div>`;
    document.body.appendChild(el);
    el.onclick = (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      el.remove();
      resolve(a === 'ok');
    };
  });
}

function formSheet({ title, fields, confirmLabel = '確認' }) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'confirm-sheet';
    const inputs = fields.map((f) => `<label class="field">${f.label}
      <input id="fs_${f.id}" type="${f.type || 'text'}" value="${f.value ?? ''}" step="any" /></label>`).join('');
    el.innerHTML = `<div class="card" role="dialog" aria-modal="true">
      <h3>${title}</h3>
      ${inputs}
      <div class="side-actions">
        <button type="button" class="btn ghost" data-a="cancel">取消</button>
        <button type="button" class="btn accent" data-a="ok">${confirmLabel}</button>
      </div></div>`;
    document.body.appendChild(el);
    el.onclick = (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      if (a === 'cancel') { el.remove(); resolve(null); return; }
      const out = {};
      for (const f of fields) out[f.id] = el.querySelector('#fs_' + f.id)?.value ?? '';
      el.remove();
      resolve(out);
    };
  });
}

async function selectSymbol(sym) {
  if (!sym || sym === market.getSymbol()) return;
  // remember leverage for current symbol
  if (!state.ui.levBySymbol) state.ui.levBySymbol = {};
  state.ui.levBySymbol[market.getSymbol()] = levEffective();
  state.ui.symbol = sym;
  persist();
  await market.setSymbol(sym);
  const saved = state.ui.levBySymbol[sym]
    || state.account.positions[sym]?.leverage
    || Number($('#leverage').value);
  $('#leverage').value = String(saved);
  $('#leverage').dispatchEvent(new Event('input'));
  renderSymbols();
  refreshTicketHead();
  refreshKlines();
  loadHourly();
  updatePreSummary();
}

function refreshTicketHead() {
  const el = $('#ticketSym');
  if (!el) return;
  const mode = isReplay() ? ' · 回放撮合簡化' : '';
  el.textContent = `${activeSymbol()} 永續 · 逐倉 · 單向${mode}`;
}

async function pollOffSymbolRisk() {
  if (isReplay()) return;
  const now = Date.now();
  if (now - lastOffSymbolPoll < 4000) return;
  lastOffSymbolPoll = now;
  const active = market.getSymbol();
  const needed = new Set([
    ...Object.keys(state.account.positions || {}),
    ...state.account.orders.filter((o) => o.status === 'open').map((o) => o.symbol),
  ]);
  needed.delete(active);
  for (const sym of needed) {
    try {
      const t = await market.fetchTicker(sym);
      lastPrices[sym] = t.last;
      marks[sym] = t.markApprox ? null : t.mark;
      if (!t.markApprox && t.mark != null) {
        const riskEvs = onMarkUpdate(state.account, sym, t.mark, fees());
        for (const ev of riskEvs) {
          const label = ev.type === 'liquidation' ? '強平' : ev.type === 'sl' ? '停損觸發' : '止盈觸發';
          toast(`${label} ${sym}`);
        }
      }
      if (t.fundingRate != null) {
        const fundEv = settleFunding(
          state.account, sym, t.markApprox ? t.last : t.mark, t.fundingRate, now, t.nextFundingTime,
        );
        if (fundEv) sampleEquity();
      }
    } catch (_) { /* optional */ }
  }
  harvestCloses();
}

function fees() {
  return { maker: state.settings.makerFee, taker: state.settings.takerFee };
}

function sampleEquity() {
  const snap = accountSnapshot(state.account, displayMarks(), fees());
  state.equitySamples.push({ t: Date.now(), equity: snap.equity });
  if (state.equitySamples.length > 2000) state.equitySamples.shift();
}

function challengeBlocksTrading() {
  if (isReplay()) return false;
  const ch = state.challenge;
  if (!ch || ch.status !== 'active') return false;
  return challengeRemaining(ch) <= 0;
}

function refreshRankPill() {
  const el = $('#rankPill');
  if (!el) return;
  el.textContent = formatRank(state.ladder || defaultLadder());
}

function finalizeChallengeSettle(res) {
  state.challenge = res.challenge;
  if (res.ladder) state.ladder = res.ladder;
  const pushed = pushLeaderboard(state.leaderboard, res.entry);
  state.leaderboard = pushed.board;
  persist();
  refreshRankPill();
  toast(res.ranked?.message || res.entry.message || (pushed.accepted
    ? `排位賽結算 · 能力分 ${res.entry.score?.toFixed?.(1)}`
    : '排位賽結算 · 樣本不足，段位不變'));
  return true;
}

function maybeAutoSettleChallenge() {
  const ch = state.challenge;
  if (!ch || ch.status !== 'active') return false;
  if (challengeRemaining(ch) > 0) return false;
  const res = settleChallenge({
    challenge: ch,
    trades: closedTrades(),
    equitySamples: state.equitySamples,
    startEquity: ch.startBalance || 50000,
    ladder: state.ladder || defaultLadder(),
  });
  if (!res.ok) return false;
  return finalizeChallengeSettle(res);
}

function closedTrades() {
  return state.closedTrades;
}

function harvestCloses() {
  const evs = state.account.events || [];
  while (evs.length) {
    const ev = evs.shift();
    if (ev.type === 'close' && ev.trade) {
      state.closedTrades.push(ev.trade);
      sampleEquity();
    }
  }
}

function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === name));
  $$('.nav button').forEach((b) => b.classList.toggle('active', b.dataset.nav === name));
  if (name === 'portfolio') renderPortfolio();
  if (name === 'analyze') renderAnalyze();
  if (name === 'rank') renderRank();
  if (name === 'replay') renderReplay();
  if (name === 'settings') renderSettings();
}

function enterApp() {
  $('#splash').classList.add('hidden');
  $('#app').classList.remove('hidden');
  state.ui.entered = true;
  persist();
  initChart();
  maybeAutoSettleChallenge();
  market.start().then(() => {
    $('#srcPill').textContent = market.getSource();
    refreshKlines();
    loadHourly();
    if (!state.settings.coachDone) showCoach(0);
  }).catch(() => {
    toast('無法取得行情，請檢查網路');
  });
}

function showCoach(step) {
  coachStep = step;
  const steps = [
    { t: '圖表', d: '這裡是真實 K 線。先觀察趨勢，再決定方向。' },
    { t: '槓桿', d: '新手預設上限 5x。槓桿愈高，距離強平愈近。' },
    { t: '做多／做空', d: '綠色做多、紅色做空。下單前會顯示保證金與預估強平。' },
  ];
  const s = steps[step];
  const el = $('#coach');
  el.classList.remove('hidden');
  el.innerHTML = `<div class="coach-card">
    <h2>步驟 ${step + 1}/3 · ${s.t}</h2>
    <p>${s.d}</p>
    <button type="button" class="btn accent" id="coachNext">${step < 2 ? '下一步' : '開始交易'}</button>
    <button type="button" class="btn ghost" id="coachSkip" style="margin-top:8px">跳過教學</button>
  </div>`;
  $('#coachNext').onclick = () => {
    if (step < 2) showCoach(step + 1);
    else {
      el.classList.add('hidden');
      state.settings.coachDone = true;
      persist();
    }
  };
  $('#coachSkip').onclick = () => {
    el.classList.add('hidden');
    state.settings.coachDone = true;
    persist();
  };
}

function initChart() {
  const el = $('#chart');
  if (!window.LightweightCharts) {
    el.textContent = '圖表庫載入失敗';
    return;
  }
  chartApi = LightweightCharts.createChart(el, {
    layout: { background: { color: '#121820' }, textColor: '#8B9AAB' },
    grid: { vertLines: { color: '#1E2833' }, horzLines: { color: '#1E2833' } },
    rightPriceScale: { borderColor: '#1E2833' },
    timeScale: { borderColor: '#1E2833' },
    crosshair: { mode: 0 },
  });
  candleSeries = chartApi.addCandlestickSeries({
    upColor: '#0ECB81', downColor: '#F6465D',
    borderUpColor: '#0ECB81', borderDownColor: '#F6465D',
    wickUpColor: '#0ECB81', wickDownColor: '#F6465D',
  });
  new ResizeObserver(() => {
    chartApi.applyOptions({ width: el.clientWidth, height: el.clientHeight });
  }).observe(el);
}

async function refreshKlines() {
  try {
    const rows = await market.fetchKlines();
    candleSeries?.setData(rows);
  } catch (e) {
    toast('K 線載入失敗');
  }
}

async function loadHourly() {
  try {
    hourlyCloses[market.getSymbol()] = await market.fetchHourlyCloses(market.getSymbol(), 30);
  } catch (_) { /* optional */ }
}

function renderSymbols() {
  const box = $('#symbolTabs');
  const cur = activeSymbol();
  box.innerHTML = listSymbols().map((s) =>
    `<button type="button" data-sym="${s}" class="${s === cur ? 'active' : ''}">${s.replace('USDT', '')}</button>`
  ).join('');
  box.onclick = async (e) => {
    const b = e.target.closest('button[data-sym]');
    if (!b) return;
    if (isReplay()) return toast('回放中不可切換合約，請先結束回放');
    state.ui.symbol = b.dataset.sym;
    persist();
    await market.setSymbol(b.dataset.sym);
    renderSymbols();
    refreshKlines();
    loadHourly();
  };
}

function renderIntervals() {
  const ivs = [['1', '1m'], ['5', '5m'], ['15', '15m'], ['60', '1h'], ['240', '4h'], ['D', '1D']];
  const box = $('#intervals');
  const cur = isReplay() ? replaySession.interval : market.getInterval();
  box.innerHTML = ivs.map(([k, lab]) =>
    `<button type="button" data-iv="${k}" class="${k === cur ? 'active' : ''}">${lab}</button>`
  ).join('');
  box.onclick = (e) => {
    const b = e.target.closest('button[data-iv]');
    if (!b) return;
    if (isReplay()) return toast('回放中不可切換週期');
    market.setIntervalKey(b.dataset.iv);
    state.ui.interval = b.dataset.iv;
    persist();
    renderIntervals();
    refreshKlines();
  };
}

function updateConn(conn) {
  const pill = $('#connPill');
  const map = {
    connecting: '連線中',
    live: '即時',
    reconnecting: '重連中',
    degraded: '降級',
    offline: '離線',
  };
  pill.textContent = map[conn] || conn;
  pill.className = 'pill ' + (conn === 'live' ? 'live' : conn === 'offline' ? 'bad' : '');
}

function displayMarks() {
  const out = { ...lastPrices };
  for (const [k, v] of Object.entries(marks)) {
    if (v != null) out[k] = v;
  }
  return out;
}

function updateTicker(t) {
  if (!t || isReplay()) return;
  lastPrices[t.symbol] = t.last;
  marks[t.symbol] = t.markApprox ? null : t.mark;
  if (t.markApprox) {
    markDegraded = true;
    updateConn('degraded');
  } else if (markDegraded) {
    markDegraded = false;
    updateConn(market.getConn() === 'live' ? 'live' : market.getConn());
  }
  const last = t.last;
  const ch = t.change24h;
  const cls = ch >= 0 ? 'up' : 'down';
  $('#tickerStrip').innerHTML = `<span class="${cls} flash">${last?.toFixed(2)}</span>
    · 標記 ${t.markApprox ? '≈' : ''}${Number(t.mark).toFixed(2)}
    · 24h <span class="${cls}">${ch?.toFixed(2)}%</span>
    · 資金費率 ${(Number(t.fundingRate || 0) * 100).toFixed(4)}%`;
  maybeFillLimits(state.account, {
    lastBySymbol: { ...lastPrices },
    marks: { ...displayMarks() },
  }, fees());
  // Risk for every known mark (active + cached off-symbol).
  for (const [sym, mk] of Object.entries(marks)) {
    if (mk == null) continue;
    const riskEvs = onMarkUpdate(state.account, sym, mk, fees());
    for (const ev of riskEvs) {
      const label = ev.type === 'liquidation' ? '強平' : ev.type === 'sl' ? '停損觸發' : '止盈觸發';
      toast(`${label} ${sym}`);
    }
  }
  maybeAutoSettleChallenge();
  const structural = (state.account.events || []).some(
    (e) => e.type === 'close' || e.type === 'open',
  );
  harvestCloses();
  checkFunding(t);
  pollOffSymbolRisk();
  renderEquity();
  renderPosTab();
  updatePreSummary();
  warnLiqProximity();
  refreshTicketHead();
  if ($('#view-portfolio')?.classList.contains('active')) renderPortfolio();
  // live candle last
  if (candleSeries && last) {
    try {
      const intervalSec = { '1': 60, '5': 300, '15': 900, '60': 3600, '240': 14400, D: 86400 };
      const step = intervalSec[market.getInterval()] || 300;
      const time = Math.floor(Date.now() / 1000 / step) * step;
      candleSeries.update({
        time, open: last, high: last, low: last, close: last,
      });
    } catch (_) { /* ignore partial candle */ }
  }
  // Persist on open/close from limit fills — not every tick.
  if (structural) persist();
}

function checkFunding(t) {
  if (!t?.nextFundingTime || t.fundingRate == null) return;
  const now = Date.now();
  if (now < t.nextFundingTime) return;
  if (now - lastFundingCheck < 5_000) return;
  lastFundingCheck = now;
  if (t.markApprox || t.mark == null) return;
  const ev = settleFunding(
    state.account, t.symbol, t.mark, t.fundingRate, now, t.nextFundingTime,
  );
  if (ev) {
    toast(`資金費 ${ev.paymentUsdt.toFixed(4)} USDT`);
    sampleEquity();
    persist();
  }
}

function renderBook(book) {
  const el = $('#book');
  if (!book) return;
  const asks = [...book.asks].slice(0, 8).reverse();
  const bids = book.bids.slice(0, 8);
  el.innerHTML = `<div style="color:var(--muted);margin-bottom:4px">訂單簿</div>`
    + asks.map(([p, s]) => `<div class="down"><span>${p}</span><span>${s}</span></div>`).join('')
    + `<div style="height:6px"></div>`
    + bids.map(([p, s]) => `<div class="up"><span>${p}</span><span>${s}</span></div>`).join('');
}

function renderTrades(trades) {
  const el = $('#recentTrades');
  el.innerHTML = `<div style="color:var(--muted);margin-bottom:4px">成交</div>`
    + (trades || []).slice(0, 12).map((t) =>
      `<div class="${t.side === 'buy' ? 'up' : 'down'} flash"><span>${t.price}</span><span>${t.size}</span></div>`
    ).join('');
}

function levEffective() {
  let lev = Number($('#leverage').value);
  if (state.settings.beginnerCap) lev = Math.min(lev, state.settings.maxLeverageCap || 5);
  return lev;
}

function updatePreSummary() {
  const t = activeTicker();
  const sym = activeSymbol();
  const rawQty = Number($('#qty').value) || 0;
  const lev = levEffective();
  const px = (ordType === 'limit' || ordType === 'stop_limit')
    ? Number($('#limitPrice').value) || t?.last
    : t?.last;
  const el = $('#preSummary');
  const snap = accountSnapshot(state.account, displayMarks(), fees());
  const reduce = $('#reduceOnly')?.checked;
  const pos = state.account.positions[sym];
  const meta = t ? symbolMeta(sym) : null;
  let coinQty = rawQty;
  if (state.ui.qtyUnit === 'usdt' && px > 0 && meta) {
    coinQty = Math.floor((rawQty / px) / meta.lot) * meta.lot;
  }
  let canSubmit = coinQty > 0 && !!t && !!px && !challengeBlocksTrading();
  if ((ordType === 'stop_market' || ordType === 'stop_limit')
    && !(Number($('#triggerPrice').value) > 0)) canSubmit = false;
  if (ordType === 'stop_limit' && !(Number($('#limitPrice').value) > 0)) canSubmit = false;
  if (ordType === 'stop_trail' && !(Number($('#trailPct')?.value) > 0)) canSubmit = false;
  if (!t || !(rawQty > 0) || !px) {
    el.textContent = challengeBlocksTrading()
      ? '排位賽已結束，請到「段位」頁結算'
      : '輸入數量以預覽保證金／強平';
    canSubmit = false;
  } else {
    const maxQty = Math.floor(((snap.available * lev) / px) / meta.lot) * meta.lot;
    const maxUsdt = maxQty * px;
    const notional = state.ui.qtyUnit === 'usdt' ? rawQty : coinQty * px;
    const im = notional / lev;
    const fee = notional * fees().taker;
    const longLiq = liqPrice({ side: 'long', entry: px, leverage: lev, mmr: meta.mmr, feeRate: fees().taker });
    const shortLiq = liqPrice({ side: 'short', entry: px, leverage: lev, mmr: meta.mmr, feeRate: fees().taker });
    const mark = t.markApprox ? t.last : t.mark;
    const maxLab = state.ui.qtyUnit === 'usdt'
      ? `可開約 $${maxUsdt.toFixed(2)}`
      : `可開多／空約 ${maxQty > 0 ? maxQty : 0}`;
    el.innerHTML = `可用 ${snap.available.toFixed(2)} USDT · ${maxLab}<br>
    訂單價值 $${notional.toFixed(2)} · 幣數量 ${coinQty || 0} · 保證金 $${im.toFixed(2)} · 手續費 $${fee.toFixed(4)}<br>
    預估強平 多 ${longLiq.toFixed(2)} (${((mark - longLiq) / mark * 100).toFixed(2)}%) ·
    空 ${shortLiq.toFixed(2)} (${((shortLiq - mark) / mark * 100).toFixed(2)}%)`
      + (reduce ? '<br><span class="down">只減倉：必須反向平倉</span>' : '');
    if (!reduce && snap.available < im + fee) canSubmit = false;
    if (reduce) {
      if (!pos) canSubmit = false;
      else if (coinQty > pos.qty + 1e-12) canSubmit = false;
    }
  }
  const longBtn = $('#btnLong');
  const shortBtn = $('#btnShort');
  if (longBtn) {
    longBtn.disabled = !canSubmit || (reduce && pos && pos.side === 'long');
    longBtn.textContent = reduce ? '平空／減倉' : '做多';
  }
  if (shortBtn) {
    shortBtn.disabled = !canSubmit || (reduce && pos && pos.side === 'short');
    shortBtn.textContent = reduce ? '平多／減倉' : '做空';
  }
}

function warnLiqProximity() {
  const snap = accountSnapshot(state.account, displayMarks(), fees());
  const now = Date.now();
  if (now - lastLiqWarnAt < 15000) return;
  for (const p of snap.positions) {
    if (marks[p.symbol] == null) continue; // degraded: no false alarm
    if (p.distToLiq < 0.03) {
      lastLiqWarnAt = now;
      toast(`危急：${p.symbol} 距離強平 ${(p.distToLiq * 100).toFixed(2)}%`);
      break;
    }
    if (p.distToLiq < 0.08) {
      lastLiqWarnAt = now;
      toast(`警告：${p.symbol} 距離強平 ${(p.distToLiq * 100).toFixed(2)}%`);
      break;
    }
  }
}

function setQtyFromPct(pct) {
  const t = activeTicker();
  if (!t) return;
  const lev = levEffective();
  const snap = accountSnapshot(state.account, displayMarks(), fees());
  const px = t.last;
  const meta = symbolMeta(activeSymbol());
  const usable = Math.max(0, snap.available) * (pct / 100) * 0.98;
  // IM = qty*px/lev → qty = usable * lev / px
  let qty = (usable * lev) / px;
  qty = Math.floor(qty / meta.lot) * meta.lot;
  if (pct === 100 && qty * px / lev > snap.available) {
    qty = Math.floor((snap.available * lev / px) / meta.lot) * meta.lot;
  }
  if (state.ui.qtyUnit === 'usdt') {
    const notion = qty * px;
    $('#qty').value = notion > 0 ? String(Number(notion.toFixed(2))) : '';
  } else {
    $('#qty').value = qty > 0 ? String(Number(qty.toFixed(8))) : '';
  }
  if (pct === 100) toast('使用 100% 保證金風險極高');
  updatePreSummary();
}

function renderEquity() {
  const snap = accountSnapshot(state.account, displayMarks(), fees());
  const cls = snap.returnPct >= 0 ? 'up' : 'down';
  const upnl = snap.equity - snap.wallet;
  const upnlCls = upnl >= 0 ? 'up' : 'down';
  const deg = marks[market.getSymbol()] == null ? ' · 標記價降級' : '';
  $('#equityBar').innerHTML = `權益 <b class="mono">${snap.equity.toFixed(2)}</b>
    · 錢包 ${snap.wallet.toFixed(2)}
    · 可用 ${snap.available.toFixed(2)}
    · 未實現 <span class="${upnlCls}">${upnl >= 0 ? '+' : ''}${upnl.toFixed(2)}</span>
    · 收益 <span class="${cls}">${snap.returnPct >= 0 ? '+' : ''}${snap.returnPct.toFixed(2)}%</span>${deg}`;
}

function renderPosTab() {
  const body = $('#posTabBody');
  const snap = accountSnapshot(state.account, displayMarks(), fees());
  body.onclick = null;
  const closeAllBtn = $('#btnCloseAll');
  const cancelAllBtn = $('#btnCancelAll');
  if (closeAllBtn) closeAllBtn.classList.toggle('hidden', !snap.positions.length);
  if (cancelAllBtn) cancelAllBtn.classList.toggle('hidden', !snap.openOrders.length);

  if (posTab === 'positions') {
    if (!snap.positions.length) {
      body.innerHTML = '<p class="empty-hint">尚無持倉 · 使用右側下單區開倉，或手機點「下單」</p>';
      return;
    }
    body.innerHTML = `<table class="pos-table pos-table--cards"><thead><tr>
      <th>合約</th><th>方向</th><th>數量</th><th>槓桿</th><th>價值</th><th>保證金</th>
      <th>入場</th><th>標記</th><th>盈虧</th><th>報酬率</th>
      <th>止盈</th><th>停損</th><th>強平</th><th>距離強平</th><th>操作</th>
      </tr></thead><tbody>`
      + snap.positions.map((p) => {
        const engMark = marks[p.symbol];
        const degraded = engMark == null;
        const band = degraded ? '' : (p.distToLiq < 0.03 ? 'crit' : p.distToLiq < 0.08 ? 'warn' : '');
        const bandTxt = degraded ? '標記降級 ' : band === 'crit' ? '危急 ' : band === 'warn' ? '警告 ' : '';
        const pnlCls = p.upnl >= 0 ? 'up' : 'down';
        const tpTxt = p.tp != null ? Number(p.tp).toFixed(2) : '—';
        const slTxt = p.sl != null ? Number(p.sl).toFixed(2) : '—';
        const markTxt = degraded
          ? `≈${(lastPrices[p.symbol] ?? p.mark)?.toFixed?.(2) ?? '—'}`
          : (p.mark?.toFixed?.(2) ?? '—');
        return `<tr class="liq-${band}" data-sym="${p.symbol}">
        <td class="pos-sym" data-label="合約">${p.symbol}</td>
        <td class="${p.side === 'long' ? 'up' : 'down'}" data-label="方向">${p.side === 'long' ? '多' : '空'}</td>
        <td data-label="數量">${p.qty}</td>
        <td data-label="槓桿">${Number(p.leverage).toFixed(0)}x</td>
        <td data-label="價值">${p.notional.toFixed(2)}</td>
        <td data-label="保證金">${p.im.toFixed(2)}</td>
        <td data-label="入場">${p.entry.toFixed(2)}</td>
        <td data-label="標記">${markTxt}</td>
        <td class="${pnlCls}" data-label="盈虧">${p.upnl >= 0 ? '+' : ''}${p.upnl.toFixed(2)}</td>
        <td class="${pnlCls}" data-label="報酬率">${p.roiPct >= 0 ? '+' : ''}${p.roiPct.toFixed(2)}%</td>
        <td class="up" data-label="止盈">${tpTxt}</td><td class="down" data-label="停損">${slTxt}</td>
        <td data-label="強平">${degraded ? '—' : p.liqPrice.toFixed(2)}</td>
        <td class="liq-dist" data-label="距離強平">${degraded ? '強平/TP/SL 暫停' : bandTxt + (p.distToLiq * 100).toFixed(2) + '%'}</td>
        <td class="pos-actions" data-label="操作">
          <button type="button" class="btn-row close" data-close="${p.symbol}" data-pct="100">平倉</button>
          <button type="button" class="btn-row close" data-close="${p.symbol}" data-pct="50">平50%</button>
          <button type="button" class="btn-row close" data-close="${p.symbol}" data-pct="25">平25%</button>
          <button type="button" class="btn-row flip" data-flip="${p.symbol}">反手</button>
          <div class="pos-more">
            <button type="button" class="btn-row" data-more="${p.symbol}">⋯</button>
            <div class="pos-more-menu">
              <button type="button" class="btn-row" data-edit-tpsl="${p.symbol}">改TP/SL</button>
              <button type="button" class="btn-row" data-add-margin="${p.symbol}">調保證金</button>
              <button type="button" class="btn-row" data-adj-lev="${p.symbol}">調槓桿</button>
            </div>
          </div>
        </td></tr>`;
      }).join('') + '</tbody></table>';
    body.onclick = async (e) => {
      const moreBtn = e.target.closest('[data-more]');
      if (moreBtn) {
        e.stopPropagation();
        const wrap = moreBtn.closest('.pos-more');
        $$('.pos-more.open').forEach((x) => { if (x !== wrap) x.classList.remove('open'); });
        wrap.classList.toggle('open');
        return;
      }
      const act = e.target.closest('[data-close],[data-flip],[data-edit-tpsl],[data-add-margin],[data-adj-lev],tr[data-sym]');
      if (!act) return;
      if (act.dataset.close) {
        e.stopPropagation();
        closePosition(act.dataset.close, { pct: Number(act.dataset.pct) || 100 });
        return;
      }
      if (act.dataset.flip) {
        e.stopPropagation();
        reversePosition(act.dataset.flip);
        return;
      }
      if (act.dataset.editTpsl) {
        e.stopPropagation();
        editTpSl(act.dataset.editTpsl);
        return;
      }
      if (act.dataset.addMargin) {
        e.stopPropagation();
        addMarginPrompt(act.dataset.addMargin);
        return;
      }
      if (act.dataset.adjLev) {
        e.stopPropagation();
        adjLevPrompt(act.dataset.adjLev);
        return;
      }
      if (act.dataset.sym && !e.target.closest('button')) {
        await selectSymbol(act.dataset.sym);
      }
    };
  } else if (posTab === 'orders') {
    const rows = snap.openOrders;
    if (!rows.length) {
      body.innerHTML = '<p class="empty-hint">尚無當前委託 · 切換「限價」或「條件」後送出</p>';
      return;
    }
    body.innerHTML = `<table class="pos-table"><thead><tr>
      <th>時間</th><th>合約</th><th>類型</th><th>方向</th><th>價／觸發</th><th>量</th><th>TIF</th><th>只減倉</th><th>操作</th>
      </tr></thead><tbody>`
      + rows.map((o) => {
        const typeLab = o.ordType === 'stop_market' ? '條件市價'
          : o.ordType === 'stop_limit' ? '條件限價'
          : o.ordType === 'stop_trail' ? `追蹤 ${o.trailPct}%` : '限價';
        const px = o.ordType === 'stop_market' ? `觸發 ${o.triggerPrice}`
          : o.ordType === 'stop_limit' ? `觸發 ${o.triggerPrice} / 限 ${o.price}`
          : o.ordType === 'stop_trail' ? `觸發 ${Number(o.triggerPrice).toFixed(2)} / 回撤 ${o.trailPct}%`
          : o.price;
        const canAmend = o.ordType === 'limit' || o.ordType === 'stop_market' || o.ordType === 'stop_limit';
        return `<tr>
        <td>${new Date(o.createdAt).toLocaleTimeString()}</td>
        <td>${o.symbol}</td><td>${typeLab}</td>
        <td class="${o.side === 'long' ? 'up' : 'down'}">${o.side === 'long' ? '買入' : '賣出'}</td>
        <td>${px}</td><td>${o.qty}</td>
        <td>${o.tif || 'GTC'}</td>
        <td>${o.reduceOnly ? '是' : '—'}</td>
        <td class="pos-actions">
          ${canAmend ? `<button type="button" class="btn-row" data-amend="${o.id}">修改</button>` : ''}
          <button type="button" class="btn-row cancel" data-cancel="${o.id}">取消</button>
        </td></tr>`;
      }).join('')
      + '</tbody></table>';
    body.onclick = (e) => {
      const cancel = e.target.closest('[data-cancel]');
      if (cancel) {
        cancelOrder(state.account, cancel.dataset.cancel);
        persist();
        renderPosTab();
        toast('已取消委託');
        return;
      }
      const amend = e.target.closest('[data-amend]');
      if (amend) amendOrderPrompt(amend.dataset.amend);
    };
  } else if (posTab === 'closed') {
    const all = state.closedTrades || [];
    const syms = [...new Set(all.map((t) => t.symbol))];
    const rows = filterClosedTrades(all, {
      sym: blotterFilterSym, from: blotterFilterFrom, to: blotterFilterTo,
    }).slice().reverse().slice(0, 100);
    body.innerHTML = `<div class="blotter-filters">
      <label>合約 <select id="blSym"><option value="">全部</option>
        ${syms.map((s) => `<option value="${s}" ${blotterFilterSym === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select></label>
      <label>由 <input type="date" id="blFrom" value="${blotterFilterFrom}" /></label>
      <label>至 <input type="date" id="blTo" value="${blotterFilterTo}" /></label>
    </div>` + (rows.length
      ? `<table class="pos-table"><thead><tr>
        <th>平倉時間</th><th>合約</th><th>方向</th><th>數量</th><th>入場</th><th>出場</th>
        <th>已實現盈虧</th><th>費用</th><th>原因</th>
        </tr></thead><tbody>`
        + rows.map((t) => {
          const cls = t.pnlUsdt >= 0 ? 'up' : 'down';
          return `<tr>
          <td>${new Date(t.closedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}</td>
          <td>${t.symbol}</td>
          <td class="${t.side === 'long' ? 'up' : 'down'}">${t.side === 'long' ? '多' : '空'}</td>
          <td>${t.qty}</td><td>${Number(t.entry).toFixed(2)}</td><td>${Number(t.exit).toFixed(2)}</td>
          <td class="${cls}">${t.pnlUsdt >= 0 ? '+' : ''}${Number(t.pnlUsdt).toFixed(4)}</td>
          <td>${Number(t.feeUsdt || 0).toFixed(4)}</td>
          <td>${FILL_TYPE[t.reason] || t.reason || '平倉'}</td></tr>`;
        }).join('') + '</tbody></table>'
      : '<p class="empty-hint">尚無已平倉紀錄 · 平倉後會顯示於此</p>');
    body.querySelector('#blSym')?.addEventListener('change', (e) => {
      blotterFilterSym = e.target.value; renderPosTab();
    });
    body.querySelector('#blFrom')?.addEventListener('change', (e) => {
      blotterFilterFrom = e.target.value; renderPosTab();
    });
    body.querySelector('#blTo')?.addEventListener('change', (e) => {
      blotterFilterTo = e.target.value; renderPosTab();
    });
  } else {
    const allFills = state.account?.fills || [];
    const syms = [...new Set(allFills.map((f) => f.symbol).filter(Boolean))];
    const fills = allFills.filter((f) => {
      if (blotterFilterSym && f.symbol !== blotterFilterSym) return false;
      const k = dayKey(f.ts);
      if (blotterFilterFrom && k < blotterFilterFrom) return false;
      if (blotterFilterTo && k > blotterFilterTo) return false;
      return true;
    }).slice().reverse().slice(0, 100);
    body.innerHTML = `<div class="blotter-filters">
      <label>合約 <select id="blSym"><option value="">全部</option>
        ${syms.map((s) => `<option value="${s}" ${blotterFilterSym === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select></label>
      <label>由 <input type="date" id="blFrom" value="${blotterFilterFrom}" /></label>
      <label>至 <input type="date" id="blTo" value="${blotterFilterTo}" /></label>
    </div>` + (fills.length
      ? `<table class="pos-table"><thead><tr>
        <th>時間</th><th>合約</th><th>方向</th><th>類型</th><th>價格</th><th>數量</th><th>費用</th>
        </tr></thead><tbody>`
        + fills.map((f) => {
          const tag = FILL_TYPE[f.reason] || FILL_TYPE[f.liquidity] || f.liquidity || '—';
          const side = FILL_SIDE[f.side] || f.side;
          return `<tr><td>${new Date(f.ts).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}</td><td>${f.symbol}</td>
          <td>${side}</td><td>${tag}</td><td>${f.price}</td><td>${f.qty}</td>
          <td>${Number(f.feeUsdt || 0).toFixed(4)}</td></tr>`;
        }).join('')
        + '</tbody></table>'
      : '<p class="empty-hint">尚無成交紀錄 · 成交後會顯示於此</p>');
    body.querySelector('#blSym')?.addEventListener('change', (e) => {
      blotterFilterSym = e.target.value; renderPosTab();
    });
    body.querySelector('#blFrom')?.addEventListener('change', (e) => {
      blotterFilterFrom = e.target.value; renderPosTab();
    });
    body.querySelector('#blTo')?.addEventListener('change', (e) => {
      blotterFilterTo = e.target.value; renderPosTab();
    });
  }
}

async function editTpSl(sym) {
  const pos = state.account.positions[sym];
  if (!pos) return;
  const vals = await formSheet({
    title: `改 TP／SL · ${sym}`,
    fields: [
      { id: 'tp', label: '止盈價（留空清除）', value: pos.tp ?? '' },
      { id: 'sl', label: '停損價（留空清除）', value: pos.sl ?? '' },
    ],
  });
  if (!vals) return;
  const tp = vals.tp.trim() === '' ? null : Number(vals.tp);
  const sl = vals.sl.trim() === '' ? null : Number(vals.sl);
  if (tp != null && !(tp > 0)) return toast('止盈價無效');
  if (sl != null && !(sl > 0)) return toast('停損價無效');
  if (pos.side === 'long') {
    if (sl != null && !(sl < pos.entry)) return toast('多倉停損須低於入場價');
    if (tp != null && !(tp > pos.entry)) return toast('多倉止盈須高於入場價');
  } else {
    if (sl != null && !(sl > pos.entry)) return toast('空倉停損須高於入場價');
    if (tp != null && !(tp < pos.entry)) return toast('空倉止盈須低於入場價');
  }
  updatePositionBrackets(state.account, sym, { tp, sl });
  persist();
  renderPosTab();
  toast(`已更新 ${sym} 止盈／停損`);
}

async function addMarginPrompt(sym) {
  const pos = state.account.positions[sym];
  if (!pos) return;
  const cur = Number(pos.extraMarginUsdt) || 0;
  const vals = await formSheet({
    title: `調保證金 · ${sym}`,
    fields: [{
      id: 'amt',
      label: `變動 USDT（正數追加／負數減少；目前額外 ${cur.toFixed(2)}）`,
      value: '100',
      type: 'number',
    }],
  });
  if (!vals) return;
  const amt = Number(vals.amt);
  if (!Number.isFinite(amt) || amt === 0) return toast('金額無效');
  const r = adjustIsolatedMargin(state.account, sym, amt, displayMarks());
  if (!r.ok) return toast('調保證金失敗：' + r.reason);
  persist();
  renderEquity();
  renderPosTab();
  toast(amt > 0 ? `已追加 ${amt} USDT` : `已減少 ${-amt} USDT`);
}

async function adjLevPrompt(sym) {
  const pos = state.account.positions[sym];
  if (!pos) return;
  const vals = await formSheet({
    title: `調槓桿 · ${sym}`,
    fields: [{ id: 'lev', label: `槓桿（目前 ${pos.leverage}x，最高 50x）`, value: String(pos.leverage), type: 'number' }],
  });
  if (!vals) return;
  const lev = Number(vals.lev);
  if (!(lev >= 1 && lev <= 50)) return toast('槓桿無效');
  const r = setPositionLeverage(state.account, sym, lev);
  if (!r.ok) return toast('調整失敗：' + r.reason);
  if (!state.ui.levBySymbol) state.ui.levBySymbol = {};
  state.ui.levBySymbol[sym] = lev;
  persist();
  renderPosTab();
  toast(`已調槓桿至 ${lev}x`);
}

async function amendOrderPrompt(orderId) {
  const o = state.account.orders.find((x) => x.id === orderId && x.status === 'open');
  if (!o) return;
  const fields = [];
  if (o.ordType === 'stop_market' || o.ordType === 'stop_limit') {
    fields.push({ id: 'triggerPrice', label: '觸發價', value: o.triggerPrice, type: 'number' });
  }
  if (o.ordType === 'limit' || o.ordType === 'stop_limit') {
    fields.push({ id: 'price', label: '限價', value: o.price, type: 'number' });
  }
  fields.push({ id: 'qty', label: '數量', value: o.qty, type: 'number' });
  const vals = await formSheet({ title: '修改委託', fields });
  if (!vals) return;
  const patch = {};
  if (vals.triggerPrice != null) {
    const trig = Number(vals.triggerPrice);
    if (!(trig > 0)) return toast('觸發價無效');
    patch.triggerPrice = trig;
  }
  if (vals.price != null && fields.some((f) => f.id === 'price')) {
    const price = Number(vals.price);
    if (!(price > 0)) return toast('限價無效');
    patch.price = price;
  }
  const qty = Number(vals.qty);
  if (!(qty > 0)) return toast('數量無效');
  patch.qty = qty;
  const r = amendOrder(state.account, orderId, patch);
  if (!r.ok) return toast('修改失敗：' + r.reason);
  maybeFillLimits(state.account, {
    lastBySymbol: { ...lastPrices },
    marks: { ...displayMarks() },
  }, fees());
  persist();
  renderPosTab();
  toast('已修改委託');
}

async function confirmHighLev(lev) {
  if (lev >= 25) {
    return window.confirm(`槓桿 ${lev}x 極高風險，距離強平會非常近。確定繼續？`);
  }
  if (lev >= 10) {
    toast(`注意：槓桿 ${lev}x 風險偏高`);
  }
  return true;
}

async function submitOrder(side) {
  const t = activeTicker();
  const book = activeBook();
  const sym = activeSymbol();
  if (!t) return toast('行情尚未就緒');
  if (challengeBlocksTrading()) return toast('排位賽已結束，請到「段位」頁查看結算');
  let qty = Number($('#qty').value);
  if (!(qty > 0)) return toast('請輸入數量');
  const lev = levEffective();
  if (!(await confirmHighLev(lev))) return;
  const mark = t.markApprox ? null : t.mark;
  const closes = hourlyCloses[sym] || [];
  const ma20 = ma(closes, 20);
  const entryPx = (ordType === 'limit' || ordType === 'stop_limit')
    ? Number($('#limitPrice').value) : t.last;
  // USDT notional → coin qty
  if (state.ui.qtyUnit === 'usdt') {
    const px = entryPx || t.last;
    if (!(px > 0)) return toast('無法換算數量');
    const meta = symbolMeta(sym);
    qty = Math.floor((qty / px) / meta.lot) * meta.lot;
    if (!(qty > 0)) return toast('換算後數量過小');
  }
  const vs = entryVsMaSign(entryPx, ma20);
  const reduceOnly = !!$('#reduceOnly')?.checked;
  const tp = $('#useTp').checked ? Number($('#tp').value) : null;
  const sl = $('#useSl').checked ? Number($('#sl').value) : null;
  if (!reduceOnly && !$('#useSl').checked && state.settings.beginnerCap) {
    toast('建議設定停損（新手模式）');
  }
  if (tp != null || sl != null) {
    const ref = entryPx || t.last;
    if (side === 'long') {
      if (sl != null && !(sl < ref)) return toast('多單停損須低於入場價');
      if (tp != null && !(tp > ref)) return toast('多單止盈須高於入場價');
    } else {
      if (sl != null && !(sl > ref)) return toast('空單停損須高於入場價');
      if (tp != null && !(tp < ref)) return toast('空單止盈須低於入場價');
    }
  }

  const input = {
    symbol: sym,
    side,
    ordType,
    qty,
    price: (ordType === 'limit' || ordType === 'stop_limit')
      ? Number($('#limitPrice').value) : undefined,
    triggerPrice: (ordType === 'stop_market' || ordType === 'stop_limit')
      ? Number($('#triggerPrice').value) : undefined,
    trailPct: ordType === 'stop_trail' ? Number($('#trailPct')?.value) : undefined,
    tif: ordType === 'limit' ? ($('#tif')?.value || 'GTC') : 'GTC',
    leverage: lev,
    reduceOnly,
    tp,
    sl,
  };
  const ctx = {
    book,
    marks: { ...displayMarks(), [sym]: mark ?? t.last },
    fees: fees(),
  };
  lastPrices[sym] = t.last;
  marks[sym] = mark ?? t.last;
  const r = placeOrder(state.account, input, ctx);
  if (!r.ok) return toast('下單失敗：' + r.reason);
  const pos = state.account.positions[sym];
  if (pos && vs != null) pos.entryVsMa = vs;
  if (input.sl != null && pos) {
    pos.slDistancePct = Math.abs(pos.entry - input.sl) / pos.entry / pos.leverage * 100;
  }
  harvestCloses();
  sampleEquity();
  persist();
  renderEquity();
  renderPosTab();
  renderReplayBar();
  const px = r.fillPrice ?? entryPx ?? input.triggerPrice;
  const fee = r.feeUsdt ?? 0;
  const sideLab = side === 'long' ? '做多' : '做空';
  toast(ordType === 'stop_trail'
    ? `已掛追蹤止損 ${sideLab} 回撤 ${input.trailPct}%`
    : (ordType === 'stop_market' || ordType === 'stop_limit')
      ? `已掛條件單 ${sideLab} 觸發 ${input.triggerPrice}`
      : `${sideLab} ${qty} @ ${Number(px).toFixed(2)} · 手續費 ${Number(fee).toFixed(4)}`);
  closeDrawer();
}

async function closePosition(sym = market.getSymbol(), opts = {}) {
  const pos = state.account.positions[sym];
  if (!pos) {
    if (!opts.silent) toast('目前沒有倉位');
    return false;
  }
  if (challengeBlocksTrading()) maybeAutoSettleChallenge();
  const mark = markFor(sym);
  if (!(mark > 0)) {
    if (!opts.silent) toast('尚無該合約標記價，無法平倉');
    return false;
  }
  const book = bookFor(sym);
  if (!book) {
    if (!opts.silent) toast('尚無該合約盤口，無法平倉');
    return false;
  }
  const pct = opts.pct != null ? opts.pct : 100;
  const qtyRaw = opts.qty != null ? opts.qty : pos.qty * (pct / 100);
  const meta = symbolMeta(sym);
  const closeQty = Math.floor(qtyRaw / meta.lot) * meta.lot;
  if (!(closeQty > 0)) {
    if (!opts.silent) toast('平倉數量過小');
    return false;
  }
  if (!opts.silent && !opts.skipConfirm) {
    const est = ((mark - pos.entry) * (pos.side === 'long' ? 1 : -1) * closeQty);
    const ok = await confirmTradeAction({
      title: '確認市價平倉',
      body: `${sym} ${pos.side === 'long' ? '多' : '空'} ${closeQty}（${pct}%）· 預估盈虧 ${est.toFixed(2)} USDT`,
      confirmLabel: '確認平倉',
      danger: true,
    });
    if (!ok) return false;
  }
  const r = placeOrder(state.account, {
    symbol: sym,
    side: pos.side === 'long' ? 'short' : 'long',
    ordType: 'market',
    qty: closeQty,
    leverage: pos.leverage,
    reduceOnly: true,
  }, {
    book,
    marks: { ...displayMarks(), [sym]: mark },
    fees: fees(),
  });
  if (!r.ok) {
    if (!opts.silent) toast('平倉失敗：' + r.reason);
    return false;
  }
  harvestCloses();
  sampleEquity();
  persist();
  renderEquity();
  renderPosTab();
  if (!opts.silent) toast(`已市價平倉 ${sym} ${pct}%`);
  return true;
}

async function reversePosition(sym = market.getSymbol()) {
  const pos = state.account.positions[sym];
  if (!pos) return toast('目前沒有倉位');
  if (challengeBlocksTrading()) maybeAutoSettleChallenge();
  const qty = pos.qty;
  const lev = pos.leverage;
  const openSide = pos.side === 'long' ? 'short' : 'long';
  const ok = await confirmTradeAction({
    title: '確認反手',
    body: `將平倉 ${sym} ${pos.side === 'long' ? '多' : '空'} ${qty}，並以相同數量開 ${openSide === 'long' ? '多' : '空'}（槓桿 ${lev}x）`,
    confirmLabel: '確認反手',
    danger: true,
  });
  if (!ok) return;
  if (!(await closePosition(sym, { silent: true, skipConfirm: true, pct: 100 }))) {
    return toast('反手失敗：無法平倉');
  }
  const mark = markFor(sym);
  const book = bookFor(sym);
  if (!(mark > 0) || !book) return toast('反手開倉失敗：無行情');
  const r = placeOrder(state.account, {
    symbol: sym,
    side: openSide,
    ordType: 'market',
    qty,
    leverage: lev,
    reduceOnly: false,
  }, {
    book,
    marks: { ...displayMarks(), [sym]: mark },
    fees: fees(),
  });
  if (!r.ok) {
    harvestCloses();
    sampleEquity();
    persist();
    renderEquity();
    renderPosTab();
    return toast('已平倉，但反手開倉失敗：' + r.reason);
  }
  harvestCloses();
  sampleEquity();
  persist();
  renderEquity();
  renderPosTab();
  toast(`已反手 ${sym} → ${openSide === 'long' ? '多' : '空'}`);
}

async function closeAllPositions() {
  const syms = Object.keys(state.account.positions || {});
  if (!syms.length) return toast('目前沒有倉位');
  const ok = await confirmTradeAction({
    title: '確認全部平倉',
    body: `將以市價平倉全部 ${syms.length} 個倉位`,
    confirmLabel: '全部平倉',
    danger: true,
  });
  if (!ok) return;
  for (const sym of [...syms]) {
    await closePosition(sym, { silent: true, skipConfirm: true, pct: 100 });
  }
  toast('已全部平倉');
}

function equityCurveSvg(samples, rangeKey = '30') {
  const series = pickEquitySeries(samples, rangeKey);
  if (!series.length) {
    return '<p class="empty-hint">交易後會顯示權益曲線</p>';
  }
  const vals = series.map((s) => s.equity);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const w = 640; const h = 180; const padL = 48; const padR = 12; const padT = 12; const padB = 28;
  const span = Math.max(1e-9, max - min);
  const t0 = series[0].t;
  const t1 = series[series.length - 1].t;
  const tSpan = Math.max(1, t1 - t0);
  const pts = series.map((s) => {
    const x = padL + ((s.t - t0) / tSpan) * (w - padL - padR);
    const y = padT + (1 - (s.equity - min) / span) * (h - padT - padB);
    return `${x},${y}`;
  }).join(' ');
  const up = vals[vals.length - 1] >= vals[0];
  const yMax = max.toFixed(0);
  const yMin = min.toFixed(0);
  const d0 = dayKey(t0);
  const d1 = dayKey(t1);
  const last = series[series.length - 1];
  return `<div class="equity-chart-wrap" id="eqChartWrap"
      data-series="${encodeURIComponent(JSON.stringify(series.map((s) => ({ t: s.t, equity: s.equity }))))}"
      data-pad-l="${padL}" data-pad-r="${padR}" data-w="${w}">
    <div class="equity-tip mono" id="eqTip">${dayKey(last.t)} · ${Number(last.equity).toFixed(2)} USDT</div>
    <svg width="100%" viewBox="0 0 ${w} ${h}" class="equity-svg" id="eqSvg" role="img"
      aria-label="權益曲線 ${d0} 至 ${d1}，${yMin} 至 ${yMax} USDT">
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${h - padB}" stroke="#1E2833"/>
      <line x1="${padL}" y1="${h - padB}" x2="${w - padR}" y2="${h - padB}" stroke="#1E2833"/>
      <text x="4" y="${padT + 4}" fill="#8B9AAB" font-size="10">${yMax}</text>
      <text x="4" y="${h - padB}" fill="#8B9AAB" font-size="10">${yMin}</text>
      <text x="${padL}" y="${h - 8}" fill="#8B9AAB" font-size="10">${d0}</text>
      <text x="${w - padR}" y="${h - 8}" fill="#8B9AAB" font-size="10" text-anchor="end">${d1}</text>
      <polyline fill="none" stroke="${up ? '#0ECB81' : '#F6465D'}" stroke-width="2" points="${pts}"/>
      <line id="eqCross" x1="0" y1="${padT}" x2="0" y2="${h - padB}" stroke="#8B9AAB" stroke-width="1"
        stroke-dasharray="3 3" opacity="0"/>
      <circle id="eqDot" cx="0" cy="0" r="4" fill="${up ? '#0ECB81' : '#F6465D'}" opacity="0"/>
    </svg></div>`;
}

// Bind pointer/touch tip for equity curve (exchange-style crosshair).
function bindEquityChartTip() {
  const wrap = $('#eqChartWrap');
  const tip = $('#eqTip');
  const svg = $('#eqSvg');
  if (!wrap || !tip || !svg) return;
  let series;
  try { series = JSON.parse(decodeURIComponent(wrap.dataset.series || '')); } catch (_) { return; }
  if (!series?.length) return;
  const padL = Number(wrap.dataset.padL) || 48;
  const padR = Number(wrap.dataset.padR) || 12;
  const vbW = Number(wrap.dataset.w) || 640;
  const t0 = series[0].t;
  const t1 = series[series.length - 1].t;
  const tSpan = Math.max(1, t1 - t0);
  const vals = series.map((s) => s.equity);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = Math.max(1e-9, max - min);
  const padT = 12; const padB = 28; const h = 180;
  const showAt = (clientX) => {
    const rect = svg.getBoundingClientRect();
    const xSvg = ((clientX - rect.left) / Math.max(1, rect.width)) * vbW;
    const clamped = Math.min(vbW - padR, Math.max(padL, xSvg));
    const t = t0 + ((clamped - padL) / (vbW - padL - padR)) * tSpan;
    let best = series[0]; let bestD = Math.abs(best.t - t);
    for (const s of series) {
      const d = Math.abs(s.t - t);
      if (d < bestD) { best = s; bestD = d; }
    }
    const x = padL + ((best.t - t0) / tSpan) * (vbW - padL - padR);
    const y = padT + (1 - (best.equity - min) / span) * (h - padT - padB);
    const cross = $('#eqCross');
    const dot = $('#eqDot');
    if (cross) { cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('opacity', '1'); }
    if (dot) { dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('opacity', '1'); }
    tip.textContent = `${dayKey(best.t)} · ${Number(best.equity).toFixed(2)} USDT`;
  };
  const onMove = (e) => {
    const x = e.touches ? e.touches[0].clientX : e.clientX;
    if (x != null) showAt(x);
  };
  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('touchmove', onMove, { passive: true });
  svg.addEventListener('click', onMove);
}

function openDayPnlSheet(day, row) {
  if (!row) return;
  const trades = row.trades || [];
  const el = document.createElement('div');
  el.className = 'confirm-sheet day-pnl-sheet';
  const tradeRows = trades.length
    ? `<table class="pos-table day-sheet-table"><thead><tr>
        <th>時間</th><th>合約</th><th>方向</th><th>數量</th><th>已實現</th>
      </tr></thead><tbody>${trades.map((t) => `<tr>
        <td>${new Date(t.closedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit' })}</td>
        <td>${t.symbol || '—'}</td>
        <td class="${t.side === 'long' ? 'up' : 'down'}">${t.side === 'long' ? '多' : '空'}</td>
        <td>${t.qty ?? '—'}</td>
        <td class="${(t.pnlUsdt || 0) >= 0 ? 'up' : 'down'}">${fmtPnl(t.pnlUsdt)}</td>
      </tr>`).join('')}</tbody></table>`
    : '<p class="empty-hint">當日無平倉成交</p>';
  el.innerHTML = `<div class="card" role="dialog" aria-modal="true" aria-label="${day} 盈虧明細">
    <h3>${day} 盈虧明細</h3>
    <div class="day-sheet-sum mono">
      <div>當日盈虧 <span class="${row.pnl >= 0 ? 'up' : 'down'}">${fmtPnl(row.pnl)}</span></div>
      <div>已實現 ${fmtPnl(row.realized)} · 資金費 ${fmtPnl(row.funding)}</div>
      <div>開倉費 ${Number(row.openFees).toFixed(2)} · 平倉費 ${Number(row.closeFees).toFixed(2)}</div>
      <div>補倉 ${Number(row.transfer).toFixed(2)} · 開盤 ${Number(row.equityOpen).toFixed(2)} → 收盤 ${Number(row.equityClose).toFixed(2)}</div>
    </div>
    ${tradeRows}
    <div class="side-actions" style="margin-top:12px">
      <button type="button" class="btn accent" data-a="ok" style="width:100%">關閉</button>
    </div></div>`;
  document.body.appendChild(el);
  el.onclick = (e) => {
    if (e.target === el || e.target.closest('[data-a="ok"]')) el.remove();
  };
}

function monthStart(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function taipeiFirstWeekday(y, m) {
  // m is 1-based; find UTC instant whose Taipei date is y-m-01, then weekday in Taipei.
  let probe = Date.UTC(y, m - 1, 1, 0, 0, 0);
  const want = `${y}-${String(m).padStart(2, '0')}-01`;
  for (let i = 0; i < 36; i++) {
    if (dayKey(probe) === want) break;
    probe += 3600000;
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', weekday: 'short',
  }).formatToParts(new Date(probe));
  const wd = parts.find((p) => p.type === 'weekday')?.value;
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd] ?? 0;
}

function fmtPnl(n) {
  const v = Number(n) || 0;
  return (v >= 0 ? '+' : '') + v.toFixed(2);
}

function renderPortfolio() {
  const el = $('#view-portfolio');
  const snap = accountSnapshot(state.account, displayMarks(), fees());
  const trades = closedTrades();
  const fills = state.account?.fills || [];
  const topups = (state.account?.events || []).filter((e) => e.type === 'topup');
  const ledger = buildDailyLedger({
    trades,
    fills,
    topups,
    equitySamples: state.equitySamples,
    startEquity: state.settings.startBalance,
  });
  // Live-update today: open = prior calendar day close (or startBalance); close = live equity.
  const todayKey = dayKey(Date.now());
  const ymd = taipeiYMD();
  const yest = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d - 1, 12, 0, 0));
  const yestKey = dayKey(yest.getTime());
  let prevClose = state.settings.startBalance;
  if (ledger.has(yestKey) && ledger.get(yestKey).equityClose != null) {
    prevClose = ledger.get(yestKey).equityClose;
  } else {
    const earlier = [...ledger.keys()].sort().reverse().find((k) => k < todayKey);
    if (earlier != null && ledger.get(earlier).equityClose != null) {
      prevClose = ledger.get(earlier).equityClose;
    }
  }
  let todayRow = ledger.get(todayKey);
  if (!todayRow) {
    todayRow = {
      key: todayKey, realized: 0, funding: 0, openFees: 0, closeFees: 0,
      transfer: 0, trades: [], equityOpen: prevClose, equityClose: snap.equity, pnl: 0,
    };
    ledger.set(todayKey, todayRow);
  }
  todayRow.equityOpen = prevClose;
  todayRow.equityClose = snap.equity;
  todayRow.pnl = todayRow.equityClose - todayRow.equityOpen - (todayRow.transfer || 0);
  const stats = periodPnLStats(ledger);
  const costs = aggregateCosts(fills);
  const dd = maxDrawdownPct(state.equitySamples || []);
  const sh = sharpeLike(state.equitySamples || []);
  const wins = trades.filter((t) => t.pnlUsdt >= 0).length;
  const wr = trades.length ? (wins / trades.length * 100) : 0;
  const upnl = snap.equity - snap.wallet;
  const marginUsed = Number(snap.usedMargin) || 0;
  if (!portfolioMonth) {
    const t = taipeiYMD();
    portfolioMonth = { y: t.y, m: t.m };
  }
  const y = portfolioMonth.y;
  const m = portfolioMonth.m;
  const firstDow = taipeiFirstWeekday(y, m);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthLabel = `${y}年${m}月`;
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push('<div class="pnl-day empty"></div>');
  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const row = ledger.get(key);
    const pnl = row?.pnl ?? 0;
    const has = !!row;
    const cls = !has ? '' : pnl > 0 ? 'up' : pnl < 0 ? 'down' : 'flat';
    const sel = portfolioDay === key ? ' selected' : '';
    const amt = has ? fmtPnl(pnl) : '—';
    cells.push(`<button type="button" class="pnl-day ${cls}${sel}" data-day="${key}"
      aria-label="${m}月${day}日 盈虧 ${amt} USDT">
      <span class="pnl-date">${day}</span>
      <span class="pnl-amt">${amt}</span>
    </button>`);
  }

  // Drop stale day filter if that day has no ledger row (e.g. empty cell / month change).
  if (portfolioDay && !ledger.has(portfolioDay)) portfolioDay = null;
  const symSet = [...new Set(trades.map((t) => t.symbol))];
  const filtered = filterClosedTrades(trades, {
    sym: portfolioFilterSym,
    day: portfolioDay || '',
    from: portfolioFilterFrom,
    to: portfolioFilterTo,
  }).slice().reverse();

  const posRows = snap.positions;
  const totalNotional = posRows.reduce((s, p) => s + (p.notional || 0), 0) || 1;
  const alloc = posRows.map((p) => {
    const pct = (p.notional / totalNotional) * 100;
    return `<div class="alloc-row">
      <span>${p.symbol} ${p.side === 'long' ? '多' : '空'}</span>
      <span class="alloc-bar"><i style="width:${pct.toFixed(1)}%"></i></span>
      <span>${p.notional.toFixed(2)}（${pct.toFixed(1)}%）</span>
    </div>`;
  }).join('') || '<p class="empty-hint">目前無持倉</p>';

  const rangeSeg = ['7', '30', '90', 'all'].map((k) => {
    const lab = k === 'all' ? '全部' : k + '日';
    return `<button type="button" data-range="${k}" class="${portfolioRange === k ? 'active' : ''}">${lab}</button>`;
  }).join('');

  el.innerHTML = `<div class="page-head"><h1>資產</h1>
    <p>權益總覽、每日盈虧日曆與詳細曲線（此頁不下單）。</p></div>

    <div class="asset-overview-grid">
      <div class="asset-card"><span>總權益</span><b class="mono">${snap.equity.toFixed(2)}</b></div>
      <div class="asset-card"><span>錢包餘額</span><b class="mono">${snap.wallet.toFixed(2)}</b></div>
      <div class="asset-card"><span>可用</span><b class="mono">${snap.available.toFixed(2)}</b></div>
      <div class="asset-card"><span>保證金占用</span><b class="mono">${marginUsed.toFixed(2)}</b></div>
      <div class="asset-card"><span>未實現盈虧</span>
        <b class="mono ${upnl >= 0 ? 'up' : 'down'}">${fmtPnl(upnl)}</b></div>
    </div>

    <div class="pnl-hero panel-block">
      <div>
        <div class="muted">今日盈虧（含未實現變動／已扣除補倉）</div>
        <div class="pnl-hero-val ${stats.today >= 0 ? 'up' : 'down'}">${fmtPnl(stats.today)} USDT</div>
      </div>
      <div class="pnl-period mono">
        <div>7日 <span class="${stats.d7 >= 0 ? 'up' : 'down'}">${fmtPnl(stats.d7)}</span></div>
        <div>30日 <span class="${stats.d30 >= 0 ? 'up' : 'down'}">${fmtPnl(stats.d30)}</span></div>
        <div>累計 <span class="${stats.cumulative >= 0 ? 'up' : 'down'}">${fmtPnl(stats.cumulative)}</span></div>
        <div>累計收益 ${snap.returnPct.toFixed(2)}%</div>
      </div>
    </div>

    <div class="panel-block">
      <div class="panel-head">
        <h3>每日盈虧日曆</h3>
        <div class="month-nav">
          <button type="button" id="calPrev" aria-label="上月">‹</button>
          <span class="mono">${monthLabel}</span>
          <button type="button" id="calNext" aria-label="下月">›</button>
        </div>
      </div>
      <div class="pnl-cal-dow"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div>
      <div class="pnl-calendar">${cells.join('')}</div>
      <p class="muted" style="font-size:11px;margin:8px 0 0">點選日期開啟當日明細（成交列）。日界線：Asia/Taipei。</p>
    </div>

    <div class="panel-block">
      <div class="panel-head">
        <h3>權益曲線</h3>
        <div class="seg mini-seg" id="eqRangeSeg">${rangeSeg}</div>
      </div>
      ${equityCurveSvg(state.equitySamples, portfolioRange)}
    </div>

    <div class="asset-metrics">
      <div class="asset-card"><span>最大回撤</span><b>${dd.toFixed(2)}%</b></div>
      <div class="asset-card"><span>夏普近似值</span><b>${sh == null ? '—' : sh.toFixed(2)}</b></div>
      <div class="asset-card"><span>勝率</span><b>${trades.length ? wr.toFixed(1) + '%' : '—'}</b></div>
      <div class="asset-card"><span>手續費合計</span><b>${costs.fees.toFixed(2)}</b></div>
      <div class="asset-card"><span>資金費合計</span><b class="${costs.funding >= 0 ? 'up' : 'down'}">${fmtPnl(costs.funding)}</b></div>
    </div>

    <div class="panel-block">
      <h3>持倉佔比</h3>
      ${alloc}
    </div>

    <div class="panel-block">
      <div class="panel-head">
        <h3>當前持倉</h3>
        <button type="button" class="text-btn" data-go-trade>前往交易</button>
      </div>
      ${posRows.length ? `<table class="pos-table"><thead><tr>
        <th>合約</th><th>方向</th><th>數量</th><th>價值</th><th>未實現</th><th>報酬率</th>
        </tr></thead><tbody>` + posRows.map((p) => `<tr>
          <td>${p.symbol}</td>
          <td class="${p.side === 'long' ? 'up' : 'down'}">${p.side === 'long' ? '多' : '空'}</td>
          <td>${p.qty}</td><td>${p.notional.toFixed(2)}</td>
          <td class="${p.upnl >= 0 ? 'up' : 'down'}">${fmtPnl(p.upnl)}</td>
          <td class="${p.roiPct >= 0 ? 'up' : 'down'}">${fmtPnl(p.roiPct)}%</td>
        </tr>`).join('') + '</tbody></table>'
        : '<p class="empty-hint">尚無持倉 · <button type="button" class="text-btn" data-go-trade>前往交易</button></p>'}
    </div>

    <div class="panel-block">
      <div class="panel-head">
        <h3>已平倉紀錄</h3>
        <label class="filter-sym">合約
          <select id="pfSymFilter">
            <option value="">全部</option>
            ${symSet.map((s) => `<option value="${s}" ${portfolioFilterSym === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </label>
        <label class="filter-sym">由 <input type="date" id="pfFrom" value="${portfolioFilterFrom}" /></label>
        <label class="filter-sym">至 <input type="date" id="pfTo" value="${portfolioFilterTo}" /></label>
        <button type="button" class="btn ghost" id="btnExportStmt" style="width:auto">匯出日結 CSV</button>
      </div>
      ${filtered.length ? `<table class="pos-table"><thead><tr>
        <th>時間</th><th>合約</th><th>方向</th><th>數量</th><th>入場</th><th>出場</th>
        <th>已實現</th><th>費用</th>
        </tr></thead><tbody>` + filtered.slice(0, 80).map((t) => `<tr>
          <td>${new Date(t.closedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}</td>
          <td>${t.symbol}</td>
          <td class="${t.side === 'long' ? 'up' : 'down'}">${t.side === 'long' ? '多' : '空'}</td>
          <td>${t.qty}</td><td>${Number(t.entry).toFixed(2)}</td><td>${Number(t.exit).toFixed(2)}</td>
          <td class="${t.pnlUsdt >= 0 ? 'up' : 'down'}">${fmtPnl(t.pnlUsdt)}</td>
          <td>${Number(t.feeUsdt || 0).toFixed(4)}</td>
        </tr>`).join('') + '</tbody></table>'
        : '<p class="empty-hint">尚無符合條件的已平倉紀錄</p>'}
    </div>`;

  el.onclick = (e) => {
    if (e.target.closest('[data-go-trade]')) {
      showView('trade');
      return;
    }
    const dayBtn = e.target.closest('[data-day]');
    if (dayBtn) {
      const key = dayBtn.dataset.day;
      const row = ledger.get(key);
      if (!row) {
        portfolioDay = null;
        toast('當日無盈虧紀錄');
        renderPortfolio();
        return;
      }
      portfolioDay = portfolioDay === key ? null : key;
      renderPortfolio();
      openDayPnlSheet(key, row);
      return;
    }
    if (e.target.closest('#calPrev')) {
      let nm = m - 1; let ny = y;
      if (nm < 1) { nm = 12; ny -= 1; }
      portfolioMonth = { y: ny, m: nm };
      portfolioDay = null;
      renderPortfolio();
      return;
    }
    if (e.target.closest('#calNext')) {
      let nm = m + 1; let ny = y;
      if (nm > 12) { nm = 1; ny += 1; }
      portfolioMonth = { y: ny, m: nm };
      portfolioDay = null;
      renderPortfolio();
      return;
    }
    const rb = e.target.closest('#eqRangeSeg [data-range]');
    if (rb) {
      portfolioRange = rb.dataset.range;
      renderPortfolio();
      return;
    }
    if (e.target.closest('#btnExportStmt')) {
      const csv = exportDailyStatementCsv(ledger);
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'apex-daily-statement.csv';
      a.click();
      toast('已匯出日結 CSV');
    }
  };
  $('#pfSymFilter')?.addEventListener('change', (e) => {
    portfolioFilterSym = e.target.value;
    renderPortfolio();
  });
  $('#pfFrom')?.addEventListener('change', (e) => {
    portfolioFilterFrom = e.target.value;
    renderPortfolio();
  });
  $('#pfTo')?.addEventListener('change', (e) => {
    portfolioFilterTo = e.target.value;
    renderPortfolio();
  });
  bindEquityChartTip();
}

function radarSvg(dims) {
  const keys = ['trendFollow', 'meanRevert', 'riskControl', 'discipline', 'patience', 'aggression'];
  const labels = ['Trend', 'Mean', 'Risk', 'Disc', 'Pat', 'Agg'];
  const cx = 120; const cy = 120; const R = 90;
  const pts = keys.map((k, i) => {
    const ang = -Math.PI / 2 + i * Math.PI * 2 / 6;
    const raw = dims[k];
    const v = raw == null ? 0 : raw / 100;
    return [cx + Math.cos(ang) * R * v, cy + Math.sin(ang) * R * v];
  });
  const poly = pts.map((p) => p.join(',')).join(' ');
  const axes = keys.map((k, i) => {
    const ang = -Math.PI / 2 + i * Math.PI * 2 / 6;
    const x = cx + Math.cos(ang) * R;
    const y = cy + Math.sin(ang) * R;
    const lx = cx + Math.cos(ang) * (R + 16);
    const ly = cy + Math.sin(ang) * (R + 16);
    const na = dims[k] == null ? ' (N/A)' : '';
    return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#1E2833"/>
      <text x="${lx}" y="${ly}" fill="#8B9AAB" font-size="10" text-anchor="middle">${labels[i]}${na}</text>`;
  }).join('');
  return `<svg width="240" height="240" viewBox="0 0 240 240" class="radar">
    <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="#1E2833"/>
    <circle cx="${cx}" cy="${cy}" r="${R * 0.66}" fill="none" stroke="#1E2833"/>
    <circle cx="${cx}" cy="${cy}" r="${R * 0.33}" fill="none" stroke="#1E2833"/>
    ${axes}
    <polygon points="${poly}" fill="rgba(46,230,166,0.25)" stroke="#2EE6A6" stroke-width="2">
      <animate attributeName="opacity" from="0" to="1" dur="0.6s" fill="freeze"/>
    </polygon>
  </svg>`;
}

function renderAnalyze() {
  const el = $('#view-analyze');
  const trades = closedTrades();
  const dims = sixDimensions(trades);
  const score = abilityScore({
    trades, equitySamples: state.equitySamples, startEquity: state.settings.startBalance,
  });
  el.innerHTML = `<div class="page-head"><h1>風格分析</h1>
    <p>六維風格雷達與能力分（練習報告，不是獲利保證）。</p></div>
    <div class="panel-block">
      ${dims.ok ? `<div class="radar-wrap">${radarSvg(dims.dims)}</div>
        <h3 style="text-align:center">${state.settings.mildLabels ? '風格診斷' : dims.label}</h3>
        <ul class="tips">${dims.tips.map((tip) => `<li>${tip}</li>`).join('')}</ul>`
    : `<p style="color:var(--muted)">完成 10 筆已平倉交易後解鎖風格解讀。（目前 ${trades.length} 筆）</p>
       <p><button type="button" class="btn accent" data-go="trade">前往交易</button></p>`}
    </div>
    <div class="panel-block mono">
      能力分：${score.ok ? score.score.toFixed(1) + ' · ' + rankTier(score.score) : '樣本不足'}
      ${score.ok ? `<br>報酬 ${score.parts.r.toFixed(0)} · 質量 ${score.parts.q.toFixed(0)} · 回撤 ${score.parts.d.toFixed(0)} · 穩定 ${score.parts.s.toFixed(0)}` : ''}
    </div>`;
  el.onclick = (e) => {
    if (e.target.dataset.go === 'trade') showView('trade');
  };
}

function sortedBoard(board) {
  const key = rankSort;
  const copy = [...board];
  copy.sort((a, b) => {
    if (key === 'return') return (b.returnPct ?? -999) - (a.returnPct ?? -999);
    if (key === 'sharpe') return (b.parts?.S ?? -999) - (a.parts?.S ?? -999);
    if (key === 'dd') return (a.parts?.D ?? 999) - (b.parts?.D ?? 999);
    if (key === 'win') return (b.parts?.W ?? 0) - (a.parts?.W ?? 0);
    if (key === 'trades') return (b.trades ?? 0) - (a.trades ?? 0);
    return (b.score ?? 0) - (a.score ?? 0);
  });
  return copy;
}

function renderRank() {
  const el = $('#view-rank');
  maybeAutoSettleChallenge();
  const ch = state.challenge;
  const remain = ch ? challengeRemaining(ch) : 0;
  const board = sortedBoard(state.leaderboard || []);
  const expired = ch?.status === 'active' && remain <= 0;
  const ladder = state.ladder || defaultLadder();
  const shown = displayTier(ladder);
  const lpPct = tierIndexSafe(ladder) >= 5 ? 100 : Math.min(100, Math.max(0, ladder.lp));
  const hist = (ladder.history || []).slice(0, 5);

  el.innerHTML = `<div class="page-head"><h1>段位</h1>
    <p>打排位賽 → 得到能力分 → 加減積分（LP）→ 滿 100 升一小段。練習模式不影響段位。</p></div>

    <div class="panel-block rank-hero">
      <div class="rank-badge">${TIER_LABEL[shown.tier] || '青銅'}${shown.division ? ' ' + shown.division : ''}</div>
      <p class="mono">${formatRank(ladder)}</p>
      <div class="lp-bar" aria-label="積分進度"><i style="width:${lpPct}%"></i></div>
      <p style="color:var(--muted);margin:8px 0 0">${nextRankHint(ladder)}</p>
    </div>

    <div class="panel-block">
      <h3>排位賽（7 日）</h3>
      ${ch?.status === 'active'
    ? `<p class="mono">${expired ? '已結束 · 等待結算' : `剩餘約 ${Math.ceil(remain / 3600000)} 小時`} · 禁止重置／補倉</p>
       <button type="button" class="btn accent" id="btnSettle">${expired ? '結算並更新段位' : '提前結算'}</button>
       <p style="color:var(--muted);font-size:12px;margin-top:8px">開賽未滿 48 小時提前結算：只能扣分、不能加分。</p>`
    : `<p>起始 50,000 USDT · BTC／ETH／SOL · 結算後依能力分加減積分</p>
       <button type="button" class="btn accent" id="btnStartCh">開始排位賽</button>`}
    </div>

    <div class="panel-block">
      <h3>最近場次</h3>
      ${hist.length ? hist.map((h) => {
        const sign = h.lpDelta > 0 ? '+' + h.lpDelta : String(h.lpDelta);
        return `<div class="lb-row"><span>${new Date(h.at).toLocaleString()}</span>
          <span>能力分 ${h.score?.toFixed?.(1) ?? '—'} · 積分 ${sign}</span></div>`;
      }).join('') : '<p style="color:var(--muted)">尚未有排位賽結算</p>'}
    </div>

    <div class="panel-block">
      <h3>本機成績榜</h3>
      <div class="seg" id="rankSortSeg" style="margin-bottom:10px">
        <button type="button" data-sort="score" class="${rankSort === 'score' ? 'active' : ''}">能力分</button>
        <button type="button" data-sort="return" class="${rankSort === 'return' ? 'active' : ''}">收益%</button>
        <button type="button" data-sort="sharpe" class="${rankSort === 'sharpe' ? 'active' : ''}">Sharpe</button>
        <button type="button" data-sort="dd" class="${rankSort === 'dd' ? 'active' : ''}">回撤</button>
        <button type="button" data-sort="win" class="${rankSort === 'win' ? 'active' : ''}">勝率</button>
      </div>
      ${board.length
    ? `<table class="rank-table"><thead><tr><th>#</th><th>段位</th><th>能力分</th><th>收益%</th><th>積分Δ</th><th>筆數</th></tr></thead><tbody>`
      + board.map((e, i) => `<tr>
        <td>${i + 1}</td><td>${e.tier}</td><td>${e.score?.toFixed?.(1) ?? '—'}</td>
        <td>${e.returnPct?.toFixed?.(2) ?? '—'}</td>
        <td>${e.lpDelta == null ? '—' : (e.lpDelta > 0 ? '+' : '') + e.lpDelta}</td>
        <td>${e.trades ?? 0}</td></tr>`).join('')
      + '</tbody></table>'
    : '<p style="color:var(--muted)">尚未有合格排位賽成績</p>'}
      ${board[0] ? '<button type="button" class="btn ghost" id="btnScoreCard" style="margin-top:8px">匯出最新成績碼</button>' : ''}
    </div>

    <div class="panel-block" style="color:var(--muted);font-size:12px;line-height:1.55">
      <h3 style="color:var(--text)">段位一覽</h3>
      青銅 → 白銀 → 黃金 → 白金 → 鑽石（各有 IV–I）→ 大師 → 宗師（≥300 積分）→ 菁英（≥500 積分）。
      詳細規則見 RANKING.md。
    </div>`;

  $('#rankSortSeg')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sort]');
    if (!b) return;
    rankSort = b.dataset.sort;
    renderRank();
  });
  $('#btnScoreCard')?.addEventListener('click', () => {
    const blob = new Blob([exportScoreCard(board[0])], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'apex-scorecard.json';
    a.click();
  });
  $('#btnStartCh')?.addEventListener('click', () => {
    if (isReplay()) return toast('請先結束回放再開始排位賽');
    if (state.challenge?.status === 'active') return;
    state.account = createAccount(50000);
    state.closedTrades = [];
    state.equitySamples = [{ t: Date.now(), equity: 50000 }];
    state.challenge = startChallenge();
    sampleEquity();
    persist();
    toast('排位賽開始');
    showView('trade');
  });
  $('#btnSettle')?.addEventListener('click', () => {
    const force = challengeRemaining(state.challenge) > 0;
    const res = settleChallenge({
      challenge: force ? { ...state.challenge, force: true } : state.challenge,
      trades: closedTrades(),
      equitySamples: state.equitySamples,
      startEquity: state.challenge.startBalance || 50000,
      ladder: state.ladder || defaultLadder(),
    });
    if (!res.ok) return toast('結算失敗：' + res.reason);
    finalizeChallengeSettle(res);
    renderRank();
    showView('analyze');
  });
}

function tierIndexSafe(ladder) {
  const order = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'master', 'grandmaster', 'challenger'];
  return order.indexOf(ladder.tier);
}

function stopReplayTimer() {
  if (replayTimer) {
    clearInterval(replayTimer);
    replayTimer = null;
  }
  if (replaySession) replaySession.playing = false;
}

function paintReplayChart() {
  if (!candleSeries || !replaySession) return;
  const { candles, cursor } = replaySession;
  const shown = candles.slice(0, Math.max(1, cursor));
  candleSeries.setData(shown);
  try { chartApi?.timeScale().scrollToRealTime(); } catch (_) { /* ignore */ }
}

function applyReplayTickerUi() {
  const c = currentCandle(replaySession);
  if (!c) return;
  const t = synthTicker(replaySession.symbol, c);
  lastPrices[t.symbol] = t.last;
  marks[t.symbol] = t.mark;
  $('#tickerStrip').innerHTML = `<span class="up">${t.last.toFixed(2)}</span>
    · 回放標記 ${t.mark.toFixed(2)}
    · ${new Date(c.time * 1000).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`;
  renderEquity();
  renderPosTab();
  updatePreSummary();
  refreshTicketHead();
  renderReplayBar();
}

function showReplayResultCard(result) {
  const reasonMap = {
    tp: '止盈觸發', sl: '停損觸發', liquidation: '強平', end: '行情結束', cap: '步數上限',
  };
  const el = document.createElement('div');
  el.className = 'confirm-sheet';
  el.innerHTML = `<div class="card" role="dialog" aria-modal="true">
    <h3>回放結果</h3>
    <div class="replay-result-card">
      <div>${result.symbol} · ${reasonMap[result.reason] || result.reason}</div>
      <div>出場價 ${Number(result.exitPrice).toFixed(2)}</div>
      <div class="${result.pnlUsdt >= 0 ? 'up' : 'down'}">盈虧 ${fmtPnl(result.pnlUsdt)} USDT</div>
      <div>用時 ${result.durationBars} 根K線</div>
      <div>最大浮盈 ${fmtPnl(result.maxUpnl)} · 最大浮虧 ${fmtPnl(result.minUpnl)}</div>
    </div>
    <p class="muted" style="font-size:12px;margin:8px 0">回放成績只計練習報告，不進排位榜。</p>
    <div class="side-actions">
      <button type="button" class="btn ghost" data-a="stay">繼續查看</button>
      <button type="button" class="btn accent" data-a="exit">結束回放</button>
    </div></div>`;
  document.body.appendChild(el);
  el.onclick = (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    el.remove();
    if (a === 'exit') exitReplay();
  };
}

function handleReplayStepResult(r) {
  harvestCloses();
  paintReplayChart();
  applyReplayTickerUi();
  for (const ev of r.events || []) {
    if (ev.type === 'sl' || ev.type === 'tp' || ev.type === 'liquidation') {
      const label = ev.type === 'liquidation' ? '強平' : ev.type === 'sl' ? '停損觸發' : '止盈觸發';
      toast(`${label}（回放）`);
    }
  }
  if (r.done) {
    stopReplayTimer();
    const finished = replaySession.result
      || finishResult(replaySession, r.reason, r.hit, r.events).result;
    state.replayResults = [finished, ...(state.replayResults || [])].slice(0, 40);
    persistReplayResultsOnly();
    showReplayResultCard(finished);
  }
}

function startReplayTimer() {
  stopReplayTimer();
  if (!replaySession) return;
  replaySession.playing = true;
  renderReplayBar();
  replayTimer = setInterval(() => {
    if (!replaySession?.playing) return;
    const r = stepReplay(replaySession, 1);
    handleReplayStepResult(r);
  }, replayTickMs(replaySession.speed));
}

function renderReplayBar() {
  const bar = $('#replayBar');
  if (!bar) return;
  if (!isReplay()) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }
  const p = replayProgress(replaySession);
  const c = currentCandle(replaySession);
  const tLabel = c
    ? new Date(c.time * 1000).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
    : '—';
  const hasPos = !!state.account.positions[replaySession.symbol];
  bar.classList.remove('hidden');
  bar.innerHTML = `
    <span><b>回放中</b> · ${replaySession.symbol} · ${replaySession.interval}m</span>
    <span class="mono">${tLabel}</span>
    <span class="mono">${p.i + 1}/${p.n}</span>
    <label>倍速
      <select id="rpSpeed">
        ${[1, 2, 5, 10, 30, 60].map((s) =>
    `<option value="${s}" ${replaySession.speed === s ? 'selected' : ''}>${s}x</option>`).join('')}
      </select>
    </label>
    <div class="replay-actions">
      <button type="button" class="btn ghost" id="rpStep">下一步</button>
      <button type="button" class="btn accent" id="rpPlay">${replaySession.playing ? '暫停' : '播放'}</button>
      <button type="button" class="btn ghost" id="rpToResult" ${hasPos ? '' : 'disabled'} title="需先開倉並設 TP/SL">播放至結果</button>
      <button type="button" class="btn danger" id="rpExit">結束</button>
    </div>`;
  $('#rpSpeed').onchange = (e) => {
    replaySession.speed = Number(e.target.value) || 1;
    if (replaySession.playing) startReplayTimer();
  };
  $('#rpStep').onclick = () => {
    stopReplayTimer();
    handleReplayStepResult(stepReplay(replaySession, 1));
  };
  $('#rpPlay').onclick = () => {
    if (replaySession.playing) stopReplayTimer();
    else startReplayTimer();
    renderReplayBar();
  };
  $('#rpToResult').onclick = () => {
    const pos = state.account.positions[replaySession.symbol];
    if (!pos) return toast('請先開倉');
    if (pos.tp == null && pos.sl == null) {
      return toast('請先設定止盈或停損，再播放至結果');
    }
    stopReplayTimer();
    const out = playToResult(replaySession);
    harvestCloses();
    paintReplayChart();
    applyReplayTickerUi();
    state.replayResults = [out.result, ...(state.replayResults || [])].slice(0, 40);
    persistReplayResultsOnly();
    showReplayResultCard(out.result);
  };
  $('#rpExit').onclick = () => exitReplay();
}

async function enterReplay({ symbol, interval, startMs, endMs }) {
  if (isReplay()) return toast('已在回放中');
  if (state.challenge?.status === 'active' && challengeRemaining(state.challenge) > 0) {
    const ok = await confirmTradeAction({
      title: '進行中的排位賽',
      body: '進入回放不會影響排位倉位（會暫存即時帳戶）。確定繼續？',
      confirmLabel: '進入回放',
    });
    if (!ok) return;
  }
  replayLoadPct = 0;
  toast('正在載入歷史 K 線…');
  let fetched;
  try {
    fetched = await fetchKlinesRange(symbol, interval, startMs, endMs, {
      maxBars: 20000,
      onProgress: ({ bars }) => { replayLoadPct = bars; },
    });
  } catch (e) {
    return toast('歷史 K 線載入失敗：' + (e.message || e));
  }
  if (!fetched.candles.length) return toast('該區間沒有 K 線資料');

  liveBackup = {
    account: state.account,
    closedTrades: state.closedTrades,
    equitySamples: state.equitySamples,
  };
  market.destroy();
  state.account = createAccount(state.settings.startBalance);
  state.closedTrades = [];
  state.equitySamples = [];
  marks = {};
  lastPrices = {};

  replaySession = createReplaySession({
    symbol,
    interval,
    candles: fetched.candles,
    account: state.account,
    startBalance: state.settings.startBalance,
    fees: fees(),
  });
  replaySession.source = fetched.source;
  replaySession.cursor = Math.min(20, fetched.candles.length - 1);

  state.ui.symbol = symbol;
  state.ui.interval = interval;
  $('#connPill').textContent = '回放';
  $('#connPill').className = 'pill warn';
  $('#srcPill').textContent = fetched.source + ' · 歷史';
  $('#demoPill').textContent = '回放練習 · 非真實交易';

  paintReplayChart();
  applyReplayTickerUi();
  renderSymbols();
  renderIntervals();
  sampleEquity();
  showView('trade');
  toast(`回放就緒：${fetched.candles.length} 根（${fetched.source}）· 請下單並設 TP/SL`);
}

async function exitReplay() {
  if (!isReplay()) return;
  stopReplayTimer();
  replaySession.active = false;
  replaySession = null;
  if (liveBackup) {
    state.account = liveBackup.account;
    state.closedTrades = liveBackup.closedTrades;
    state.equitySamples = liveBackup.equitySamples;
    liveBackup = null;
  }
  marks = {};
  lastPrices = {};
  renderReplayBar();
  $('#demoPill').textContent = '模擬資金 · 非真實交易';
  try {
    await market.start();
    $('#srcPill').textContent = market.getSource();
    updateConn(market.getConn());
    await market.setSymbol(state.ui.symbol || 'BTCUSDT');
    market.setIntervalKey(state.ui.interval || '5');
    refreshKlines();
    loadHourly();
  } catch (_) {
    toast('恢復即時行情失敗，請重新整理');
  }
  renderSymbols();
  renderIntervals();
  renderEquity();
  renderPosTab();
  persist();
  toast('已結束回放，恢復即時練習帳戶');
}

function defaultReplayStartIso(daysBack) {
  const d = new Date(Date.now() - daysBack * 86400000);
  return d.toISOString().slice(0, 10);
}

function renderReplay() {
  const el = $('#view-replay');
  const results = state.replayResults || [];
  const loading = replayLoadPct > 0 && !isReplay() ? `<p class="muted">已載入約 ${replayLoadPct} 根…</p>` : '';
  const active = isReplay()
    ? `<div class="panel-block">
        <h3>回放進行中</h3>
        <p>${replaySession.symbol} · 已播放 ${replayProgress(replaySession).i + 1}/${replayProgress(replaySession).n}</p>
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <button type="button" class="btn accent" id="rpGoTrade" style="width:auto">前往交易台操作</button>
          <button type="button" class="btn danger" id="rpEndFromPage" style="width:auto">結束回放</button>
        </div>
      </div>`
    : '';
  el.innerHTML = `<div class="page-head"><h1>歷史回放</h1>
    <p>用真實歷史 K 線重練：下單、設止盈停損，播放驗證會否打到目標。回放撮合簡化（合成盤口＋K 線高低觸價），不進排位榜。</p></div>
    ${active}
    <div class="panel-block">
      <h3>開始新回放</h3>
      ${loading}
      <div class="replay-setup-grid">
        <label class="field">合約
          <select id="rpSym">${listSymbols().map((s) =>
    `<option value="${s}" ${s === (state.ui.symbol || 'BTCUSDT') ? 'selected' : ''}>${s}</option>`).join('')}</select>
        </label>
        <label class="field">K 線週期
          <select id="rpIv">
            <option value="5">5 分鐘</option>
            <option value="15">15 分鐘</option>
            <option value="60">1 小時</option>
          </select>
        </label>
        <label class="field">起始日
          <input type="date" id="rpStart" value="${defaultReplayStartIso(7)}" />
        </label>
        <label class="field">結束日
          <input type="date" id="rpEnd" value="${defaultReplayStartIso(0)}" />
        </label>
      </div>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin:10px 0">
        <button type="button" class="btn ghost" data-preset="7" style="width:auto">近 7 日</button>
        <button type="button" class="btn ghost" data-preset="30" style="width:auto">近 30 日</button>
        <button type="button" class="btn ghost" data-preset="365" style="width:auto">近一年</button>
      </div>
      <p class="muted" style="font-size:11px;line-height:1.5;margin-bottom:8px">
        近一年 5m 資料量較大（最多約 2 萬根），載入需數十秒。建議先用 7／30 日練習。
      </p>
      <button type="button" class="btn accent" id="rpStartBtn" ${isReplay() ? 'disabled' : ''}>載入並開始回放</button>
    </div>
    <div class="panel-block">
      <h3>回放成績（本機）</h3>
      ${results.length ? `<table class="pos-table"><thead><tr>
        <th>時間</th><th>合約</th><th>結果</th><th>盈虧</th><th>K線數</th>
      </tr></thead><tbody>${results.slice(0, 20).map((r) => `<tr>
        <td>${new Date(r.ts).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}</td>
        <td>${r.symbol}</td>
        <td>${r.reason}</td>
        <td class="${r.pnlUsdt >= 0 ? 'up' : 'down'}">${fmtPnl(r.pnlUsdt)}</td>
        <td>${r.durationBars}</td>
      </tr>`).join('')}</tbody></table>`
    : '<p class="empty-hint">尚無回放成績。完成「播放至結果」後會顯示於此。</p>'}
    </div>`;

  el.querySelectorAll('[data-preset]').forEach((b) => {
    b.onclick = () => {
      const days = Number(b.dataset.preset);
      $('#rpStart').value = defaultReplayStartIso(days);
      $('#rpEnd').value = defaultReplayStartIso(0);
    };
  });
  $('#rpGoTrade')?.addEventListener('click', () => showView('trade'));
  $('#rpEndFromPage')?.addEventListener('click', () => exitReplay());
  $('#rpStartBtn')?.addEventListener('click', async () => {
    const symbol = $('#rpSym').value;
    const interval = $('#rpIv').value;
    const startVal = $('#rpStart').value;
    const endVal = $('#rpEnd').value;
    if (!startVal || !endVal) return toast('請選擇起始／結束日');
    const startMs = new Date(startVal + 'T00:00:00+08:00').getTime();
    const endMs = Math.min(Date.now(), new Date(endVal + 'T23:59:59+08:00').getTime());
    if (!(endMs > startMs)) return toast('結束日須晚於起始日');
    $('#rpStartBtn').disabled = true;
    $('#rpStartBtn').textContent = '載入中…';
    await enterReplay({ symbol, interval, startMs, endMs });
    renderReplay();
  });
}

function renderSettings() {
  const el = $('#view-settings');
  const s = state.settings;
  const chActive = state.challenge?.status === 'active';
  const driveLabel = drive.statusLabel(driveSyncStatus);
  el.innerHTML = `<div class="page-head"><h1>設定</h1>
    <p>帳戶、雲端備份、費用、資料來源與免責聲明。</p></div>
    <div class="panel-block">
      <h3>Google Drive 備份</h3>
      <p style="color:var(--muted);font-size:12px;line-height:1.55;margin-bottom:8px">
        與 Solara 相同模式：僅寫入 Drive「應用程式資料」資料夾，檔名
        <span class="mono">${DRIVE_FILE}</span>（不會覆蓋 Solara）。
        請在 Google Cloud Console 建立 OAuth 網頁用戶端，並把
        <span class="mono">http://localhost:8765</span>／GitHub Pages 網址加入授權來源。
      </p>
      <label class="field">OAuth Client ID
        <input id="googleClientId" type="text" autocomplete="off"
          placeholder="xxxx.apps.googleusercontent.com"
          value="${s.googleClientId || ''}" />
      </label>
      <label style="display:block;margin:8px 0">
        <input type="checkbox" id="setAutoSync" ${s.autoSync !== false ? 'checked' : ''}/>
        變更後自動同步
      </label>
      <p id="drivePill" class="mono" style="color:var(--muted);margin:6px 0">雲端 · ${driveLabel}</p>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <button type="button" class="btn accent" id="btnDriveConnect" style="width:auto">連接／重新登入</button>
        <button type="button" class="btn ghost" id="btnDriveSync" style="width:auto">立即同步</button>
        <button type="button" class="btn ghost" id="btnDriveDisconnect" style="width:auto">斷開</button>
      </div>
    </div>
    <div class="panel-block">
      <h3>歷史回放</h3>
      <p style="color:var(--muted);font-size:12px;line-height:1.55;margin-bottom:8px">
        已可用：底欄「回放」選起始日 → 載入真實歷史 K 線 → 於交易台下單並設止盈／停損 →
        「播放至結果」。回放撮合簡化（合成盤口），成績不進排位榜。
      </p>
      <button type="button" class="btn accent" id="btnGoReplay" style="width:auto">前往回放</button>
    </div>
    <div class="panel-block">
      <label class="field">Maker 費率 <input id="setMaker" type="number" step="0.0001" value="${s.makerFee}" /></label>
      <label class="field">Taker 費率 <input id="setTaker" type="number" step="0.0001" value="${s.takerFee}" /></label>
      <label><input type="checkbox" id="setBeginner" ${s.beginnerCap ? 'checked' : ''}/> 新手槓桿上限 5x</label>
      <label style="display:block;margin-top:8px"><input type="checkbox" id="setMild" ${s.mildLabels ? 'checked' : ''}/> 中性風格標籤</label>
      <p style="color:var(--muted);margin-top:8px">資料來源：${market.getSource()}（優先 Bybit，失敗則使用 OKX）</p>
      <p style="color:var(--muted)">練習撮合不等於交易所保證成交（限價為樂觀成交模型）</p>
    </div>
    <div class="panel-block">
      <h3>補倉（虛擬資金）</h3>
      <label class="field">金額 USDT
        <input id="topUpAmt" type="number" min="1" step="100" value="10000" ${chActive ? 'disabled' : ''} />
      </label>
      <button type="button" class="btn ghost" id="btnTopUp" ${chActive ? 'disabled' : ''}>補倉</button>
      ${chActive ? '<p style="color:var(--warning)">排位賽期間禁止補倉</p>' : ''}
    </div>
    <div class="panel-block">
      <button type="button" class="btn ghost" id="btnExport">匯出 JSON</button>
      <label class="field" style="margin-top:8px">匯入 JSON
        <textarea id="importArea" rows="4" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);font-family:var(--mono)"></textarea>
      </label>
      <div id="importPreview" class="mono" style="color:var(--muted);margin:8px 0"></div>
      <button type="button" class="btn ghost" id="btnImportPreview">預覽匯入</button>
      <button type="button" class="btn accent" id="btnImport" disabled>確認匯入</button>
    </div>
    <div class="panel-block">
      <p>重置會清除：倉位、掛單、成交歷史、已平倉、權益樣本、進行中的排位賽。</p>
      <label class="field">輸入 RESET 確認
        <input id="resetConfirm" autocomplete="off" />
      </label>
      <button type="button" class="btn danger" id="btnReset">重置帳戶</button>
    </div>
    <div class="panel-block" style="color:var(--muted);font-size:12px;line-height:1.55">
      Apex Trade Lab 係個人模擬練習工具，不是投資建議、券商或訊號服務。<br>
      與 Bybit 無關聯。僅使用公開市場資料（Bybit／OKX 公開 API）。<br>
      模擬撮合／手續費／強平可能與真實成交不同。<br>
      能力分／段位僅反映本機練習表現，可能被竄改，不是金融資格。
    </div>`;
  let pendingImport = null;
  $('#setMaker').onchange = (e) => { state.settings.makerFee = Number(e.target.value); persist(); };
  $('#setTaker').onchange = (e) => { state.settings.takerFee = Number(e.target.value); persist(); };
  $('#setBeginner').onchange = (e) => { state.settings.beginnerCap = e.target.checked; persist(); };
  $('#setMild').onchange = (e) => { state.settings.mildLabels = e.target.checked; persist(); };
  $('#setAutoSync').onchange = (e) => {
    state.settings.autoSync = e.target.checked;
    persist();
    if (e.target.checked) drive.startAutoSyncLoop();
  };
  $('#googleClientId').onchange = (e) => {
    state.settings.googleClientId = e.target.value.trim();
    persist();
    drive.initGoogleAuth();
  };
  $('#btnDriveConnect').onclick = () => {
    const id = $('#googleClientId').value.trim();
    drive.connect(id).then((ok) => { if (ok) renderSettings(); });
  };
  $('#btnDriveSync').onclick = () => {
    if (!state.settings.googleConnected) return toast('請先連接 Google Drive');
    drive.sync({ push: true, force: true }).then(() => {
      toast('同步完成');
      renderSettings();
    });
  };
  $('#btnDriveDisconnect').onclick = () => {
    drive.disconnect();
    renderSettings();
  };
  $('#btnGoReplay').onclick = () => showView('replay');
  $('#btnTopUp').onclick = () => {
    if (chActive && !state.challenge.allowTopUp) return toast('排位賽期間禁止補倉');
    const amt = Number($('#topUpAmt').value);
    const r = topUp(state.account, amt);
    if (!r.ok) return toast('補倉失敗');
    sampleEquity();
    persist();
    renderEquity();
    toast(`已補倉 ${amt} USDT`);
  };
  $('#btnExport').onclick = () => {
    const blob = new Blob([exportState(state)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'apex-trade-lab.json';
    a.click();
  };
  $('#btnImportPreview').onclick = () => {
    const r = importState($('#importArea').value);
    if (!r.ok) {
      pendingImport = null;
      $('#btnImport').disabled = true;
      $('#importPreview').textContent = '匯入失敗：' + r.reason;
      return;
    }
    pendingImport = r.state;
    $('#btnImport').disabled = false;
    const a = r.state.account;
    const wallet = a?.walletMicros != null
      ? (typeof a.walletMicros === 'bigint' ? Number(a.walletMicros) / 1e6 : Number(a.walletMicros) / 1e6)
      : '—';
    $('#importPreview').textContent =
      `預覽 schema=${r.state.schemaVersion} · 起始金 ${r.state.settings?.startBalance} · `
      + `錢包≈${typeof wallet === 'number' ? wallet.toFixed(2) : wallet} · `
      + `已平倉 ${r.state.closedTrades?.length ?? 0} · 榜 ${r.state.leaderboard?.length ?? 0}`
      + (r.state.challenge ? ` · 排位賽 ${r.state.challenge.status}` : '');
  };
  $('#btnImport').onclick = () => {
    if (!pendingImport) return toast('請先預覽');
    if (!window.confirm('確認以匯入資料取代目前狀態？會先備份現有資料。')) return;
    saveState(state); // writes bak
    state = pendingImport;
    if (!state.account) state.account = createAccount(state.settings.startBalance);
    persist();
    toast('匯入成功');
    location.reload();
  };
  $('#btnReset').onclick = () => {
    if (state.challenge?.status === 'active' && !state.challenge.allowReset) {
      return toast('排位賽期間禁止重置');
    }
    if ($('#resetConfirm').value !== 'RESET') return toast('請輸入 RESET');
    state.account = resetAccount(state.settings.startBalance);
    state.closedTrades = [];
    state.equitySamples = [{ t: Date.now(), equity: state.settings.startBalance }];
    state.challenge = null;
    sampleEquity();
    persist();
    renderEquity();
    renderPosTab();
    toast('帳戶已重置');
  };
}

function openDrawer() {
  const backdrop = $('#drawerBackdrop');
  const drawer = $('#orderDrawer');
  const pane = $('.order-pane');
  drawer.innerHTML = '';
  drawer.appendChild(pane);
  pane.classList.add('drawer-mode');
  pane.style.display = 'block';
  backdrop.classList.remove('hidden');
}

function closeDrawer() {
  const backdrop = $('#drawerBackdrop');
  if (backdrop.classList.contains('hidden')) return;
  const pane = $('.order-pane');
  const grid = $('.trade-grid');
  if (pane && grid) {
    pane.classList.remove('drawer-mode');
    grid.appendChild(pane);
  }
  backdrop.classList.add('hidden');
}

function syncOrdTypeUi() {
  $$('#ordTypeSeg button').forEach((x) => x.classList.toggle('active', x.dataset.type === ordType));
  const showLimitPx = ordType === 'limit' || ordType === 'stop_limit';
  const showTrig = ordType === 'stop_market' || ordType === 'stop_limit';
  const showTrail = ordType === 'stop_trail';
  $$('.limit-only').forEach((x) => x.classList.toggle('hidden', !showLimitPx));
  const tifField = $('#tif')?.closest('label, .field');
  if (tifField) tifField.classList.toggle('hidden', ordType !== 'limit');
  $$('.cond-only').forEach((x) => x.classList.toggle('hidden', !showTrig));
  $$('.trail-only').forEach((x) => x.classList.toggle('hidden', !showTrail));
}

function applyRoiHelper(kind, pct) {
  const t = market.getTicker();
  if (!t) return toast('行情尚未就緒');
  const px = t.last;
  const side = submitSide;
  if (kind === 'tp') {
    const tp = side === 'long' ? px * (1 + pct / 100) : px * (1 - pct / 100);
    $('#useTp').checked = true;
    $('#tp').disabled = false;
    $('#tp').value = String(Number(tp.toFixed(4)));
  } else {
    const sl = side === 'long' ? px * (1 - pct / 100) : px * (1 + pct / 100);
    $('#useSl').checked = true;
    $('#sl').disabled = false;
    $('#sl').value = String(Number(sl.toFixed(4)));
  }
  updatePreSummary();
}

function wireUi() {
  $('#btnEnter').onclick = enterApp;
  $$('.nav button').forEach((b) => {
    b.onclick = () => showView(b.dataset.nav);
  });
  $('#leverage').oninput = () => {
    $('#levVal').textContent = levEffective() + 'x';
    const badge = $('#levBadge');
    if (badge) badge.innerHTML = `槓桿 <span id="levVal">${levEffective()}x</span> / 最高 50x`;
    if (!state.ui.levBySymbol) state.ui.levBySymbol = {};
    state.ui.levBySymbol[market.getSymbol()] = levEffective();
    updatePreSummary();
  };
  $('#levBadge')?.addEventListener('click', async () => {
    const vals = await formSheet({
      title: '設定槓桿',
      fields: [{ id: 'lev', label: '槓桿 1–50（最高 50x）', value: String(levEffective()), type: 'number' }],
    });
    if (!vals) return;
    const next = Number(vals.lev);
    if (!(next >= 1 && next <= 50)) return toast('槓桿無效');
    $('#leverage').value = String(next);
    $('#leverage').dispatchEvent(new Event('input'));
  });
  $('#qty').oninput = updatePreSummary;
  document.querySelectorAll('input[name="qtyUnit"]').forEach((el) => {
    el.onchange = () => {
      state.ui.qtyUnit = el.value;
      const lab = $('#qtyUnitLabel');
      if (lab) lab.textContent = el.value === 'usdt' ? '（USDT 名義）' : '（幣）';
      persist();
      updatePreSummary();
    };
  });
  if (state.ui.qtyUnit === 'usdt') {
    const u = $('#qtyUnitUsdt');
    if (u) u.checked = true;
    const lab = $('#qtyUnitLabel');
    if (lab) lab.textContent = '（USDT 名義）';
  }
  $('#limitPrice')?.addEventListener('input', updatePreSummary);
  $('#triggerPrice')?.addEventListener('input', updatePreSummary);
  $('#reduceOnly')?.addEventListener('change', updatePreSummary);
  $('#sizeChips')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-pct]');
    if (!b) return;
    setQtyFromPct(Number(b.dataset.pct));
  });
  $('#roiChips')?.addEventListener('click', (e) => {
    const tp = e.target.closest('[data-roi-tp]');
    if (tp) return applyRoiHelper('tp', Number(tp.dataset.roiTp));
    const sl = e.target.closest('[data-roi-sl]');
    if (sl) return applyRoiHelper('sl', Number(sl.dataset.roiSl));
  });
  $('#ordTypeSeg').onclick = (e) => {
    const b = e.target.closest('button[data-type]');
    if (!b) return;
    ordType = b.dataset.type;
    syncOrdTypeUi();
    updatePreSummary();
  };
  $('#useTp').onchange = (e) => { $('#tp').disabled = !e.target.checked; };
  $('#useSl').onchange = (e) => { $('#sl').disabled = !e.target.checked; };
  $('#orderForm').onsubmit = (e) => {
    e.preventDefault();
    const side = submitSide;
    submitOrder(side);
  };
  $('#btnLong').onclick = () => { submitSide = 'long'; };
  $('#btnShort').onclick = () => { submitSide = 'short'; };
  $('#btnClose').onclick = () => closePosition(market.getSymbol());
  $('#posTabHeads').onclick = (e) => {
    if (e.target.closest('#btnCloseAll')) {
      closeAllPositions();
      return;
    }
    if (e.target.closest('#btnCancelAll')) {
      (async () => {
        const n = state.account.orders.filter((o) => o.status === 'open').length;
        const ok = await confirmTradeAction({
          title: '確認全部撤單',
          body: `將取消全部 ${n} 筆當前委託`,
          confirmLabel: '全部撤單',
          danger: true,
        });
        if (!ok) return;
        const r = cancelAllOrders(state.account);
        persist();
        renderPosTab();
        toast(`已撤銷 ${r.count} 筆委託`);
      })();
      return;
    }
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    posTab = b.dataset.tab;
    $$('#posTabHeads button[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
    renderPosTab();
  };
  $('#toggleBook').onclick = () => {
    $('#bookTrades').classList.toggle('open');
  };
  $('#fabOrder').onclick = openDrawer;
  $('#drawerBackdrop').onclick = (e) => {
    if (e.target === $('#drawerBackdrop')) closeDrawer();
  };
  syncOrdTypeUi();
  refreshTicketHead();

  market.on((ev) => {
    if (ev.type === 'conn') updateConn(ev.payload);
    if (ev.type === 'ticker') updateTicker(ev.payload);
    if (ev.type === 'book') renderBook(ev.payload);
    if (ev.type === 'trades') renderTrades(ev.payload);
    if (ev.type === 'error') console.warn(ev.payload);
  });

  renderSymbols();
  renderIntervals();
  renderEquity();
  renderPosTab();
  refreshRankPill();
  $('#levVal').textContent = levEffective() + 'x';

  if (!state.equitySamples?.length && state.account) {
    state.equitySamples = [{ t: Date.now(), equity: state.settings.startBalance }];
  }
  // Hourly equity snapshot so calendar day boundaries stay honest.
  setInterval(() => {
    const now = Date.now();
    if (now - lastHourlySample < 55 * 60 * 1000) return;
    lastHourlySample = now;
    if (state.ui.entered) {
      sampleEquity();
      persist();
    }
  }, 60_000);
  if (loaded.recovered) toast('已從備份或預設資料恢復');
  if (state.ui.entered) enterApp();
  drive.boot();
}

wireUi();
