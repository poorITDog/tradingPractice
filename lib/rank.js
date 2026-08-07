// Challenge mode + local leaderboard.

import { abilityScore, rankTier, sixDimensions } from './analytics.js';

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

export function settleChallenge({ challenge, trades, equitySamples, startEquity, now = Date.now() }) {
  if (!challenge || challenge.status !== 'active') {
    return { ok: false, reason: 'inactive' };
  }
  if (now < challenge.endsAt && challenge.force !== true) {
    return { ok: false, reason: 'active' };
  }
  const scoreRes = abilityScore({ trades, equitySamples, startEquity });
  const dims = sixDimensions(trades);
  const entry = {
    id: challenge.id,
    settledAt: now,
    score: scoreRes.ok ? scoreRes.score : null,
    tier: rankTier(scoreRes.ok ? scoreRes.score : null),
    returnPct: scoreRes.ok ? scoreRes.parts.R : null,
    trades: trades.length,
    sampleOk: scoreRes.ok,
    parts: scoreRes.parts || null,
    dims: dims.ok ? dims.dims : null,
    label: dims.label,
  };
  return {
    ok: true,
    entry,
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
    v: 1,
    app: 'Apex Trade Lab',
    disclaimer: 'Local practice metric only; may be tampered.',
    entry,
  }, null, 2);
}
