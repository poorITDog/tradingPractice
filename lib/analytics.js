// Ability Score + six-dimensional trading style radar.

import { clamp } from './money.js';

export function ma(values, n) {
  if (!values || values.length < n) return null;
  let s = 0;
  for (let i = values.length - n; i < values.length; i++) s += values[i];
  return s / n;
}

export function entryVsMaSign(entryPrice, ma20) {
  if (ma20 == null) return null;
  if (entryPrice > ma20) return 1;
  if (entryPrice < ma20) return -1;
  return 0;
}

function closedStats(trades) {
  const n = trades.length;
  if (!n) return null;
  let wins = 0;
  let winSum = 0;
  let lossSum = 0;
  let lossN = 0;
  let pnl = 0;
  for (const t of trades) {
    pnl += t.pnlUsdt;
    if (t.pnlUsdt >= 0) {
      wins += 1;
      winSum += t.pnlUsdt;
    } else {
      lossN += 1;
      lossSum += Math.abs(t.pnlUsdt);
    }
  }
  const W = wins / n;
  const avgWin = wins ? winSum / wins : 0;
  const avgLoss = lossN ? lossSum / lossN : 0;
  const B = avgWin / Math.max(avgLoss, 1e-9);
  const Q = W * clamp(B / 2, 0, 1.5) / 1.5;
  return { n, W, B, Q, pnl, wins, avgWin, avgLoss };
}

export function maxDrawdownPct(equitySamples) {
  if (!equitySamples?.length) return 0;
  let peak = equitySamples[0].equity;
  let maxDd = 0;
  for (const s of equitySamples) {
    peak = Math.max(peak, s.equity);
    if (peak > 0) {
      const dd = (peak - s.equity) / peak * 100;
      maxDd = Math.max(maxDd, dd);
    }
  }
  return maxDd;
}

