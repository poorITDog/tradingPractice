# Apex Trade Lab

真實行情 · 零風險永續模擬練習。六維風格雷達 + **青銅→菁英**段位排位賽。

**非 Bybit 產品。** 模擬資金，不是投資建議。

Repo：[`poorITDog/tradingPractice`](https://github.com/poorITDog/tradingPractice)

## 開啟

```bash
python3 -m http.server 8765
# http://localhost:8765/
```

GitHub Pages（啟用後）：`https://pooritdog.github.io/tradingPractice/`

## 段位怎麼升？

**打排位賽 → 得到能力分 → 加減積分（LP）→ 滿 100 升一小段。**

階梯：青銅 → 白銀 → 黃金 → 白金 → 鑽石（各 IV–I）→ 大師 → 宗師（≥300）→ 菁英（≥500）。

詳細規則：[`RANKING.md`](RANKING.md)

## 功能摘要

- 交易：真實行情、訂單簿、市價／限價、槓桿、止盈停損、只減倉
- 資產：權益曲線、回撤／Sharpe／勝率
- 分析：六維雷達 + 能力分
- 段位：排位賽、積分升降、本機榜
- 設定：補倉、匯入預覽、重置、免責

介面為**繁體中文書面語**。

## 測試

```bash
node --check apex.js
node tests/money-test.mjs
node tests/engine-test.mjs
node tests/analytics-test.mjs
node tests/store-test.mjs
node tests/ladder-test.mjs
APEX_BASE=http://127.0.0.1:8765 node tests/smoke-check.mjs
```

設計計劃見 [`PLAN.md`](PLAN.md)。
