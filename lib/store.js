// Persist Apex state in localStorage with schema validation + backup.

const KEY = 'apex-v1';
const BAK = 'apex-v1.bak';
export const SCHEMA_VERSION = 1;

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
    },
    account: null,
    closedTrades: [],
    equitySamples: [],
    challenge: null,
    leaderboard: [],
    ui: { symbol: 'BTCUSDT', interval: '5', entered: false },
  };
}

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function validateState(raw) {
  if (!isObj(raw)) return { ok: false, reason: 'not object' };
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, reason: 'schema' };
  }
  if (!isObj(raw.settings)) return { ok: false, reason: 'settings' };
  if (!Array.isArray(raw.closedTrades)) return { ok: false, reason: 'closedTrades' };
  if (!Array.isArray(raw.leaderboard)) return { ok: false, reason: 'leaderboard' };
  return { ok: true };
}

function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') return { __bigint: value.toString() };
  return value;
}

function jsonReviver(_key, value) {
  if (value && typeof value === 'object' && value.__bigint != null) {
    return BigInt(value.__bigint);
  }
  return value;
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
          return { state: bp, recovered: true, reason: v.reason };
        }
      }
      return { state: defaultState(), recovered: true, reason: v.reason };
    }
    // Revive wallet fields if older saves stored numbers.
    if (parsed.account) {
      if (typeof parsed.account.walletMicros === 'number') {
        parsed.account.walletMicros = BigInt(Math.round(parsed.account.walletMicros));
      }
      if (typeof parsed.account.startMicros === 'number') {
        parsed.account.startMicros = BigInt(Math.round(parsed.account.startMicros));
      }
    }
    return { state: parsed, recovered: false };
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
  return { ok: true, state: parsed };
}
