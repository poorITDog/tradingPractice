import { createMarket, listSymbols, symbolMeta } from './lib/market.js';
import {
  createAccount, placeOrder, cancelOrder, maybeFillLimits, onMarkUpdate,
  settleFunding, accountSnapshot, liqPrice, resetAccount, topUp,
} from './lib/engine.js';
import { loadState, saveState, exportState, importState } from './lib/store.js';
import {
  abilityScore, sixDimensions, rankTier, ma, entryVsMaSign,
  maxDrawdownPct, sharpeLike,
} from './lib/analytics.js';
import {
  startChallenge, challengeRemaining, settleChallenge, pushLeaderboard, exportScoreCard,
} from './lib/rank.js';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const loaded = loadState();
let state = loaded.state;
if (!state.account) state.account = createAccount(state.settings.startBalance);

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

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2800);
}

function persist() {
  try {
    const r = saveState(state);
    if (!r.ok && r.reason === 'quota') toast('儲存空間不足');
    else if (!r.ok) console.warn('saveState', r.reason);
  } catch (e) {
    console.warn('persist failed', e);
  }
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
  const ch = state.challenge;
  if (!ch || ch.status !== 'active') return false;
  return challengeRemaining(ch) <= 0;
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
  });
  if (!res.ok) return false;
  state.challenge = res.challenge;
  const pushed = pushLeaderboard(state.leaderboard, res.entry);
  state.leaderboard = pushed.board;
  persist();
  if (pushed.accepted) {
    toast(`Challenge 時間到 · Score ${res.entry.score?.toFixed?.(1)} · ${res.entry.tier}`);
  } else {
    toast('Challenge 時間到 · 樣本不足未入榜');
  }
  return true;
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
    toast('無法取得行情，請檢查網絡');
  });
}

