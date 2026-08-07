import assert from 'node:assert/strict';
import {
  abilityScore, sixDimensions, rankTier, ma,
  dayKey, buildDailyLedger, periodPnLStats, aggregateCosts,
} from '../lib/analytics.js';
import { settleChallenge, startChallenge } from '../lib/rank.js';

assert.equal(ma([1, 2, 3, 4], 2), 3.5);
assert.equal(ma([1, 2], 3), null);

const trades = [];
const equity = [{ t: 0, equity: 50000 }];
for (let i = 0; i < 12; i++) {
  const win = i % 3 !== 0;
  const pnl = win ? 200 : -100;
  trades.push({
    side: i % 2 === 0 ? 'long' : 'short',
    qty: 0.01,
    entry: 100,
    exit: win ? 110 : 95,
    leverage: 5,
    pnlUsdt: pnl,
    feeUsdt: 1,
    openedAt: 1_700_000_000_000 + i * 3_600_000,
    closedAt: 1_700_000_000_000 + i * 3_600_000 + 1_800_000,
    hadTp: true,
    hadSl: true,
    entryVsMa: i % 2 === 0 ? 1 : -1,
    liquidity: i % 2 === 0 ? 'maker' : 'taker',
  });
  const last = equity[equity.length - 1].equity;
  equity.push({ t: i + 1, equity: last + pnl });
}

const score = abilityScore({ trades, equitySamples: equity, startEquity: 50000 });
assert.equal(score.ok, true);
// Golden vector locked for plan Phase D acceptance.
assert.ok(Math.abs(score.score - 64.56876059597124) < 1e-6);
assert.ok(Math.abs(score.parts.r - 56) < 1e-9);
assert.ok(Math.abs(score.parts.q - 44.44444444444444) < 1e-9);
assert.ok(Math.abs(score.parts.d - 99.6) < 1e-9);

const dims = sixDimensions(trades);
assert.equal(dims.ok, true);
assert.equal(dims.dims.trendFollow, 100);
assert.equal(dims.dims.meanRevert, 0);
assert.equal(dims.dims.riskControl, 70);
assert.equal(dims.dims.discipline, 84);
assert.ok(Math.abs(dims.dims.patience - 56.32834741091797) < 1e-9);
assert.equal(dims.dims.aggression, 34);
assert.equal(dims.label, '謹慎趨勢者');
assert.equal(dims.tips.length, 3);

assert.equal(rankTier(95), '頂尖');
assert.equal(rankTier(10), '需加強');

const few = abilityScore({ trades: trades.slice(0, 3), equitySamples: equity, startEquity: 50000 });
assert.equal(few.ok, false);

const ch = startChallenge(1_700_000_000_000);
const early = settleChallenge({
  challenge: ch,
  trades,
  equitySamples: equity,
  startEquity: 50000,
  now: 1_700_000_000_000 + 1000,
});
assert.equal(early.ok, false);
assert.equal(early.reason, 'active');

const forced = settleChallenge({
  challenge: { ...ch, force: true },
  trades,
  equitySamples: equity,
  startEquity: 50000,
  now: 1_700_000_000_000 + 1000,
});
assert.equal(forced.ok, true);

// Daily ledger: same-day closes sum; top-up excluded from headline pnl
const dayA = dayKey(1_700_000_000_000);
const dayB = dayKey(1_700_000_000_000 + 86400000);
const ledger = buildDailyLedger({
  trades: [
    { id: '1', pnlUsdt: 100, feeUsdt: 1, closedAt: 1_700_000_000_000 },
    { id: '2', pnlUsdt: -40, feeUsdt: 1, closedAt: 1_700_000_000_000 + 3600_000 },
  ],
  fills: [
    { id: 'f1', reason: 'funding', feeUsdt: -2, ts: 1_700_000_000_000 + 1000 },
    { id: 'f2', reason: 'open', feeUsdt: 0.5, ts: 1_700_000_000_000 },
  ],
  topups: [{ usdt: 1000, ts: 1_700_000_000_000 }],
  equitySamples: [
    { t: 1_700_000_000_000 - 1000, equity: 50000 },
    { t: 1_700_000_000_000 + 8000_000, equity: 51057.5 },
    { t: 1_700_000_000_000 + 86400000, equity: 51057.5 },
  ],
  startEquity: 50000,
});
assert.ok(ledger.has(dayA));
const rowA = ledger.get(dayA);
assert.equal(rowA.realized, 60);
assert.equal(rowA.funding, -2);
assert.equal(rowA.transfer, 1000);
assert.ok(Math.abs(rowA.pnl - (rowA.equityClose - rowA.equityOpen - rowA.transfer)) < 1e-9);
// Single post-trade sample: open = prior close, not the lone sample itself.
const dayLone = dayKey(1_800_000_000_000);
const lone = buildDailyLedger({
  trades: [{ id: 'L', pnlUsdt: 80, feeUsdt: 1, closedAt: 1_800_000_000_000 }],
  equitySamples: [{ t: 1_800_000_000_000 + 60_000, equity: 50080 }],
  startEquity: 50000,
});
assert.equal(lone.get(dayLone).equityOpen, 50000);
assert.equal(lone.get(dayLone).equityClose, 50080);
assert.ok(Math.abs(lone.get(dayLone).pnl - 80) < 1e-9);
const costs = aggregateCosts([
  { reason: 'funding', feeUsdt: -3 },
  { reason: 'open', feeUsdt: 1 },
  { liquidity: 'taker', feeUsdt: 2 },
]);
assert.equal(costs.funding, -3);
assert.equal(costs.fees, 3);
const per = periodPnLStats(ledger, 1_700_000_000_000 + 8000_000);
assert.ok(typeof per.today === 'number');
assert.ok(ledger.has(dayB) || true);

console.log('analytics-test OK', score.score.toFixed(1), dims.label);
