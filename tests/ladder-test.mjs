import assert from 'node:assert/strict';
import {
  defaultLadder, computeLpDelta, applyLp, sampleQuality, settleRankedChallenge,
  formatRank, displayTier, nextRankHint,
} from '../lib/ladder.js';

// LP table anchors
assert.equal(computeLpDelta({
  score: 90, parts: { D: 5 }, trades: [
    { leverage: 3, hadTp: true, hadSl: true, pnlUsdt: 10 },
    { leverage: 3, hadTp: true, hadSl: true, pnlUsdt: 10 },
  ], equitySamples: [], startEquity: 50000,
}), 32); // 28+3+2 clamped to +32

assert.equal(computeLpDelta({
  score: 50, parts: { D: 15 }, trades: [
    { leverage: 5, hadTp: false, hadSl: false, pnlUsdt: 1 },
  ], equitySamples: [], startEquity: 50000,
}), 0);

assert.ok(computeLpDelta({
  score: 20, parts: { D: 40 }, trades: [
    { leverage: 30, hadTp: false, hadSl: false, pnlUsdt: -100, reason: 'liquidation' },
    { leverage: 30, hadTp: false, hadSl: false, pnlUsdt: -100, reason: 'liquidation' },
  ], equitySamples: [], startEquity: 50000,
}) <= -22);

// Bronze floor
let ladder = defaultLadder();
let r = applyLp(ladder, -20, { score: 20, qualifying: true });
assert.equal(r.ladder.tier, 'bronze');
assert.equal(r.ladder.division, 'IV');
assert.equal(r.ladder.lp, 0);

// Promote small division
ladder = defaultLadder();
ladder.lp = 90;
r = applyLp(ladder, 15, { score: 70, qualifying: true });
assert.equal(r.ladder.division, 'III');
assert.equal(r.ladder.lp, 5);

// Sample quality dust filter
const start = 50000;
const dust = Array.from({ length: 12 }, (_, i) => ({
  pnlUsdt: 0.01,
  entry: 100,
  exit: 100,
  qty: 0.001,
  openedAt: 0,
  closedAt: 1000,
}));
assert.equal(sampleQuality({ trades: dust, startEquity: start }).ok, false);

const good = Array.from({ length: 12 }, (_, i) => ({
  pnlUsdt: 200,
  entry: 50000,
  exit: 51000,
  qty: 0.2, // turnover ~ 12 * (50000+51000)*0.2 ≈ 242k > 100k
  leverage: 5,
  hadTp: true,
  hadSl: true,
  openedAt: i * 2 * 3600 * 1000,
  closedAt: i * 2 * 3600 * 1000 + 2 * 3600 * 1000,
}));
const eq = good.reduce((arr, t, i) => {
  const last = arr[arr.length - 1].equity;
  arr.push({ t: i + 1, equity: last + t.pnlUsdt });
  return arr;
}, [{ t: 0, equity: 50000 }]);

const ch = {
  startedAt: Date.now() - 3 * 24 * 3600 * 1000,
  status: 'active',
};
const settled = settleRankedChallenge({
  challenge: ch,
  trades: good,
  equitySamples: eq,
  startEquity: 50000,
  ladder: defaultLadder(),
});
assert.equal(settled.sampleOk, true);
assert.ok(settled.lpDelta > 0);
assert.ok(formatRank(settled.ladder).includes('青銅') || formatRank(settled.ladder).includes('白銀'));

// Early settle cannot gain LP
const earlyCh = { startedAt: Date.now() - 1000, status: 'active' };
const early = settleRankedChallenge({
  challenge: earlyCh,
  trades: good,
  equitySamples: eq,
  startEquity: 50000,
  ladder: defaultLadder(),
});
assert.ok(early.lpDelta <= 0);
assert.ok(early.earlyNote);

// Master thresholds display
const master = { tier: 'master', division: null, lp: 320, promoWins: [], history: [] };
assert.equal(displayTier(master).tier, 'grandmaster');
master.lp = 520;
assert.equal(displayTier(master).tier, 'challenger');

assert.ok(nextRankHint(defaultLadder()).includes('積分'));

console.log('ladder-test OK');
