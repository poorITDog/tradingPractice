# 火狗trade — Curriculum

Cards: **118/118 mapped**. Corrected: 7. Quiz-eligible: 100.

## Product loop
Learn intro → glossary → example tip → Drill(flashcards again/good SRS) → Quiz(≥80%) → unlock next.

## Mastery / SRS / Progress
{
  "reviewAllBeforeQuiz": true,
  "passQuizPct": 80,
  "optionalNeverBlocks": [
    "ch5"
  ],
  "srs": {
    "againMinutes": 10,
    "goodDays": [
      1,
      3,
      7,
      14,
      30
    ],
    "globalQueue": true
  },
  "chapterUnlockRule": "All non-optional prereq chapters have passed quiz ≥80%."
}

{
  "storageKey": "trade-study-lab-v1",
  "schemaVersion": 1,
  "cardStateByNoteId": {
    "reps": 0,
    "bucket": "new|learning|review",
    "due": 0,
    "streakGood": 0,
    "lastResult": null
  },
  "chapterPassed": {},
  "corruptResetHint": "若進度損壞會提示重置，唔會默默清空。"
}

## Anki map
- 道氏理論 + market sense + bull/bear → `ch1`
- basic：BOS/CHoCH/流動性/Fib/SMT/CISD → `ch2`
- basic：FVG/OB/breaker/POI → `ch3`
- volume profile + auction + 量能/CVD/OI/費率 → `ch4`
- basic：MACD/RSI/ATR/EMA/VWAP → `ch5`
- 空間打火 + 火狗彈彈波 → `ch6`
- 時間打火 + PO3 → `ch7`
- pattern + p1p2b1b2 + russian → `ch8`
- altcoin → `ch9`

## Chapters
### Ch1 市場週期與道氏 (`ch1`, 8 cards)
- Prereq: —
- Intro: 先建立「市場有週期、趨勢有層級」嘅大腦模型。道氏理論同四階段幫你唔好喺狂熱期當突破、喺吸籌期當死亡。
- Objectives: 分辨三層趨勢; 用四階段定位市場節奏; 明白量價互證
  - 道氏理論核心 (`dow`): 5 cards
  - 市場四階段與節奏 (`phases`): 3 cards
### Ch2 價格結構與流動性 (`ch2`, 9 cards)
- Prereq: ['ch1']
- Intro: 學識用 BOS／CHoCH 講結構，用流動性解釋點解假突破常見。呢章係後面打火同 FVG 嘅先修。
- Objectives: BOS／CHoCH; 外部／內部流動性; premium／discount、RR、Fib、SMT、CISD
  - 結構、流動性與均衡 (`structure`): 9 cards
### Ch3 機構足跡：FVG 與 OB (`ch3`, 11 cards)
- Prereq: ['ch2']
- Intro: 機構足跡：失衡（FVG）同訂單塊（OB）。重點係動力確認同 HTF POI，唔好逢空必買。
- Objectives: FVG／iFVG／OB／breaker; FVG=動力確認; HTF POI
  - FVG、OB 與噴火龍 (`fvg_ob`): 11 cards
### Ch4 成交量、VP 與拍賣 (`ch4`, 20 cards)
- Prereq: ['ch2']
- Intro: 量價、Volume Profile 同拍賣理論，用來驗證突破真假。衍生品數據只係背景，唔係信號聖杯。
- Objectives: 量能／CVD／Delta; POC／VAH／VAL／HVN／LVN; 拍賣平衡與失敗; OI／費率背景
  - 成交量與 CVD／Delta (`flow`): 3 cards
  - Volume Profile (`vp`): 9 cards
  - 拍賣市場理論 (`auction`): 5 cards
  - 衍生品背景 (`derivs`): 3 cards
### Ch5 指標輔助（可選） (`ch5`, 6 cards) — OPTIONAL
- Prereq: ['ch4']
- Intro: 可選章：MACD／RSI／ATR／均線／VWAP。只作確認，永遠服從結構同量價。
- Objectives: 指標只作確認，不作主策略
  - 常用指標與背離 (`indicators`): 6 cards
### Ch6 空間打火與火狗 (`ch6`, 9 cards)
- Prereq: ['ch2', 'ch3']
- Intro: 空間打火：喺關鍵位置做誘騙再反向。學 OHLC／OLHC 同四步流程，再接火狗彈彈波。
- Objectives: 空間維度假火; OHLC／OLHC; 四步打火＋火狗步驟
  - 空間打火四步 (`spatial`): 8 cards
  - 火狗彈彈波 (`firedog`): 1 cards
### Ch7 時間打火與 PO3 (`ch7`, 27 cards)
- Prereq: ['ch6']
- Intro: 時間打火：美東時段 BT／T1／T2／T3。所有鐘點標註夏令 EDT；標準時間 EST 各 +1 小時。PO3 喺呢度串起來。
- Objectives: BT／T1／T2／T3（美東雙時制）; anchor candle; 假火→真趨勢; PO3
  - PO3 (`po3`): 1 cards
  - 時間打火概念 (`intro`): 10 cards
  - T1 時段 (`t1`): 3 cards
  - T2 時段 (`t2`): 7 cards
  - T3 時段 (`t3`): 6 cards
### Ch8 形態與進出場 (`ch8`, 15 cards)
- Prereq: ['ch3', 'ch6']
- Intro: 把形態同回調結構變成可執行進出場：城堡、頭肩、p1p2／b1b2、Russian 變體。
- Objectives: SOS／SOW／SIR／頭肩; p1p2／b1b2; Russian 進出場變體
  - 經典形態與城堡 (`patterns`): 7 cards
  - P1P2／B1B2 (`p1p2`): 5 cards
  - Russian 進出場 (`russian`): 3 cards
### Ch9 山寨幣專題 (`ch9`, 13 cards)
- Prereq: ['ch4', 'ch8']
- Intro: 山寨專題：貨源歸邊、人造盤面指標同陷阱。需要 Ch4 量能感覺同 Ch8 進出場紀律。
- Objectives: AP／CV／VI／共識; lift 與 sky trap; 低位 vs 主升浪中段進場
  - 山寨選幣與點火 (`altcoin`): 13 cards

## Content fixes applied
- RSI 超買超賣校正
- MACD 重複句清理
- ATR art→ATR
- premium 拼寫
- 空背面拍賣比喻卡改寫
- T1/T2/T3 夏令卡加 EST 對照

## Glossary terms: 打火, 假火, PO3, BOS, CHoCH, FVG, OB, HTF POI, 火狗彈彈波, SIR 城堡, BT/T1/T2/T3, HVN/LVN
