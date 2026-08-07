# Apex Trade Lab — 交易練習遊戲計劃（v2 · 多 agent 修訂）

## 0. 產品一句話

**Apex Trade Lab**：用真實永續行情做零風險模擬交易練習，介面接近 Bybit Demo，並用 Challenge 排行榜 + 六維雷達圖衡量交易行為與能力。

---

## 0.1 為何唔直接用 Bybit Demo？

| | Bybit Demo | Apex Trade Lab |
|--|------------|----------------|
| 行情手感 | 官方 Demo／帳戶生態 | 公開行情；零註冊本機虛擬金 |
| 帳戶 | 需平台帳號 | 純本機；可重置／匯出 |
| 差異化 | 交易所練習場 | **六維風格雷達 + Ability Score + 段位 + Challenge** |
| 關係 | — | **非 Bybit 產品、非官方、無關聯**；唔替代真金或官方 Demo |

一句話：官方 Demo 練「盤感與下單」；Apex 練「風格可被量度＋可挑戰／可分享成績」嘅練習遊戲。

**玩家幻想：** 透過可量度練習變成更有紀律嘅交易者，而唔係「穩賺」或跟單。

---

## 1. 產品定位與邊界

| 項目 | 決定 |
|------|------|
| 定位 | 自用／教學向 USDT 永續模擬練習器 |
| 真實感 | 真實 K 線／ticker／mark／orderbook／funding；虛擬資金；本地模擬撮合 |
| 不做（v1） | 真金出入金、KYC、期權、Cross、Hedge、Post-Only／條件單進階、雲端帳號／雲端排行、ADL、保險基金動態、隊列優先級鏡像 |
| 與 Solara | 獨立 repo；唔放喺 Solara（self-use-web） |
| 部署 | GitHub Pages：`…/tradingPractice/` |

**品牌（鎖定）：** 產品全名 **Apex Trade Lab**；首屏主標誌 **APEX**（副標「鋒」可選）。首屏必須品牌主導 → CTA「開始練習」；唔可以淨係 nav 先出現品牌。

---

## 2. 核心功能

### 2.1 交易台（MVP）

1. **市場**：BTCUSDT、ETHUSDT、SOLUSDT（linear perp）
2. **圖表**：TradingView Lightweight Charts；週期 1／5／15／60／240／D
3. **訂單簿 + 最近成交**
4. **下單**：Market／Limit；Long／Short；**One-way + Isolated only**
5. **槓桿**：1–50x
6. **保證金會計（寫進 engine）**：
   - Notional = qty × mark
   - IM = Notional / leverage
   - MM = Notional × MMR（每符號 stub 表，可按 Bybit 近似）
   - Equity = Wallet + Unrealized PnL（**mark**）
   - Available = Equity − ΣIM − Σ掛單凍結
   - 加倉：加權平均開倉價；支援 partial close 與 **Reduce-Only**
7. **TP／SL**：掛在倉位；觸發用 **mark**；觸發後市價模擬平倉
8. **倉位／掛單／成交歷史**（fee、funding、liq 標記）
9. **虛擬帳戶**：起始 50,000 USDT；重置／補倉；**重置唔寫 Challenge 榜**
10. **手續費**：Maker 0.02%／Taker 0.055%（可調）；**開倉與平倉都扣**
11. **資金費（MVP）**：公開 `fundingRate` + next funding time；結算：funding = −positionNotional × rate；記入 wallet／歷史
12. **強平（Isolated）**：
    - **Mark** = ticker `markPrice`（缺則 `degraded`：UPNL 可顯示 last+approx；**強平判定暫停**直至 mark 恢復，禁止用 last 默認強平）
    - MMR 來自每符號 stub 表（文件化常數）
    - **預估強平價**（顯示用，單測鎖定），忽略資金費、含開倉費緩衝 `f = takerFeeRate`：
      - Long: `liqPrice = entry × (1 - 1/lev + MMR + f) / (1 - f)`
      - Short: `liqPrice = entry × (1 + 1/lev - MMR - f) / (1 + f)`
    - 當 mark ≤ liq（多）或 mark ≥ liq（空）：**破產近似**全平（wallet 唔低於 0；可選 liq fee）；同 tick **先強平**再 TP/SL
    - 倉位列：預估強平價、距強平 % = |mark−liq|/mark
13. **撮合**：
    - **市價**：吃 L2 深度算均價；深度不足 → **整單拒絕**（寫死）
    - **限價**：觸價後按限價成交（MVP **樂觀**、無隊列；Settings 標明）
