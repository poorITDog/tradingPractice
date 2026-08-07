import assert from 'node:assert/strict';
import { syncContentWeight, mergeDriveState, DRIVE_FILE } from '../lib/drive.js';
import { defaultState, toPlainState, fromPlainState } from '../lib/store.js';

assert.equal(DRIVE_FILE, 'apex-trade-lab-v1.json');

const empty = defaultState();
assert.equal(syncContentWeight(empty), 0);

const heavy = defaultState();
heavy.closedTrades = [{ id: 'tr1', closedAt: 1, pnlUsdt: 1 }];
heavy.account = {
  walletMicros: 1n,
  startMicros: 1n,
  positions: { BTCUSDT: { symbol: 'BTCUSDT', qty: 1 } },
  fills: [{ id: 'f1' }],
  orders: [],
  events: [],
};
heavy.ladder = { ...heavy.ladder, lp: 40 };
assert.ok(syncContentWeight(heavy) > 0);

// Empty must not win weight over cloud with trades
assert.ok(syncContentWeight(empty) < syncContentWeight(heavy));

const local = defaultState();
local.syncUpdatedAt = 2000;
local.closedTrades = [{ id: 'a', closedAt: 10 }];
local.settings.googleClientId = 'local-client';
local.settings.googleConnected = true;

const remote = defaultState();
remote.syncUpdatedAt = 1000;
remote.closedTrades = [{ id: 'b', closedAt: 20 }];
remote.settings.googleClientId = 'remote-client';

const merged = mergeDriveState(local, remote);
assert.ok(merged.closedTrades.some((t) => t.id === 'a'));
assert.ok(merged.closedTrades.some((t) => t.id === 'b'));
assert.equal(merged.settings.googleClientId, 'local-client');
assert.equal(merged.settings.googleConnected, true);

// bigint round-trip for Drive payload
const plain = toPlainState(heavy);
assert.ok(plain.account.walletMicros.__bigint);
const back = fromPlainState(plain);
assert.equal(back.account.walletMicros, 1n);

console.log('drive-test OK');