function showCoach(step) {
  coachStep = step;
  const steps = [
    { t: '圖表', d: '呢度係真實 K 線。先觀察趨勢，再決定方向。' },
    { t: '槓桿', d: '新手預設上限 5x。槓桿愈高，強平愈近。' },
    { t: 'Long / Short', d: '綠鍵做多、紅鍵做空。下單前會顯示保證金同預估強平。' },
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
  box.innerHTML = listSymbols().map((s) =>
    `<button type="button" data-sym="${s}" class="${s === market.getSymbol() ? 'active' : ''}">${s.replace('USDT', '')}</button>`
  ).join('');
  box.onclick = async (e) => {
    const b = e.target.closest('button[data-sym]');
    if (!b) return;
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
  box.innerHTML = ivs.map(([k, lab]) =>
    `<button type="button" data-iv="${k}" class="${k === market.getInterval() ? 'active' : ''}">${lab}</button>`
  ).join('');
  box.onclick = (e) => {
    const b = e.target.closest('button[data-iv]');
    if (!b) return;
    market.setIntervalKey(b.dataset.iv);
    state.ui.interval = b.dataset.iv;
    persist();
    renderIntervals();
    refreshKlines();
  };
}

function updateConn(conn) {
  const pill = $('#connPill');
  pill.textContent = conn;
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
  if (!t) return;
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
    · mark ${t.markApprox ? '≈' : ''}${Number(t.mark).toFixed(2)}
    · 24h <span class="${cls}">${ch?.toFixed(2)}%</span>
    · fund ${(Number(t.fundingRate || 0) * 100).toFixed(4)}%`;
  maybeFillLimits(state.account, { last, mark: t.markApprox ? null : t.mark }, fees());
  if (!t.markApprox) {
    const riskEvs = onMarkUpdate(state.account, t.symbol, t.mark, fees());
    for (const ev of riskEvs) {
      const label = ev.type === 'liquidation' ? '強平' : ev.type === 'sl' ? 'SL 觸發' : 'TP 觸發';
      toast(`${label} ${t.symbol}`);
    }
  }
  maybeAutoSettleChallenge();
  const structural = (state.account.events || []).some(
    (e) => e.type === 'close' || e.type === 'open',
  );
  harvestCloses();
  checkFunding(t);
  renderEquity();
  renderPosTab();
  updatePreSummary();
  warnLiqProximity();
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
    persist();
  }
}

function renderBook(book) {
  const el = $('#book');
  if (!book) return;
  const asks = [...book.asks].slice(0, 8).reverse();
  const bids = book.bids.slice(0, 8);
  el.innerHTML = `<div style="color:var(--muted);margin-bottom:4px">Orderbook</div>`
    + asks.map(([p, s]) => `<div class="down"><span>${p}</span><span>${s}</span></div>`).join('')
    + `<div style="height:6px"></div>`
    + bids.map(([p, s]) => `<div class="up"><span>${p}</span><span>${s}</span></div>`).join('');
}

function renderTrades(trades) {
  const el = $('#recentTrades');
  el.innerHTML = `<div style="color:var(--muted);margin-bottom:4px">Trades</div>`
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
  const t = market.getTicker();
  const qty = Number($('#qty').value) || 0;
  const lev = levEffective();
  const px = ordType === 'limit' ? Number($('#limitPrice').value) || t?.last : t?.last;
  const el = $('#preSummary');
  const snap = accountSnapshot(state.account, displayMarks(), fees());
  const reduce = $('#reduceOnly')?.checked;
  let canSubmit = qty > 0 && !!t && !!px && !challengeBlocksTrading();
  if (!t || !(qty > 0) || !px) {
    el.textContent = challengeBlocksTrading()
      ? 'Challenge 已結束，請到 Rank 結算'
      : '輸入數量以預覽保證金／強平';
    canSubmit = false;
  } else {
    const notional = qty * px;
    const im = notional / lev;
    const fee = notional * fees().taker;
    const meta = symbolMeta(market.getSymbol());
    const longLiq = liqPrice({ side: 'long', entry: px, leverage: lev, mmr: meta.mmr, feeRate: fees().taker });
    const shortLiq = liqPrice({ side: 'short', entry: px, leverage: lev, mmr: meta.mmr, feeRate: fees().taker });
    const mark = t.markApprox ? t.last : t.mark;
    el.innerHTML = `名義 $${notional.toFixed(2)} · 保證金 ≈ $${im.toFixed(2)} · 預估費 $${fee.toFixed(4)}<br>
    預估強平 Long ${longLiq.toFixed(2)} (${((mark - longLiq) / mark * 100).toFixed(2)}%) ·
    Short ${shortLiq.toFixed(2)} (${((shortLiq - mark) / mark * 100).toFixed(2)}%)`;
    if (!reduce && snap.available < im + fee) canSubmit = false;
  }
  const longBtn = $('#btnLong');
  const shortBtn = $('#btnShort');
  if (longBtn) longBtn.disabled = !canSubmit;
  if (shortBtn) shortBtn.disabled = !canSubmit;
}

function warnLiqProximity() {
  const snap = accountSnapshot(state.account, displayMarks(), fees());
  const now = Date.now();
  if (now - lastLiqWarnAt < 15000) return;
  for (const p of snap.positions) {
    if (p.distToLiq < 0.03) {
      lastLiqWarnAt = now;
      toast(`危急：${p.symbol} 距強平 ${(p.distToLiq * 100).toFixed(2)}%`);
      break;
    }
    if (p.distToLiq < 0.08) {
      lastLiqWarnAt = now;
      toast(`警告：${p.symbol} 距強平 ${(p.distToLiq * 100).toFixed(2)}%`);
      break;
    }
  }
}

function setQtyFromPct(pct) {
  const t = market.getTicker();
  if (!t) return;
  const lev = levEffective();
  const snap = accountSnapshot(state.account, displayMarks(), fees());
  const px = t.last;
  const meta = symbolMeta(market.getSymbol());
  const usable = Math.max(0, snap.available) * (pct / 100) * 0.98;
  // IM = qty*px/lev → qty = usable * lev / px
  let qty = (usable * lev) / px;
  qty = Math.floor(qty / meta.lot) * meta.lot;
  if (pct === 100 && qty * px / lev > snap.available) {
    qty = Math.floor((snap.available * lev / px) / meta.lot) * meta.lot;
  }
  $('#qty').value = qty > 0 ? String(Number(qty.toFixed(8))) : '';
  if (pct === 100) toast('100% 倉位風險極高');
  updatePreSummary();
}

function renderEquity() {
  const snap = accountSnapshot(state.account, displayMarks(), fees());
  const cls = snap.returnPct >= 0 ? 'up' : 'down';
  const deg = marks[market.getSymbol()] == null ? ' · mark degraded' : '';
  $('#equityBar').innerHTML = `權益 <b class="mono">${snap.equity.toFixed(2)}</b>
    · 可用 ${snap.available.toFixed(2)}
    · 收益 <span class="${cls}">${snap.returnPct >= 0 ? '+' : ''}${snap.returnPct.toFixed(2)}%</span>${deg}`;
}

function renderPosTab() {
  const body = $('#posTabBody');
  const snap = accountSnapshot(state.account, displayMarks(), fees());
  if (posTab === 'positions') {
    if (!snap.positions.length) {
      body.innerHTML = '<p style="color:var(--muted)">暫無倉位</p>';
      return;
    }
    body.innerHTML = `<table><thead><tr><th>合約</th><th>方向</th><th>數量</th><th>入場</th><th>標記</th><th>PnL</th><th>強平</th><th>距強平</th></tr></thead><tbody>`
      + snap.positions.map((p) => {
        const band = p.distToLiq < 0.03 ? 'crit' : p.distToLiq < 0.08 ? 'warn' : '';
        const bandTxt = band === 'crit' ? '危急 ' : band === 'warn' ? '警告 ' : '';
        const pnlCls = p.upnl >= 0 ? 'up' : 'down';
        return `<tr class="liq-${band}"><td>${p.symbol}</td><td class="${p.side === 'long' ? 'up' : 'down'}">${p.side === 'long' ? 'Long' : 'Short'}</td>
        <td>${p.qty}</td><td>${p.entry.toFixed(2)}</td><td>${p.mark?.toFixed?.(2) ?? '—'}</td>
        <td class="${pnlCls}">${p.upnl >= 0 ? '+' : ''}${p.upnl.toFixed(2)}</td>
        <td>${p.liqPrice.toFixed(2)}</td><td>${bandTxt}${(p.distToLiq * 100).toFixed(2)}%</td></tr>`;
      }).join('') + '</tbody></table>';
  } else if (posTab === 'orders') {
    const rows = snap.openOrders;
    if (!rows.length) {
      body.innerHTML = '<p style="color:var(--muted)">暫無掛單</p>';
      return;
    }
    body.innerHTML = `<table><thead><tr><th>合約</th><th>方向</th><th>價</th><th>量</th><th></th></tr></thead><tbody>`
      + rows.map((o) => `<tr><td>${o.symbol}</td><td>${o.side}</td><td>${o.price}</td><td>${o.qty}</td>
        <td><button type="button" data-cancel="${o.id}">取消</button></td></tr>`).join('')
      + '</tbody></table>';
    body.onclick = (e) => {
      const b = e.target.closest('[data-cancel]');
      if (!b) return;
      cancelOrder(state.account, b.dataset.cancel);
      persist();
      renderPosTab();
    };
  } else {
    const fills = snap.fills;
    body.innerHTML = fills.length
      ? `<table><thead><tr><th>時間</th><th>合約</th><th>側</th><th>標記</th><th>價</th><th>量</th><th>費</th></tr></thead><tbody>`
        + fills.map((f) => {
          const tag = f.reason === 'liquidation' ? 'liq'
            : f.reason === 'funding' || f.side === 'funding' ? 'fund'
            : f.reason === 'sl' ? 'sl'
            : f.reason === 'tp' ? 'tp'
            : f.liquidity || '—';
          return `<tr><td>${new Date(f.ts).toLocaleTimeString()}</td><td>${f.symbol}</td>
          <td>${f.side}</td><td>${tag}</td><td>${f.price}</td><td>${f.qty}</td>
          <td>${Number(f.feeUsdt || 0).toFixed(4)}</td></tr>`;
        }).join('')
        + '</tbody></table>'
      : '<p style="color:var(--muted)">暫無成交</p>';
  }
}

async function confirmHighLev(lev) {
  if (lev >= 25) {
    return window.confirm(`槓桿 ${lev}x 極高風險，距強平會非常近。確定？`);
  }
  if (lev >= 10) {
    toast(`注意：槓桿 ${lev}x 風險偏高`);
  }
  return true;
}

async function submitOrder(side) {
  const t = market.getTicker();
  const book = market.getBook();
  if (!t) return toast('行情未就緒');
  if (challengeBlocksTrading()) return toast('Challenge 已結束，請到 Rank 查看結算');
  const qty = Number($('#qty').value);
  if (!(qty > 0)) return toast('請輸入數量');
  const lev = levEffective();
  if (!(await confirmHighLev(lev))) return;
  const mark = t.markApprox ? null : t.mark;
  const closes = hourlyCloses[market.getSymbol()] || [];
  const ma20 = ma(closes, 20);
  const entryPx = ordType === 'limit' ? Number($('#limitPrice').value) : t.last;
  const vs = entryVsMaSign(entryPx, ma20);
  const reduceOnly = !!$('#reduceOnly')?.checked;
  if (!reduceOnly && !$('#useSl').checked && state.settings.beginnerCap) {
    toast('建議設定 Stop Loss（新手模式）');
  }

  const input = {
    symbol: market.getSymbol(),
    side,
    ordType,
    qty,
    price: ordType === 'limit' ? Number($('#limitPrice').value) : undefined,
    leverage: lev,
    reduceOnly,
    tp: $('#useTp').checked ? Number($('#tp').value) : null,
    sl: $('#useSl').checked ? Number($('#sl').value) : null,
  };
  const ctx = {
    book,
    marks: { ...displayMarks(), [market.getSymbol()]: mark ?? t.last },
    fees: fees(),
  };
  const r = placeOrder(state.account, input, ctx);
  if (!r.ok) return toast('下單失敗：' + r.reason);
  // annotate entry vs MA on new position
  const pos = state.account.positions[market.getSymbol()];
  if (pos && vs != null) pos.entryVsMa = vs;
  if (input.sl != null && pos) {
    pos.slDistancePct = Math.abs(pos.entry - input.sl) / pos.entry / pos.leverage * 100;
  }
  harvestCloses();
  sampleEquity();
  persist();
  renderEquity();
  renderPosTab();
  const px = r.fillPrice ?? entryPx;
  const fee = r.feeUsdt ?? 0;
  toast(`${side === 'long' ? 'Long' : 'Short'} ${qty} @ ${Number(px).toFixed(2)} · 費 ${Number(fee).toFixed(4)}`);
  closeDrawer();
}

function closePosition() {
  const sym = market.getSymbol();
  const pos = state.account.positions[sym];
  if (!pos) return toast('無倉位');
  const t = market.getTicker();
  const r = placeOrder(state.account, {
    symbol: sym,
    side: pos.side === 'long' ? 'short' : 'long',
    ordType: 'market',
    qty: pos.qty,
    leverage: pos.leverage,
    reduceOnly: true,
  }, { book: market.getBook(), marks: { ...marks, [sym]: t.markApprox ? t.last : t.mark }, fees: fees() });
  if (!r.ok) return toast('平倉失敗：' + r.reason);
  harvestCloses();
  sampleEquity();
  persist();
  renderEquity();
  renderPosTab();
  toast('已市價平倉');
}

function equityCurveSvg(samples) {
  if (!samples?.length) {
    return '<p style="color:var(--muted)">交易後會顯示權益曲線</p>';
  }
  const vals = samples.map((s) => s.equity);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const w = 320; const h = 120; const pad = 8;
  const span = Math.max(1e-9, max - min);
  const pts = vals.map((v, i) => {
    const x = pad + (i / Math.max(1, vals.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / span) * (h - pad * 2);
    return `${x},${y}`;
  }).join(' ');
  const up = vals[vals.length - 1] >= vals[0];
  return `<svg width="100%" viewBox="0 0 ${w} ${h}" class="equity-svg" aria-label="權益曲線">
    <polyline fill="none" stroke="${up ? '#0ECB81' : '#F6465D'}" stroke-width="2" points="${pts}"/>
  </svg>`;
}

function renderPortfolio() {
  const el = $('#view-portfolio');
  const snap = accountSnapshot(state.account, displayMarks(), fees());
  const trades = closedTrades();
  const score = abilityScore({
    trades, equitySamples: state.equitySamples, startEquity: state.settings.startBalance,
  });
  const dd = maxDrawdownPct(state.equitySamples || []);
  const sh = sharpeLike(state.equitySamples || []);
  const wins = trades.filter((t) => t.pnlUsdt >= 0).length;
  const wr = trades.length ? (wins / trades.length * 100) : 0;
  el.innerHTML = `<div class="page-head"><h1>Portfolio</h1>
    <p>權益曲線、風險指標與已平倉紀錄（唔喺呢度下單）。</p></div>
    <div class="panel-block mono">
      權益 ${snap.equity.toFixed(2)} USDT · 錢包 ${snap.wallet.toFixed(2)} ·
      收益 ${snap.returnPct.toFixed(2)}% · 已平倉 ${trades.length} 筆
      ${score.ok ? ` · Ability ${score.score.toFixed(1)} (${rankTier(score.score)})` : ' · 樣本不足'}
    </div>
    <div class="panel-block">
      <h3>權益曲線</h3>
      ${equityCurveSvg(state.equitySamples)}
    </div>
    <div class="panel-block mono">
      <h3>風險指標</h3>
      最大回撤 ${dd.toFixed(2)}% · Sharpe-like ${sh == null ? '—' : sh.toFixed(2)} ·
      勝率 ${trades.length ? wr.toFixed(1) + '%' : '—'}
    </div>
    <div class="panel-block">
      <h3>最近平倉</h3>
      ${trades.slice(-20).reverse().map((t) =>
        `<div class="lb-row"><span>${t.symbol} ${t.side}</span>
        <span class="${t.pnlUsdt >= 0 ? 'up' : 'down'}">${t.pnlUsdt >= 0 ? '+' : ''}${t.pnlUsdt.toFixed(2)}</span></div>`
      ).join('') || '<p style="color:var(--muted)">尚未平倉</p>'}
    </div>`;
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
  el.innerHTML = `<div class="page-head"><h1>Analyze</h1>
    <p>六維風格雷達與 Ability Score（練習報告，唔係獲利保證）。</p></div>
    <div class="panel-block">
      ${dims.ok ? `<div class="radar-wrap">${radarSvg(dims.dims)}</div>
        <h3 style="text-align:center">${state.settings.mildLabels ? '風格診斷' : dims.label}</h3>
        <ul class="tips">${dims.tips.map((t) => `<li>${t}</li>`).join('')}</ul>`
    : `<p style="color:var(--muted)">完成 10 筆已平倉交易後解鎖風格解讀。（而家 ${trades.length} 筆）</p>
       <p><button type="button" class="btn accent" data-go="trade">去交易</button></p>`}
    </div>
    <div class="panel-block mono">
      Ability Score：${score.ok ? score.score.toFixed(1) + ' · ' + rankTier(score.score) : '樣本不足'}
      ${score.ok ? `<br>r=${score.parts.r.toFixed(0)} q=${score.parts.q.toFixed(0)} d=${score.parts.d.toFixed(0)} s=${score.parts.s.toFixed(0)}` : ''}
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
  el.innerHTML = `<div class="page-head"><h1>Rank</h1>
    <p>Challenge 結算後進入本機榜；Live Sim 只更新預覽分數。</p></div>
    <div class="panel-block">
      <h3>Challenge（7 日 UTC）</h3>
      ${ch?.status === 'active'
    ? `<p class="mono">${expired ? '已結束 · 等待結算' : `剩餘 ${Math.ceil(remain / 3600000)} 小時`} · 禁止重置／補倉</p>
       <button type="button" class="btn accent" id="btnSettle">${expired ? '結算並進榜' : '提前結算'}</button>`
    : `<p>起始 50,000 USDT · BTC/ETH/SOL · 結算寫入本機榜</p>
       <button type="button" class="btn accent" id="btnStartCh">開始 Challenge</button>`}
    </div>
    <div class="panel-block">
      <h3>本機排行榜</h3>
      <div class="seg" id="rankSortSeg" style="margin-bottom:10px">
        <button type="button" data-sort="score" class="${rankSort === 'score' ? 'active' : ''}">Score</button>
        <button type="button" data-sort="return" class="${rankSort === 'return' ? 'active' : ''}">收益%</button>
        <button type="button" data-sort="sharpe" class="${rankSort === 'sharpe' ? 'active' : ''}">Sharpe</button>
        <button type="button" data-sort="dd" class="${rankSort === 'dd' ? 'active' : ''}">回撤</button>
        <button type="button" data-sort="win" class="${rankSort === 'win' ? 'active' : ''}">勝率</button>
      </div>
      ${board.length
    ? `<table class="rank-table"><thead><tr><th>#</th><th>段位</th><th>Score</th><th>收益%</th><th>Sharpe</th><th>回撤%</th><th>勝率</th><th>筆數</th></tr></thead><tbody>`
      + board.map((e, i) => `<tr>
        <td>${i + 1}</td><td>${e.tier}</td><td>${e.score?.toFixed?.(1) ?? '—'}</td>
        <td>${e.returnPct?.toFixed?.(2) ?? '—'}</td>
        <td>${e.parts?.S == null ? '—' : Number(e.parts.S).toFixed(2)}</td>
        <td>${e.parts?.D == null ? '—' : Number(e.parts.D).toFixed(2)}</td>
        <td>${e.parts?.W == null ? '—' : (e.parts.W * 100).toFixed(0) + '%'}</td>
        <td>${e.trades ?? 0}</td></tr>`).join('')
      + '</tbody></table>'
    : '<p style="color:var(--muted)">尚未有 Challenge 成績</p>'}
      ${board[0] ? '<button type="button" class="btn ghost" id="btnScoreCard" style="margin-top:8px">匯出最新成績碼</button>' : ''}
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
    if (state.challenge?.status === 'active') return;
    state.account = createAccount(50000);
    state.closedTrades = [];
    state.equitySamples = [{ t: Date.now(), equity: 50000 }];
    state.challenge = startChallenge();
    persist();
    toast('Challenge 開始');
    showView('trade');
  });
  $('#btnSettle')?.addEventListener('click', () => {
    const force = challengeRemaining(state.challenge) > 0;
    const res = settleChallenge({
      challenge: force ? { ...state.challenge, force: true } : state.challenge,
      trades: closedTrades(),
      equitySamples: state.equitySamples,
      startEquity: state.challenge.startBalance || 50000,
    });
    if (!res.ok) return toast('結算失敗：' + res.reason);
    state.challenge = res.challenge;
    const pushed = pushLeaderboard(state.leaderboard, res.entry);
    state.leaderboard = pushed.board;
    persist();
    if (!pushed.accepted) toast('樣本不足，未入榜（需 ≥10 筆已平倉）');
    else toast(`結算完成 · Score ${res.entry.score?.toFixed?.(1)} · ${res.entry.tier}`);
    renderRank();
    showView('analyze');
  });
}