14. **下單前摘要**：保證金、預估手續費、預估強平價、距強平 %
15. **連線狀態**：`connecting | live | reconnecting | degraded | offline`

### 2.2 練習模式

| 模式 | 說明 |
|------|------|
| Live Sim | 即時行情模擬撮合（主模式；更新本機 Score 預覽，**不進跨局榜**） |
| Challenge | 固定規則結算進榜（見 §2.3） |
| Replay | 歷史回放 — **Phase 2** |

### 2.3 排行榜（Ranking）

本機 leaderboard + 匯出 JSON 成績碼（無後端；標明可被竄改）。

**Ability Score（0–100）** — 僅「已平倉 ≥ 10」時計算，否則「樣本不足」：

- 輸入：總收益% R、贏虧質量 Q、最大回撤% D、Sharpe-like S
  - `W` = 勝率；`B` = avgWin$ / max(avgLoss$, ε)；`Q = W × clamp(B/2, 0, 1.5) / 1.5`
- 正規化（鎖定以便測試）：
  - `r = clamp((R + 20) / 40 * 100, 0, 100)`
  - `q = clamp(Q * 100, 0, 100)`
  - `d = clamp(100 - D * 2, 0, 100)`
  - `s = clamp((S + 1) / 3 * 100, 0, 100)`（樣本不足時 S=50）
- `Score = 0.35r + 0.20q + 0.25d + 0.20s`
- Sharpe-like：權益曲線時段報酬 mean/std，rf=0
- 榜上可並列顯示勝率，但 **Score 唔用純勝率一項**（防刷單）

**進榜規則（v1）**

- **僅 Challenge 結束** 寫入本機榜
- Challenge 預設：起始 50,000 USDT、牆鐘 **7 日 UTC**、標的 BTC/ETH/SOL、期間禁止重置／補倉
- 可排序：Score、收益%、Sharpe-like、最大回撤、勝率；顯示交易次數
- 段位：0–19 Novice，20–39 Apprentice，40–59 Trader，60–79 Pro，80–89 Elite，90–100 Apex

**遊戲包裝：** Challenge → 結算 → 段位／榜；雷達與 Score 係練習報告，唔係金融資格。語氣避免「穩賺／跟單／信號」。

### 2.4 六維交易風格雷達圖

需已平倉 ≥ 10 才繪完整圖（否則灰態 + CTA）。各維 0–100；Trend 與 Mean Revert **不**強制互補。

1. **Trend Follow** — 進場方向與進場時刻 **1h MA(20)**（由 1h kline 收盤算；不足 20 根則維度 N/A）同向比例 ×100
2. **Mean Revert** — 相對同一 1h MA(20) 嘅逆勢進場比例 ×100；與 Trend **不**強制互補
3. **Risk Control** — `0.4*(SL使用率*100) + 0.3*clamp(avgR/2*100,0,100) + 0.3*clamp(100 - avgRiskPct*20,0,100)`；無 SL 拉低
4. **Discipline** — `0.5*(同時有TP且SL比例*100) + 0.5*過度交易懲罰分`
5. **Patience** — `0.5*持倉時長分 + 0.5*限價成交佔比分`
6. **Aggression** — `0.4*(avgLev/50*100) + 0.3*保證金佔權益分 + 0.3*頻率分`

UI：雷達 + 風格標籤（最高兩維規則表，6–8 個）+ 最低兩維改善建議 3 條。註明：行為風格 Mirror，唔係獲利保證。`analytics-test.mjs` 含 fixture → 黃金向量。

### 2.5 真實感邊界（教學必讀）

| 做到（MVP） | 做唔到／勿誤導 |
|-------------|----------------|
| 真實 mark／last／funding／簿 | 真實隊列、完整部分成交策略、ADL |
| Isolated + 強平價 | Cross 組合保證金 |
| 樂觀限價（標明） | 「成交一一對應 Bybit Demo」 |

Settings 常駐「練習撮合 ≠ 交易所保證成交」。

---

## 3. 技術架構

沿用零 build 靜態 PWA：

```
trading/
  index.html
  apex.css
  apex.js
  lib/
    market.js      # 行情適配（Bybit 優先，OKX fallback）
    engine.js      # 帳戶／訂單／倉位／撮合／強平／funding
    money.js       # 整數 micros ledger
    analytics.js
    rank.js
    store.js
  PLAN.md
  README.md
  tests/
    engine-test.mjs
    analytics-test.mjs
    store-test.mjs
```

