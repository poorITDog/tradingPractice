// Ranked ladder: Bronze → Challenger with LP (see RANKING.md).

import { clamp } from './money.js';
import { abilityScore, maxDrawdownPct } from './analytics.js';

export const TIER_ORDER = [
  'bronze', 'silver', 'gold', 'platinum', 'diamond', 'master', 'grandmaster', 'challenger',
];

export const TIER_LABEL = {
  bronze: '青銅',
  silver: '白銀',
  gold: '黃金',
  platinum: '白金',
  diamond: '鑽石',
  master: '大師',
  grandmaster: '宗師',
  challenger: '菁英',
};

export const DIV_ORDER = ['IV', 'III', 'II', 'I'];

export function defaultLadder() {
  return {
    tier: 'bronze',
    division: 'IV',
    lp: 0,
    bestLp: 0,
    promoWins: [], // recent qualifying challenges: { lpDelta, score, at }
    history: [], // last results
  };
}

export function tierIndex(tier) {
  return TIER_ORDER.indexOf(tier);
}

export function formatRank(ladder) {
  if (!ladder) return '青銅 IV';
  const name = TIER_LABEL[ladder.tier] || '青銅';
  if (tierIndex(ladder.tier) >= tierIndex('master')) {
    return `${name} · ${Math.floor(ladder.lp)} 積分`;
  }
  return `${name} ${ladder.division} · ${Math.floor(ladder.lp)} / 100 積分`;
}

export function displayTier(ladder) {
  // Solo Master+ thresholds by continuous LP.
  if (!ladder) return { tier: 'bronze', division: 'IV' };
  if (tierIndex(ladder.tier) < tierIndex('master')) {
    return { tier: ladder.tier, division: ladder.division };
  }
  const lp = ladder.lp;
  if (lp >= 500) return { tier: 'challenger', division: null };
  if (lp >= 300) return { tier: 'grandmaster', division: null };
  return { tier: 'master', division: null };
}

function isDustTrade(t, startEquity) {
  const floor = Math.max(0.01, startEquity * 0.0005);
  return Math.abs(t.pnlUsdt) < floor;
}

export function filterValidTrades(trades, startEquity) {
  return (trades || []).filter((t) => !isDustTrade(t, startEquity));
}

export function sampleQuality({ trades, startEquity, challenge, now = Date.now() }) {
  const valid = filterValidTrades(trades, startEquity);
  if (valid.length < 10) {
    return {
      ok: false,
      reason: 'trades',
      message: '樣本不足：需要至少 10 筆有效平倉（單筆盈虧達起始資金 0.05%）。',
      valid,
    };
  }
  let turnover = 0;
  let holdMs = 0;
  for (const t of valid) {
    turnover += Math.abs(t.entry * t.qty) + Math.abs(t.exit * t.qty);
    holdMs += Math.max(0, (t.closedAt || 0) - (t.openedAt || 0));
  }
  if (turnover < startEquity * 2) {
    return {
      ok: false,
      reason: 'turnover',
      message: '樣本不足：名義成交額需至少為起始資金的 2 倍。',
      valid,
    };
  }
  if (holdMs < 6 * 3600 * 1000) {
    return {
      ok: false,
      reason: 'hold',
      message: '樣本不足：合計持倉時間需至少 6 小時。',
      valid,
    };
  }
  const early = challenge && (now - challenge.startedAt) < 48 * 3600 * 1000;
  return { ok: true, valid, earlySettle: !!early };
}

function baseLpFromScore(score) {
  if (score >= 85) return 28;
  if (score >= 75) return 18;
  if (score >= 65) return 10;
  if (score >= 55) return 4;
  if (score >= 45) return 0;
  if (score >= 35) return -12;
  return -22;
}

export function computeLpDelta({
  score, parts, trades, equitySamples, startEquity,
}) {
  let delta = baseLpFromScore(score);
  const D = parts?.D ?? maxDrawdownPct(equitySamples || []);
  if (D <= 10) delta += 3;
  if (D >= 30) delta -= 5;

  const n = trades.length || 1;
  let levSum = 0;
  let tpSl = 0;
  let liqs = 0;
  for (const t of trades) {
    levSum += t.leverage || 1;
    if (t.hadTp && t.hadSl) tpSl += 1;
    if (t.reason === 'liquidation') liqs += 1;
  }
  const avgLev = levSum / n;
  if (avgLev >= 15) delta -= 3;
  if (avgLev >= 25) delta -= 5;
  if (liqs >= 1) delta -= 10;
  if (liqs >= 2) delta -= 8;
  if (tpSl / n >= 0.7) delta += 2;

  return clamp(delta, -35, 32);
}