function renderSettings() {
  const el = $('#view-settings');
  const s = state.settings;
  const chActive = state.challenge?.status === 'active';
  el.innerHTML = `<div class="page-head"><h1>Settings</h1>
    <p>帳戶、費用、數據源與免責。</p></div>
    <div class="panel-block">
      <label class="field">Maker 費率 <input id="setMaker" type="number" step="0.0001" value="${s.makerFee}" /></label>
      <label class="field">Taker 費率 <input id="setTaker" type="number" step="0.0001" value="${s.takerFee}" /></label>
      <label><input type="checkbox" id="setBeginner" ${s.beginnerCap ? 'checked' : ''}/> 新手槓桿上限 5x</label>
      <label style="display:block;margin-top:8px"><input type="checkbox" id="setMild" ${s.mildLabels ? 'checked' : ''}/> 中性風格標籤</label>
      <p style="color:var(--muted);margin-top:8px">數據源：${market.getSource()}（Bybit 優先，失敗則 OKX）</p>
      <p style="color:var(--muted)">練習撮合 ≠ 交易所保證成交（限價為樂觀成交模型）</p>
    </div>
    <div class="panel-block">
      <h3>補倉（虛擬資金）</h3>
      <label class="field">金額 USDT
        <input id="topUpAmt" type="number" min="1" step="100" value="10000" ${chActive ? 'disabled' : ''} />
      </label>
      <button type="button" class="btn ghost" id="btnTopUp" ${chActive ? 'disabled' : ''}>補倉</button>
      ${chActive ? '<p style="color:var(--warning)">Challenge 期間禁止補倉</p>' : ''}
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
      <p>重置會清除：倉位、掛單、成交歷史、已平倉、權益樣本、進行中 Challenge。</p>
      <label class="field">輸入 RESET 確認
        <input id="resetConfirm" autocomplete="off" />
      </label>
      <button type="button" class="btn danger" id="btnReset">重置帳戶</button>
    </div>
    <div class="panel-block" style="color:var(--muted);font-size:12px;line-height:1.55">
      Apex Trade Lab 係個人模擬練習工具，唔係投資建議、券商或訊號服務。<br>
      Not affiliated with Bybit。僅使用公開市場數據（Bybit／OKX public API）。<br>
      模擬撮合／手續費／強平可能與真實成交不同。<br>
      Ability Score／段位僅反映本機練習表現，可被竄改，唔係金融資格。
    </div>`;
  let pendingImport = null;
  $('#setMaker').onchange = (e) => { state.settings.makerFee = Number(e.target.value); persist(); };
  $('#setTaker').onchange = (e) => { state.settings.takerFee = Number(e.target.value); persist(); };
  $('#setBeginner').onchange = (e) => { state.settings.beginnerCap = e.target.checked; persist(); };
  $('#setMild').onchange = (e) => { state.settings.mildLabels = e.target.checked; persist(); };
  $('#btnTopUp').onclick = () => {
    if (chActive && !state.challenge.allowTopUp) return toast('Challenge 期間禁止補倉');
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
      + (r.state.challenge ? ` · Challenge ${r.state.challenge.status}` : '');
  };
  $('#btnImport').onclick = () => {
    if (!pendingImport) return toast('請先預覽');
    if (!window.confirm('確認以匯入資料取代而家狀態？會先備份目前資料。')) return;
    saveState(state); // writes bak
    state = pendingImport;
    if (!state.account) state.account = createAccount(state.settings.startBalance);
    persist();
    toast('匯入成功');
    location.reload();
  };
  $('#btnReset').onclick = () => {
    if (state.challenge?.status === 'active' && !state.challenge.allowReset) {
      return toast('Challenge 期間禁止重置');
    }
    if ($('#resetConfirm').value !== 'RESET') return toast('請輸入 RESET');
    state.account = resetAccount(state.settings.startBalance);
    state.closedTrades = [];
    state.equitySamples = [];
    state.challenge = null;
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

function wireUi() {
  $('#btnEnter').onclick = enterApp;
  $$('.nav button').forEach((b) => {
    b.onclick = () => showView(b.dataset.nav);
  });
  $('#leverage').oninput = () => {
    $('#levVal').textContent = levEffective() + 'x';
    updatePreSummary();
  };
  $('#qty').oninput = updatePreSummary;
  $('#limitPrice').oninput = updatePreSummary;
  $('#reduceOnly')?.addEventListener('change', updatePreSummary);
  $('#sizeChips')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-pct]');
    if (!b) return;
    setQtyFromPct(Number(b.dataset.pct));
  });
  $('#ordTypeSeg').onclick = (e) => {
    const b = e.target.closest('button[data-type]');
    if (!b) return;
    ordType = b.dataset.type;
    $$('#ordTypeSeg button').forEach((x) => x.classList.toggle('active', x === b));
    $$('.limit-only').forEach((x) => x.classList.toggle('hidden', ordType !== 'limit'));
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
  $('#btnClose').onclick = closePosition;
  $('#posTabHeads').onclick = (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    posTab = b.dataset.tab;
    $$('#posTabHeads button').forEach((x) => x.classList.toggle('active', x === b));
    renderPosTab();
  };
  $('#toggleBook').onclick = () => {
    $('#bookTrades').classList.toggle('open');
  };
  $('#fabOrder').onclick = openDrawer;
  $('#drawerBackdrop').onclick = (e) => {
    if (e.target === $('#drawerBackdrop')) closeDrawer();
  };

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
  $('#levVal').textContent = levEffective() + 'x';

  if (loaded.recovered) toast('已從備份／預設恢復資料');
  if (state.ui.entered) enterApp();
}

wireUi();