| 層 | 職責 |
|----|------|
| Market | 優先 Bybit public REST/WS；若 CORS／地區封鎖 → **OKX public** 同構適配（標的映射 BTC-USDT-SWAP 等），UI 顯示數據源 |
| Engine | 虛擬撮合 + §2.1 會計 |
| Money | USDT micros（1e-6）；qty 按 lotSize 整數；**禁止** raw float 做 ledger |
| Analytics／Rank | §2.3／2.4 |
| Store | `apex-v1` + `schemaVersion`；校驗／`.bak`／匯入預覽 |

**CORS／連線韌性（v1 寫死）：**

- Phase A gate：探測主數據源；失敗則自動 fallback；兩者皆失敗 → 明確錯誤，唔空白圖表
- REST：指數退避；尊重 429；client min interval
- WS：watchdog + jitter reconnect；orderbook sequence gap → REST snapshot 重建
- **禁止** v1 依賴未加固 public CORS proxy

**未來 Proxy（非 v1）安全底線：** allowlist 官方 host only；拒絕任意 `url=`；per-IP rate limit；無 secrets。

**Money／時間：** Challenge 時限 UTC；UI 本地時區顯示。

**Store：** load 校驗失敗 → 保留 bak + 提示；匯入 validate→預覽→backup→替換；處理 `QuotaExceededError`。

### 3.1 撮合／風險邊角（測試必須覆蓋）

| 案例 | 預期 |
|------|------|
| 限價觸價成交 | MVP 全量按限價；費用按量；均價加權 |
| 市價吃簿 | 逐檔；深度不足 → 整單拒絕 |
| 開倉費用 | 從可用扣；不足 → reject |
| 雙邊 fee | 開倉＋平倉都扣；Available 不足 → reject |
| 精度 | tickSize／lotSize；floor 規則固定 |
| TP／SL vs 強平同 tick | **先強平**；禁止雙重平倉 |
| 標記價 | UPNL／強平用 mark |
| Mark 缺失 | 唔觸發強平；`degraded`；恢復後再檢查 |
| Funding 結算 | `payment = −signedQty × mark × rate`；wallet += payment；History 標 `funding`；唔改開倉價 |
| Reduce-only | 不可加倉 |
| 重置 | 取消掛單、清倉；需輸入 `RESET` |

---

## 4. UI／UX

### 視覺系統（token）

方向：深色交易台。禁止紫霓虹、多層 glow、pill 叢集、hero 卡片牆。

| Token | 值 |
|-------|-----|
| `--bg` | `#0B0F14` |
| `--panel` | `#121820` |
| `--panel-2` | `#1A222D` |
| `--border` | `#1E2833` |
| `--text` | `#E8EEF4` |
| `--muted` | `#8B9AAB` |
| `--up` | `#0ECB81` |
| `--down` | `#F6465D` |
| `--accent` | `#2EE6A6` |
| `--danger` | `#FF6B6B` |
| `--warning` | `#F0B90B` |

字體：IBM Plex Sans + IBM Plex Mono + Noto Sans TC。  
字階：Splash 48–64／UI 12–14／Mono 12；列高 28–32px。  
動效僅 3：(1) Splash 淡入 (2) 價／成交閃 (3) 雷達描邊。尊重 `prefers-reduced-motion`。

### 首屏品牌

單一構圖：全幅石墨大氣 + 超大 **APEX** +「真實行情 · 零風險練習」+ CTA「開始練習」。  
**禁止**自動 ≤1s 跳過。進台後頂欄左側持續 **APEX** +「模擬資金 · 非真實交易」。

### 資訊架構

```
Trade      — 圖表 + 簿/成交 + 下單 + 倉位/掛單/歷史
Portfolio  — 權益曲線、已平倉、風險指標
Analyze    — 六維雷達 + 標籤 + 3 建議
Rank       — 段位、本機榜、Challenge、成績碼
Settings   — 資金/費率/重置/匯出/免責/數據源
```

Challenge **掛在 Rank 內**，不另開 tab。

### Trade 桌面（≥1024）

```
┌─ APEX | symbols | last/24h | demo banner ─────────────────┐
│ ┌──────── chart ~60% ──────────┐ ┌ order form ~300px ───┐ │
│ │ Lightweight Charts + 週期    │ │ lev / M-L / size   │ │
│ ├ orderbook + trades（可摺） ─┤ │ Long / Short        │ │
│ └──────────────────────────────┘ └─────────────────────┘ │
│ └ tabs: Positions | Open Orders | History（密表）────────┘
```

