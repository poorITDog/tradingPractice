# 火狗trade

Standalone static web app for studying with tutor **火狗**.  
Reorganizes the Anki deck **03_Trading** (118 cards you wrote) into **9 structured chapters** with clearer flashcards, harder exams, and a few careful SVG chart questions.

## Open locally

From repo root:

```bash
python3 -m http.server 8765
```

Then open: [http://localhost:8765/study/](http://localhost:8765/study/)

## Study loop

1. Open a chapter (prerequisites must be passed; Ch5 is optional and never blocks)
2. Read intro → objectives → chart tip
3. Drill flashcards (Again / Good → local SRS queue) — copy rewritten into clear sentences
4. Take **chapter exam** (≥80%): scenario MCQ, true/false, sequence, optional graph label
5. Use **複習佇列** for due cards across chapters

## Exams

- Question bank lives in each chapter’s `quizItems` (not raw flashcard backs)
- Harder application prompts; short labeled choices
- Graph questions: schematic SVG only (BOS/CHoCH, FVG, 假火, OLHC) — max 1 per chapter, few app-wide

## Source / privacy

- Imported from `03_Trading.apkg`; originals kept as `originalFront` / `originalBack`
- Progress in `localStorage` key `trade-study-lab-v1` (unchanged so your SRS is kept)
- No server, no account
