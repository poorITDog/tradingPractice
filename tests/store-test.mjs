import assert from 'node:assert/strict';
import { defaultState, validateState, importState, exportState, saveState, loadState } from '../lib/store.js';

const s = defaultState();
assert.equal(validateState(s).ok, true);
assert.equal(validateState({}).ok, false);

s.account = {
  walletMicros: 50000000000n,
  startMicros: 50000000000n,
  positions: {},
  orders: [],
  fills: [],
  events: [],
  lastFundingSettle: {},
};
const text = exportState(s);
assert.ok(text.includes('__bigint'));
const imp = importState(text);
assert.equal(imp.ok, true);
assert.equal(imp.state.schemaVersion, 2);
assert.ok(imp.state.ladder);
assert.equal(imp.state.account.walletMicros, 50000000000n);

assert.equal(importState('{bad').ok, false);

// Round-trip through localStorage shim if available
if (typeof localStorage === 'undefined') {
  globalThis.localStorage = {
    _d: {},
    getItem(k) { return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = String(v); },
  };
}
assert.equal(saveState(s).ok, true);
const loaded = loadState();
assert.equal(loaded.state.account.walletMicros, 50000000000n);
console.log('store-test OK');
