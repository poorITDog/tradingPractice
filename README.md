# Apex Trade Lab

真實行情 · 零風險永續模擬練習。六維風格雷達 + **青銅→菁英**段位排位賽。

**非 Bybit 產品。** 模擬資金，不是投資建議。

Repo：[`poorITDog/tradingPractice`](https://github.com/poorITDog/tradingPractice)

## 開啟

```bash
python3 -m http.server 8765
# 交易練習室：http://localhost:8765/
# 結構化複習（鋒學）：http://localhost:8765/study/
```

GitHub Pages（啟用後）：`https://pooritdog.github.io/tradingPractice/`  
學習 app：`https://pooritdog.github.io/tradingPractice/study/`

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
- 倉位表：每列 **市價平倉／反手**（對齊 Bybit／OKX 操作密度）
- 資產頁：**每日盈虧日曆**（Asia/Taipei）、今日／7／30 日統計、詳細權益曲線、持倉佔比、日結 CSV
- Google Drive：設定頁連接，備份至 `apex-trade-lab-v1.json`（與 Solara 分開）
- 歷史回放：規劃中，見 [`ROADMAP-REPLAY-DRIVE.md`](ROADMAP-REPLAY-DRIVE.md)
- **Trade Study Lab（鋒學）**：獨立學習站 [`study/`](study/) — 將 Anki `03_Trading` 118 卡重組為 9 章課＋閃卡／測驗／SRS

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