function bumpDivision(ladder, dir) {
  // dir +1 promote small step, -1 demote
  const ti = tierIndex(ladder.tier);
  if (ti >= tierIndex('master')) {
    return ladder;
  }
  const di = DIV_ORDER.indexOf(ladder.division);
  if (dir > 0) {
    if (di < DIV_ORDER.length - 1) {
      ladder.division = DIV_ORDER[di + 1];
      return ladder;
    }
    // At I — caller handles promo series before calling bump to next tier
    const next = TIER_ORDER[ti + 1];
    if (!next) return ladder;
    ladder.tier = next;
    ladder.division = next === 'master' || tierIndex(next) >= tierIndex('master') ? null : 'IV';
    if (tierIndex(ladder.tier) >= tierIndex('master')) {
      ladder.division = null;
    }
    return ladder;
  }
  // demote
  if (di > 0) {
    ladder.division = DIV_ORDER[di - 1];
    return ladder;
  }
  if (ti <= 0) {
    ladder.tier = 'bronze';
    ladder.division = 'IV';
    ladder.lp = 0;
    return ladder;
  }
  const prev = TIER_ORDER[ti - 1];
  ladder.tier = prev;
  ladder.division = 'I';
  return ladder;
}

export function canPromoteFromI(ladder, thisResult) {
  // Need 2 of last 3 qualifying with lpDelta>0 and avg score >= 60
  const merged = [...(ladder.promoWins || [])];
  if (thisResult) merged.push(thisResult);
  const recent = merged
    .filter((x) => x && x.qualifying)
    .slice(-3);
  if (recent.length < 3) return { ok: false, wins: recent.filter((r) => r.lpDelta > 0).length, avg: avgScore(recent), need: 3 - recent.length };
  const wins = recent.filter((r) => r.lpDelta > 0).length;
  const avg = avgScore(recent);
  return { ok: wins >= 2 && avg >= 60, wins, avg, need: 0, recent };
}

function avgScore(rows) {
  if (!rows.length) return 0;
  return rows.reduce((s, r) => s + (r.score || 0), 0) / rows.length;
}

export function applyLp(ladder, lpDelta, meta = {}) {
  const next = {
    ...ladder,
    promoWins: [...(ladder.promoWins || [])],
    history: [...(ladder.history || [])],
  };
  const atI = next.division === 'I' && tierIndex(next.tier) < tierIndex('master');
  const qualifying = meta.qualifying !== false;

  if (tierIndex(next.tier) >= tierIndex('master')) {
    next.lp = Math.max(0, next.lp + lpDelta);
    next.bestLp = Math.max(next.bestLp || 0, next.lp);
    // Snap display tier via thresholds is handled in displayTier
    if (next.lp >= 500) next.tier = 'challenger';
    else if (next.lp >= 300) next.tier = 'grandmaster';
    else next.tier = 'master';
    next.division = null;
  } else {
    next.lp += lpDelta;
    // Promote
    if (next.lp >= 100) {
      if (atI) {
        const promo = canPromoteFromI(next, {
          lpDelta, score: meta.score || 0, qualifying, at: meta.at || Date.now(),
        });
        if (promo.ok) {
          next.lp -= 100;
          bumpDivision(next, +1);
          next.promoWins = [];
          meta.promoted = true;
        } else {
          next.lp = 99; // soft cap until promo clears
          meta.promoBlocked = promo;
        }
      } else {
        next.lp -= 100;
        bumpDivision(next, +1);
        meta.promoted = true;
      }
    }
    // Demote
    if (next.lp < 0) {
      if (next.tier === 'bronze' && next.division === 'IV') {
        next.lp = 0;
      } else {
        next.lp += 100;
        bumpDivision(next, -1);
        meta.demoted = true;
      }
    }
  }

  if (qualifying) {
    next.promoWins = [...next.promoWins, {
      lpDelta, score: meta.score || 0, qualifying: true, at: meta.at || Date.now(),
    }].slice(-10);
  }
  next.history = [{
    at: meta.at || Date.now(),
    lpDelta,
    score: meta.score,
    tier: next.tier,
    division: next.division,
    lp: next.lp,
    message: meta.message,
  }, ...next.history].slice(0, 20);

  next.bestLp = Math.max(next.bestLp || 0, continuousLp(next));
  return { ladder: next, meta };
}

