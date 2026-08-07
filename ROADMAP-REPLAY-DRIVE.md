# Apex 路線圖：交易所級 UI · 歷史回放 · Google Drive

## 0. 產品目標

1. **交易台 UI** 對齊 Bybit / OKX / MEXC：倉位列可直接平倉／反手／改 TP·SL  
2. **歷史回放（Replay）**：由過去某日起用真實歷史 K 線「重播」，可掛單／設止盈停損，時間自動推進驗證結果  
3. **Google Drive 同步**：沿用 Solara 的 `drive.appdata` 模式，備份交易紀錄與段位（獨立檔名，不與 Solara 衝突）

---

## 1. UI（對齊真交易所）— Phase U（本輪先做）

### 對照要點（Bybit／OKX／MEXC 共通）

| 區域 | 真交易所 | Apex 現狀 → 目標 |
|------|----------|------------------|
| 倉位表 | 每列有 **平倉／反手／止盈停損** | 只有總平倉鈕 → **列內操作** |
| 掛單表 | 每列 **取消**（醒目） | 已有取消 → 加強樣式 |
| 當前合約 | 倉位與選中合約聯動 | 平倉應可對**該列 symbol** |
| 密度 | 密表、操作在最右 | 加「操作」欄 |

### 本輪交付

- 倉位列：`市價平倉` · `反手`（可選）· 顯示 TP/SL  
- 掛單列：強化 `取消` 按鈕  
- 繁中文案

---

## 2. 歷史回放 Replay — Phase R

### 玩家幻想

「我從去年今日開始，用當時真實行情重練一遍；掛好止盈停損後按播放，看會不會打到目標。」

### 模式

| 模式 | 說明 |
|------|------|
| 練習／排位（現有） | 即時行情 |
| **回放** | 歷史 K 線時鐘；可暫停／倍速（1x–60x） |

### 資料來源

- REST 歷史 K 線：Bybit／OKX `candles`（已有 adapter 可擴 `fetchKlinesRange`）  
- v1：**1m 或 5m** 主循環；進場用該根 OHLC  
- 訂單簿：回放期用「合成簿」（mid±spread）或僅用 candle close 撮合（Settings 標明「回放撮合簡化」）

### 時鐘與撮合

```
clock = startTime
loop:
  advance N candles (依倍速)
  update mark/last = candle.close (或 HL 觸價)
  maybeFillLimits / onMarkUpdate（TP/SL／強平）
  若 hit TP/SL → 記錄結果，可自動暫停
```

### 止盈／停損驗證（你要的 auto-run）

1. 開倉時設 TP／SL  
2. 按「播放至結果」：引擎跳過中間 UI，逐根 candle 檢查 high/low 是否觸及  
3. 結束卡片：觸發原因、出場價、盈虧、用時、最大浮盈／浮虧  

### 範圍控制（YAGNI）

**v1 做：** 選標的、起始日、速度、播放／暫停、跳到結算、TP/SL 觸價邏輯、本機存回放成績  
**v1 不做：** 逐筆真實歷史 trade tape、完整 orderbook 重建、回放排位賽進榜（回放只進練習報告）

### 驗收

- 選定「一年 BTC 5m 起」可開多 + SL，播放後在觸及 SL 的那根停下  
- 單測：合成 candle 序列 → TP 先於 SL／SL 先於 TP 的黃金案例  

---

## 3. Google Drive — Phase D（對齊 Solara）

### 沿用模式（已在 self-use-web 驗證）

- GIS：`https://accounts.google.com/gsi/client`  
- Scope：`https://www.googleapis.com/auth/drive.appdata`  
- 使用者自填 OAuth Client ID（與 Solara 可共用同一個 Web client，**檔名必須不同**）  
- 授權來源：`http://localhost:8765`、`https://pooritdog.github.io`

### Apex 專用常數

| 項 | 值 |
|----|-----|
| localStorage | `apex-v1`（已有） |
| token | `apex-google-token` |
| Drive 檔名 | **`apex-trade-lab-v1.json`**（勿用 `solara-v1.json`） |

### 同步內容

整包 state（或精簡）：`closedTrades`、`fills` 摘要、`ladder`、`leaderboard`、`settings`（含 clientId）、`equitySamples`（可截斷）、`syncUpdatedAt`

### 流程

1. 設定頁：輸入 Client ID → 連接 Google Drive  
2. `saveState` 後 debounce 1.5s → `driveSync`  
3. merge：`closedTrades` 按 id／closedAt 聯集；ladder 取較新 `syncUpdatedAt`  
4. **禁止**空本地覆寫非空雲端（抄 Solara `syncContentWeight`）  
5. 手動「立即同步」／斷開  

### 驗收

- 瀏覽器 A 連 Drive 下單平倉 → 瀏覽器 B 清 localStorage 後連同一帳號 → 看得到成交與段位  

---

## 4. 實作順序

| Phase | 內容 | 狀態 |
|-------|------|------|
| U | 倉位列平倉／反手 UI | ✅ 已做（列內市價平倉／反手／TP·SL） |
| D0 | `lib/drive.js` + 設定頁連接 | ✅ 骨架已做（`apex-trade-lab-v1.json`） |
| R1 | 歷史 K 線 range + 回放時鐘 | 下一輪 |
| R2 | 播放至 TP/SL 結果 + 單測 | 下一輪 |
| D1 | merge 強化 + 自動同步穩定性 | 與 R 並行 |

---

## 5. Agent 評分維度

1. 回放是否可教到 TP/SL 直覺  
2. Drive 會否誤傷 Solara 資料  
3. UI 是否達交易所最低操作密度  
4. 範圍會否爆炸  

通過：Trading／UX／Feature／Bug 各 ≥ 95