export function sharpeLike(equitySamples) {
  if (!equitySamples || equitySamples.length < 3) return null;
  const rets = [];
  for (let i = 1; i < equitySamples.length; i++) {
    const a = equitySamples[i - 1].equity;
    const b = equitySamples[i].equity;
    if (a > 0) rets.push((b - a) / a);
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((x, y) => x + y, 0) / rets.length;
  const varr = rets.reduce((x, y) => x + (y - mean) ** 2, 0) / (rets.length - 1);
  const std = Math.sqrt(varr);
  if (std < 1e-12) return mean > 0 ? 2 : 0;
  return mean / std;
}

export function abilityScore({ trades, equitySamples, startEquity }) {
  if (!trades || trades.length < 10) {
    return { ok: false, reason: 'sample', score: null };
  }
  const st = closedStats(trades);
  const endEq = equitySamples?.length
    ? equitySamples[equitySamples.length - 1].equity
    : startEquity + st.pnl;
  const R = startEquity > 0 ? ((endEq / startEquity) - 1) * 100 : 0;
  const D = maxDrawdownPct(equitySamples || []);
  const Sraw = sharpeLike(equitySamples);
  const S = Sraw == null ? 0 : Sraw; // neutral handled below
  const r = clamp((R + 20) / 40 * 100, 0, 100);
  const q = clamp(st.Q * 100, 0, 100);
  const d = clamp(100 - D * 2, 0, 100);
  const s = Sraw == null ? 50 : clamp((S + 1) / 3 * 100, 0, 100);
  const score = 0.35 * r + 0.20 * q + 0.25 * d + 0.20 * s;
  return {
    ok: true,
    score,
    parts: { r, q, d, s, R, D, W: st.W, B: st.B, Q: st.Q, S: Sraw },
  };
}

// Deprecated for ladder; kept as ability-band label only.
export function rankTier(score) {
  if (score == null) return '未評級';
  if (score < 35) return '需加強';
  if (score < 55) return '及格邊緣';
  if (score < 70) return '穩健';
  if (score < 85) return '優秀';
  return '頂尖';
}

export function sixDimensions(trades) {
  if (!trades || trades.length < 10) {
    return { ok: false, reason: 'sample', dims: null };
  }
  let trendN = 0;
  let trendHit = 0;
  let meanHit = 0;
  let slN = 0;
  let tpSlN = 0;
  let rSum = 0;
  let rN = 0;
  let riskPctSum = 0;
  let holdSum = 0;
  let limitN = 0;
  let levSum = 0;
  let marginPctSum = 0;

  for (const t of trades) {
    if (t.entryVsMa != null) {
      trendN += 1;
      const dir = t.side === 'long' ? 1 : -1;
      if (dir === t.entryVsMa) trendHit += 1;
      else if (dir === -t.entryVsMa) meanHit += 1;
    }
    if (t.hadSl) slN += 1;
    if (t.hadTp && t.hadSl) tpSlN += 1;
    const hold = Math.max(1, (t.closedAt - t.openedAt) / 60000);
    holdSum += hold;
    if (t.liquidity === 'maker') limitN += 1;
    levSum += t.leverage || 1;
    // Approximate risk % if SL existed: |entry-sl|/entry/lev * 100 ≈ rough
    if (t.hadSl && t.slDistancePct != null) {
      riskPctSum += t.slDistancePct;
    } else {
      riskPctSum += 100 / (t.leverage || 1);
    }
    // R-multiple using pnl vs 1R proxy
    const risk = Math.abs(t.entry) * 0.01 / (t.leverage || 1) * t.qty;
    if (risk > 0) {
      rSum += t.pnlUsdt / risk;
      rN += 1;
    }
  }

  const n = trades.length;
  const trend = trendN ? (trendHit / trendN) * 100 : null;
  const mean = trendN ? (meanHit / trendN) * 100 : null;
  const slRate = slN / n;
  const avgR = rN ? rSum / rN : 0;
  const avgRisk = riskPctSum / n;
  const riskControl = 0.4 * (slRate * 100)
    + 0.3 * clamp(avgR / 2 * 100, 0, 100)
    + 0.3 * clamp(100 - avgRisk * 20, 0, 100);
  const tpSlRate = tpSlN / n;
  const perDay = n / Math.max(1, spanDays(trades));
  const overTradePenalty = clamp(100 - Math.max(0, perDay - 8) * 8, 0, 100);
  const discipline = 0.5 * (tpSlRate * 100) + 0.5 * overTradePenalty;
  const avgHoldMin = holdSum / n;
  const holdScore = clamp(Math.log10(avgHoldMin + 1) / Math.log10(240) * 100, 0, 100);
  const limitPct = limitN / n;
  const patience = 0.5 * holdScore + 0.5 * (limitPct * 100);
  const avgLev = levSum / n;
  const aggression = 0.4 * (avgLev / 50 * 100)
    + 0.3 * clamp(avgRisk * 2, 0, 100)
    + 0.3 * clamp(perDay / 20 * 100, 0, 100);

  const dims = {
    trendFollow: trend,
    meanRevert: mean,
    riskControl: clamp(riskControl, 0, 100),
    discipline: clamp(discipline, 0, 100),
    patience: clamp(patience, 0, 100),
    aggression: clamp(aggression, 0, 100),
  };
  return { ok: true, dims, label: styleLabel(dims), tips: styleTips(dims) };
}

function spanDays(trades) {
  let min = Infinity;
  let max = 0;
  for (const t of trades) {
    min = Math.min(min, t.openedAt);
    max = Math.max(max, t.closedAt);
  }
  return Math.max(1 / 24, (max - min) / 86400000);
}

const LABEL_RULES = [
  [['trendFollow', 'discipline'], '謹慎趨勢者'],
  [['trendFollow', 'aggression'], '強勢追趨者'],
  [['meanRevert', 'patience'], '耐心均值回歸'],
  [['meanRevert', 'aggression'], '短線抄底客'],
  [['riskControl', 'discipline'], '風控紀律型'],
  [['aggression', 'patience'], '高頻執行者'],
  [['aggression', 'aggression'], '高頻賭徒'],
  [['discipline', 'patience'], '穩健規劃者'],
];

export function styleLabel(dims) {
  if (!dims) return '樣本不足';
  const entries = Object.entries(dims)
    .filter(([, v]) => v != null)
    .sort((a, b) => b[1] - a[1]);
  if (entries.length < 2) return '觀察中';
  const top2 = [entries[0][0], entries[1][0]];
  for (const [keys, label] of LABEL_RULES) {
    if (keys[0] === top2[0] && (keys[1] === top2[1] || keys[0] === keys[1])) {
      return label;
    }
  }
  return '混合風格';
}

export function styleTips(dims) {
  if (!dims) return ['完成至少 10 筆已平倉交易以解鎖風格解讀。'];
  const ranked = Object.entries(dims)
    .filter(([, v]) => v != null)
    .sort((a, b) => a[1] - b[1]);
  const tipsMap = {
    trendFollow: '試在價格位於 1h MA(20) 上方時再考慮做多，減少逆勢衝動。',
    meanRevert: '區間單應縮小槓桿，並設定明確失效位。',
    riskControl: '每單預設停損；單筆風險控制在權益 1–2%。',
    discipline: '開倉前同時掛止盈與停損，避免無計畫持倉。',
    patience: '多用限價單，減少市價追價；延長平均持倉觀察。',
    aggression: '降低平均槓桿與倉位佔比，先求存活再求進攻。',
  };
  return ranked.slice(0, 3).map(([k]) => tipsMap[k]);
}

// Calendar day key in Asia/Taipei (Bitunix/MEXC style daily buckets).
export function dayKey(ts, tz = 'Asia/Taipei') {
  const t = Number(ts) || 0;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(t));
  } catch {
    return new Date(t).toISOString().slice(0, 10);
  }
}