function continuousLp(ladder) {
  if (tierIndex(ladder.tier) >= tierIndex('master')) return ladder.lp;
  // Rough continuum for best tracking
  const ti = tierIndex(ladder.tier);
  const di = Math.max(0, DIV_ORDER.indexOf(ladder.division));
  return ti * 400 + di * 100 + ladder.lp;
}

export function nextRankHint(ladder) {
  if (!ladder) return '開始一場排位賽以取得積分。';
  const shown = displayTier(ladder);
  if (tierIndex(shown.tier) >= tierIndex('master')) {
    if (shown.tier === 'challenger') return '已達菁英。保持積分以免掉出門檻（500）。';
    if (shown.tier === 'grandmaster') {
      return `再取得 ${Math.max(0, 500 - ladder.lp)} 積分可顯示為菁英。`;
    }
    return `再取得 ${Math.max(0, 300 - ladder.lp)} 積分可顯示為宗師。`;
  }
  if (ladder.division === 'I') {
    const promo = canPromoteFromI(ladder, null);
    const recent = (ladder.promoWins || []).filter((x) => x.qualifying).slice(-3);
    const wins = recent.filter((r) => r.lpDelta > 0).length;
    const avg = avgScore(recent);
    const nextName = TIER_LABEL[TIER_ORDER[tierIndex(ladder.tier) + 1]] || '下一階';
    return `晉級賽進行中（通往${nextName}）：近 ${recent.length}/3 場 · 加分 ${wins}/2 · 平均能力分 ${avg.toFixed(0)}/60。積分在 I 階最高保留 99，直到晉級成功。`;
  }
  const di = DIV_ORDER.indexOf(ladder.division);
  const nextDiv = DIV_ORDER[di + 1];
  const need = 100 - ladder.lp;
  return `再取得 ${need} 積分可升至 ${TIER_LABEL[ladder.tier]} ${nextDiv}。`;
}

export function settleRankedChallenge({
  challenge, trades, equitySamples, startEquity, ladder, now = Date.now(),
}) {
  const quality = sampleQuality({ trades, startEquity, challenge, now });
  const base = abilityScore({
    trades: quality.valid, equitySamples, startEquity,
  });

  if (!quality.ok) {
    return {
      ok: true,
      sampleOk: false,
      message: quality.message,
      score: null,
      lpDelta: 0,
      ladder,
      entryExtras: { sampleOk: false, message: quality.message },
    };
  }
  if (!base.ok) {
    return {
      ok: true,
      sampleOk: false,
      message: '樣本不足：需要至少 10 筆有效平倉（單筆盈虧達起始資金 0.05%）。',
      score: null,
      lpDelta: 0,
      ladder,
      entryExtras: { sampleOk: false },
    };
  }

  let lpDelta = computeLpDelta({
    score: base.score,
    parts: base.parts,
    trades: quality.valid,
    equitySamples,
    startEquity,
  });
  let earlyNote = null;
  if (quality.earlySettle) {
    lpDelta = Math.min(0, lpDelta);
    earlyNote = '開賽未滿 48 小時：本場只能扣分、不能加分。';
  }

  const meta = { score: base.score, at: now, qualifying: true };
  const applied = applyLp({ ...ladder }, lpDelta, meta);
  const shown = displayTier(applied.ladder);
  const sign = lpDelta > 0 ? `+${lpDelta}` : `${lpDelta}`;
  let message = `能力分 ${base.score.toFixed(1)} · 積分 ${sign} · 目前 ${formatRank(applied.ladder)}`;
  if (earlyNote) message = `${earlyNote} ${message}`;
  if (meta.promoted) {
    message += ` · 晉級成功：進入 ${TIER_LABEL[applied.ladder.tier]}${applied.ladder.division ? ' ' + applied.ladder.division : ''}`;
  } else if (meta.promoBlocked) {
    message += ' · 積分已滿，晉級賽尚未通過（加分場次或平均能力分不足）';
  }

  return {
    ok: true,
    sampleOk: true,
    score: base.score,
    parts: base.parts,
    lpDelta,
    ladder: applied.ladder,
    display: shown,
    message,
    earlyNote,
    entryExtras: {
      sampleOk: true,
      lpDelta,
      ladderAfter: {
        tier: applied.ladder.tier,
        division: applied.ladder.division,
        lp: applied.ladder.lp,
      },
      displayTier: shown,
    },
  };
}
