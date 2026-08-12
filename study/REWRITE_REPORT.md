# Anki Cards Rewrite Report

## Summary
- **Total cards:** 118
- **Cards rewritten (front or back changed):** 118
- **Cards marked corrected:** 117
- **Quiz eligible (back length ≥ 20):** 113
- **Output:** `/tmp/cards_rewritten.json`

## Ambiguous Cards (minimal interpretation chosen)

| ID | Topic | Interpretation |
|----|-------|----------------|
| 1770605680875 | OHLC vs OLHC | Original lists 假火打上面 for both OHLC and OLHC; kept verbatim wording without inferring OLHC sweeps lows. |
| 1770707359310 | SMT divergence | Original "a lower low b high lower" treated as typo for "B higher low" (bullish divergence). |
| 1770707672182 | DOL | Expanded minimally as internal liquidity sweep; full expansion "draw on liquidity" not in source. |
| 1770199889296 | TT times | "TT" not defined in source; kept BT/T1/T2/T3 times only as listed. |
| 1770712913056 | 噴火龍 | Kept nickname only; no extra setup rules added. |
| 1770718366318 | Auction metaphor | Preserved prior corrected colloquial metaphor card verbatim in meaning. |
| 1770711930189 | RSI | Preserved factual fix RSI>70=超買 from prior correction. |
| 1770711700489 | MACD | Preserved prior cleaned MACD rules without duplicate lines. |
| 1770712026622 | ATR | Preserved ATR (not "art") factual framing from prior correction. |

## Notes
- All cards retain original `id`, `chapter`, `lesson`, `sourceDeck`.
- English trading terms (BOS, CHoCH, FVG, iFVG, OB, HTF POI, RR, PO3, HVN, LVN, CVD, ATR, RSI, MACD, VWAP, SMT, CISD, DOL) preserved.
- T1/T2/T3 time tables and EDT/EST +1h notes preserved where present.
