// Challenge (ranked match) + local leaderboard.

import { abilityScore, sixDimensions } from './analytics.js';
import { defaultLadder, settleRankedChallenge, formatRank } from './ladder.js';

export const CHALLENGE_MS = 7 * 24 * 60 * 60 * 1000;

export function startChallenge(now = Date.now()) {
  return {
    id: 'ch_' + now.toString(36),
    startedAt: now,
    endsAt: now + CHALLENGE_MS,
    startBalance: 50000,
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    allowReset: false,
    allowTopUp: false,
    status: 'active',
  };
}

export function challengeRemaining(ch, now = Date.now()) {
  if (!ch || ch.status !== 'active') return 0;
  return Math.max(0, ch.endsAt - now);
}

export function settleChallenge({
  challenge, trades, equitySamples, startEquity, ladder, now = Date.now(),
}) {
  if (!challenge || challenge.status !== 'active') {
    return { ok: false, reason: 'inactive' };
  }
  if (now < challenge.endsAt && challenge.force !== true) {
    return { ok: false, reason: 'active' };
  }

  const ranked = settleRankedChallenge({
    challenge,
    trades,
    equitySamples,
    startEquity,
    ladder: ladder || defaultLadder(),
    now,
  });

  const dims = sixDimensions(ranked.sampleOk
    ? trades.filter((t) => Math.abs(t.pnlUsdt) >= startEquity * 0.0005)
    : trades);

  const entry = {
    id: challenge.id,
    settledAt: now,
    score: ranked.score,
    tier: ranked.display
      ? formatRank({
        tier: ranked.display.tier,
        division: ranked.display.division || 'IV',
        lp: ranked.ladder?.lp ?? 0,
      })
      : '樣本不足',
    returnPct: ranked.parts ? ranked.parts.R : null,
    trades: trades.length,
    sampleOk: ranked.sampleOk,
    parts: ranked.parts || null,
    dims: dims.ok ? dims.dims : null,
    label: dims.label,
    lpDelta: ranked.lpDelta || 0,
    message: ranked.message,
    ladderAfter: ranked.entryExtras?.ladderAfter || null,
  };

  return {
    ok: true,
    entry,
    ladder: ranked.ladder,
    ranked,
    challenge: { ...challenge, status: 'settled', settledAt: now },
  };
}

export function pushLeaderboard(board, entry, limit = 50) {
  if (!entry.sampleOk || entry.score == null) {
    return { board, accepted: false, reason: 'sample' };
  }
  const next = [...board, entry]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return { board: next, accepted: true };
}

export function exportScoreCard(entry) {
  return JSON.stringify({
    v: 2,
    app: 'Apex Trade Lab',
    disclaimer: '本機練習指標，可能被竄改，非金融資格。',
    entry,
  }, null, 2);
}

export { defaultLadder, formatRank };
