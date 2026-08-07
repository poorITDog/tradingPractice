// Integer money helpers (USDT micros = 1e-6). No raw float ledger math.

export const USDT_MICROS = 1_000_000n;
export const PRICE_SCALE = 1_000_000_000n; // 1e9 price units

export function toMicros(usdt) {
  if (typeof usdt === 'bigint') return usdt;
  const n = Number(usdt);
  if (!Number.isFinite(n)) throw new Error('invalid usdt');
  return BigInt(Math.round(n * 1e6));
}

export function fromMicros(micros) {
  return Number(micros) / 1e6;
}

export function toPriceUnits(price) {
  const n = Number(price);
  if (!Number.isFinite(n)) throw new Error('invalid price');
  return BigInt(Math.round(n * 1e9));
}

export function fromPriceUnits(units) {
  return Number(units) / 1e9;
}

export function mulDiv(a, b, d) {
  return (a * b) / d;
}

// Floor qty to lot step (both as numbers in base coin).
export function floorToLot(qty, lotSize) {
  if (!(lotSize > 0)) return 0;
  const steps = Math.floor(qty / lotSize + 1e-12);
  return steps * lotSize;
}

export function roundToTick(price, tickSize) {
  if (!(tickSize > 0)) return price;
  const steps = Math.round(price / tickSize);
  return steps * tickSize;
}

export function formatUsdt(micros, digits = 2) {
  return fromMicros(micros).toFixed(digits);
}

export function formatPrice(price, digits = 2) {
  return Number(price).toFixed(digits);
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