// Year/month parts in Taipei for calendar grid alignment.
export function taipeiYMD(ts = Date.now(), tz = 'Asia/Taipei') {
  const key = dayKey(ts, tz);
  const [y, m, d] = key.split('-').map(Number);
  return { y, m, d, key };
}

export function filterClosedTrades(trades, { sym = '', day = '', from = '', to = '' } = {}) {
  return (trades || []).filter((t) => {
    if (sym && t.symbol !== sym) return false;
    const k = dayKey(t.closedAt);
    if (day && k !== day) return false;
    if (from && k < from) return false;
    if (to && k > to) return false;
    return true;
  });
}

function ensureDay(map, key) {
  if (!map.has(key)) {
    map.set(key, {
      key,
      realized: 0,
      funding: 0,
      openFees: 0,
      closeFees: 0,
      transfer: 0,
      trades: [],
      equityOpen: null,
      equityClose: null,
      pnl: 0,
    });
  }
  return map.get(key);
}

// Headline daily PnL = equityClose − equityOpen − transfers (top-ups).
// Breakdown: realized / funding / fees for drill-down.
export function buildDailyLedger({
  trades = [], fills = [], topups = [], equitySamples = [],
  startEquity = 50000, tz = 'Asia/Taipei',
} = {}) {
  const days = new Map();
  for (const tr of trades) {
    const d = ensureDay(days, dayKey(tr.closedAt, tz));
    d.realized += Number(tr.pnlUsdt) || 0;
    d.closeFees += Number(tr.feeUsdt) || 0;
    d.trades.push(tr);
  }
  for (const f of fills) {
    const d = ensureDay(days, dayKey(f.ts, tz));
    if (f.reason === 'funding' || f.side === 'funding' || f.liquidity === 'funding') {
      d.funding += Number(f.feeUsdt) || 0;
    } else if (f.reason === 'open') {
      d.openFees += Number(f.feeUsdt) || 0;
    }
  }
  for (const u of topups) {
    const d = ensureDay(days, dayKey(u.ts, tz));
    d.transfer += Number(u.usdt) || 0;
  }
  // Samples only set equityClose. Open always chains from prior calendar close
  // so a lone post-trade sample still yields non-zero daily pnl.
  const samples = [...(equitySamples || [])].sort((a, b) => a.t - b.t);
  for (const s of samples) {
    const d = ensureDay(days, dayKey(s.t, tz));
    d.equityClose = s.equity;
  }
  const keys = [...days.keys()].sort();
  let prevClose = startEquity;
  for (const k of keys) {
    const d = days.get(k);
    d.equityOpen = prevClose;
    if (d.equityClose == null) {
      d.equityClose = d.equityOpen + d.realized + d.funding - d.openFees + d.transfer;
    }
    d.pnl = d.equityClose - d.equityOpen - d.transfer;
    prevClose = d.equityClose;
  }
  return days;
}

export function periodPnLStats(ledger, now = Date.now(), tz = 'Asia/Taipei') {
  const today = dayKey(now, tz);
  const sumRange = (daysBack) => {
    let s = 0;
    for (let i = 0; i < daysBack; i++) {
      const row = ledger.get(dayKey(now - i * 86400000, tz));
      if (row) s += row.pnl;
    }
    return s;
  };
  let cumulative = 0;
  for (const row of ledger.values()) cumulative += row.pnl;
  return {
    today: ledger.get(today)?.pnl ?? 0,
    d7: sumRange(7),
    d30: sumRange(30),
    cumulative,
    todayKey: today,
  };
}

export function aggregateCosts(fills = []) {
  let fees = 0;
  let funding = 0;
  for (const f of fills) {
    const amt = Number(f.feeUsdt) || 0;
    if (f.reason === 'funding' || f.side === 'funding' || f.liquidity === 'funding') {
      funding += amt;
    } else {
      fees += amt;
    }
  }
  return { fees, funding };
}

export function pickEquitySeries(samples = [], rangeKey = '30') {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  if (!sorted.length) return [];
  if (rangeKey === 'all') return sorted;
  const days = rangeKey === '7' ? 7 : rangeKey === '90' ? 90 : 30;
  const cut = Date.now() - days * 86400000;
  const filtered = sorted.filter((s) => s.t >= cut);
  return filtered.length ? filtered : sorted.slice(-2);
}

export function exportDailyStatementCsv(ledger) {
  const lines = ['date,pnl,realized,funding,openFees,closeFees,transfer,equityOpen,equityClose'];
  const keys = [...ledger.keys()].sort();
  for (const k of keys) {
    const d = ledger.get(k);
    lines.push([
      k,
      d.pnl.toFixed(4),
      d.realized.toFixed(4),
      d.funding.toFixed(4),
      d.openFees.toFixed(4),
      d.closeFees.toFixed(4),
      d.transfer.toFixed(4),
      Number(d.equityOpen).toFixed(4),
      Number(d.equityClose).toFixed(4),
    ].join(','));
  }
  return lines.join('\n');
}
