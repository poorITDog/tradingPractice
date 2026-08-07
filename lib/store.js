// Persist Apex state in localStorage with schema validation + backup.

import { defaultLadder } from './ladder.js';

const KEY = 'apex-v1';
const BAK = 'apex-v1.bak';
export const SCHEMA_VERSION = 2;

export function defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: {
      startBalance: 50000,
      makerFee: 0.0002,
      takerFee: 0.00055,
      beginnerCap: true,
      maxLeverageCap: 5,
      coachDone: false,
      dataSource: 'auto',
      mildLabels: false,
      googleClientId: '',
      googleConnected: false,
      autoSync: true,
    },
    account: null,
    closedTrades: [],
    equitySamples: [],
    challenge: null,
    leaderboard: [],
    ladder: defaultLadder(),
    ui: { symbol: 'BTCUSDT', interval: '5', entered: false },
    syncUpdatedAt: 0,
  };
}

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function migrateState(raw) {
  if (!isObj(raw)) return null;
  const base = defaultState();
  const s = { ...base, ...raw };
  s.schemaVersion = SCHEMA_VERSION;
  if (!s.ladder) s.ladder = defaultLadder();
  if (!Array.isArray(s.closedTrades)) s.closedTrades = [];
  if (!Array.isArray(s.leaderboard)) s.leaderboard = [];
  s.settings = { ...base.settings, ...(isObj(raw.settings) ? raw.settings : {}) };
  s.ui = { ...base.ui, ...(isObj(raw.ui) ? raw.ui : {}) };
  if (s.account) {
    if (typeof s.account.walletMicros === 'number') {
      s.account.walletMicros = BigInt(Math.round(s.account.walletMicros));
    }
    if (typeof s.account.startMicros === 'number') {
      s.account.startMicros = BigInt(Math.round(s.account.startMicros));
    }
  }
  return s;
}

export function validateState(raw) {
  if (!isObj(raw)) return { ok: false, reason: 'not object' };
  if (raw.schemaVersion !== 1 && raw.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, reason: 'schema' };
  }
  if (!isObj(raw.settings)) return { ok: false, reason: 'settings' };
  if (!Array.isArray(raw.closedTrades)) return { ok: false, reason: 'closedTrades' };
  if (!Array.isArray(raw.leaderboard)) return { ok: false, reason: 'leaderboard' };
  return { ok: true };
}

export function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') return { __bigint: value.toString() };
  return value;
}

export function jsonReviver(_key, value) {
  if (value && typeof value === 'object' && value.__bigint != null) {
    return BigInt(value.__bigint);
  }
  return value;
}

// Plain JSON-safe clone for Drive upload (bigint → {__bigint}).
export function toPlainState(state) {
  return JSON.parse(JSON.stringify(state, jsonReplacer));
}

export function fromPlainState(plain) {
  return migrateState(JSON.parse(JSON.stringify(plain), jsonReviver));
}

export function loadState() {
  try {
    const text = localStorage.getItem(KEY);
    if (!text) return { state: defaultState(), recovered: false };
    const parsed = JSON.parse(text, jsonReviver);
    const v = validateState(parsed);
    if (!v.ok) {
      const bak = localStorage.getItem(BAK);
      if (bak) {
        const bp = JSON.parse(bak, jsonReviver);
        if (validateState(bp).ok) {
          return { state: migrateState(bp), recovered: true, reason: v.reason };
        }
      }
      return { state: defaultState(), recovered: true, reason: v.reason };
    }
    const state = migrateState(parsed);
    if (state.account) {
      if (typeof state.account.walletMicros === 'number') {
        state.account.walletMicros = BigInt(Math.round(state.account.walletMicros));
      }
      if (typeof state.account.startMicros === 'number') {
        state.account.startMicros = BigInt(Math.round(state.account.startMicros));
      }
    }
    return { state, recovered: false };
  } catch (e) {
    return { state: defaultState(), recovered: true, reason: String(e) };
  }
}

export function saveState(state) {
  let text;
  try {
    text = JSON.stringify(state, jsonReplacer);
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
  try {
    const prev = localStorage.getItem(KEY);
    if (prev) localStorage.setItem(BAK, prev);
    localStorage.setItem(KEY, text);
    return { ok: true };
  } catch (e) {
    if (e && e.name === 'QuotaExceededError') {
      return { ok: false, reason: 'quota' };
    }
    return { ok: false, reason: String(e) };
  }
}

export function exportState(state) {
  return JSON.stringify(state, jsonReplacer, 2);
}

export function importState(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText, jsonReviver);
  } catch (e) {
    return { ok: false, reason: 'json' };
  }
  const v = validateState(parsed);
  if (!v.ok) return { ok: false, reason: v.reason };
  return { ok: true, state: migrateState(parsed) };
}
