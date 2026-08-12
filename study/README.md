# Trade Study Lab（鋒學）

Standalone static web app that reorganizes the Anki deck **03_Trading** (118 cards) into **9 structured chapters** with lessons, flashcards, SRS review, and chapter quizzes.

## Open locally

From repo root:

```bash
python3 -m http.server 8765
```

Then open: [http://localhost:8765/study/](http://localhost:8765/study/)

## Study loop

1. Open a chapter (prerequisites must be passed; Ch5 is optional and never blocks)
2. Read intro → objectives → chart tip → glossary terms
3. Drill flashcards (Again / Good → local SRS queue)
4. Take chapter quiz (≥80% to pass and unlock next)
5. Use **複習佇列** for due cards across chapters

## Source

- Imported from `03_Trading.apkg`
- Curriculum locked in `data/curriculum.json` + `CURRICULUM.md`
- Some cards corrected vs original Anki (RSI 超買超賣, MACD wording, empty-back auction card, DST note)

## Privacy

Progress stays in `localStorage` key `trade-study-lab-v1`. No server, no account.