權重：Chart > Order form > Book > Positions。禁止 chart overlay badges。

### 手機（<768）

底 tab：Trade｜Portfolio｜Analyze｜Rank｜More。  
Trade：圖表置頂（≥45% 高）→ 下單抽屜 → 倉位 sheet；orderbook 預設摺疊。

### UX 原則

**主路徑：** Splash → Trade 行情 → 槓桿／倉位 → 確認 → 成交回饋 → TP/SL／距強平 →（≥10 筆或 Challenge 結束）Analyze。

**新手：** 首次 3 步 coach（圖表→槓桿→Long/Short）；預設槓桿上限 5x（可關）；建議 SL。熟手可跳過。

**防錯：**

- Long／Short 分色 CTA + 文字（唔只靠色）
- ≥10x 警告；≥25x 二次確認
- 重置：列出清除項 + 輸入 `RESET`
- size=0／超過 Available → disable submit

**回饋：** 成交 toast（向／量／價／費）；持倉列 +/- PnL；距強平 warn／critical；WS 狀態晶片。

**無障礙：** +/- 前綴；`aria-live` 成交／強平；觸控 ≥44px。

---

## 5. 商業／合規

| 項 | 決定 |
|----|------|
| 性質 | 個人模擬練習工具；唔係券商／顧問／訊號 |
| 免責 | Footer + Settings：(a) 模擬非真實 (b) 非投資建議 (c) Not affiliated with Bybit (d) 撮合／費／強平可能不同 (e) Score／段位僅本機練習指標 (f) 數據來源標明 |
| v1 收費 | **免費**；唔付費牆核心交易／圖表／雷達 |
| 未來 | 可選雲端賽季同步；**永不**真金獎池；核心永遠免費 |
| Solara | 唔交叉品牌吞併 |

---

## 6. 實作階段

### Phase A — 骨架 + 行情
- shell、token、Splash、store、連線狀態
- Market adapter（Bybit→OKX fallback）+ charts
- **驗收：** 真實價／K 線；CORS gate；brand test；桌面 zone map／手機圖表+抽屜

### Phase B — 交易引擎
- micros ledger、市價吃簿、限價、均價、partial、fee 雙邊、Available／Equity
- **驗收：** §3.1 相關單測綠

### Phase C — 風險
- 槓桿、Isolated、TP/SL、mark 強平、funding 結算
- **驗收：** funding + mark 強平 + SL；同 tick 先強平；缺則唔算過

### Phase D — 分析 + 排行
- §2.3／2.4 公式；Challenge；本機榜
- **驗收：** fixture → Score／六維黃金值；Challenge 進榜；樣本不足 UI

### Phase E — 打磨
- coach、toast、liq 警告、a11y、README、免責
- Smoke：Pages 路徑 cold load；WS 斷→恢復；開平倉；RESET；匯出匯入；壞 storage
- Market network-only（唔長快取 ticker）
- **多 agent 終審 ≥ 95**

---

## 7. 評分標準（agent）

1. 產品清晰與範圍  
2. Demo 對齊／真實感誠實度  
3. 技術可行性（Pages + adapter）  
4. 排行＋六維可測  
5. UI／UX 可執行  
6. 風險／合規／獨立 repo（唔污染 Solara）  

通過：六角色各自 ≥ 95，無 blocker。

---

## 8. App 成功標準

- 本 repo 根目錄桌面＋手機可用  
- Live 可開平倉、fee／funding／PnL 正確（單測）  
- 六維＋Score＋Challenge 榜  
- 持久化＋匯出  
- 獨立於 Solara／self-use-web  
- 終審 ≥ 95  

---

## 9. 計劃覆核記錄

| 輪次 | Trading | UI | UX | Feature | Commercial | Bug | 結果 |
|------|---------|----|----|---------|------------|-----|------|
| v1 | 74 | 82 | 72 | 84 | 78 | 74 | REVISE → v2 |
| v2 | 93 | 96 | 95 | 96 | 96 | 96 | Trading 再修 → v2.1 |
| v2.1 | **96** | **96** | **95** | **97** | **96** | **96** | **全部 APPROVE · 平均 96 · 開工** |
| App 終審 | **96** | **96** | **95** | **97** | **96** | **96** | **SHIP · Implementation 96 · Overall 96** |
| Gap audit r2 | — | — | — | — | — | — | **96 · FINISHED · MUST-FIX 全清** |
