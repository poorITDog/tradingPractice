// Trade Study Lab — structured lessons from Anki 03_Trading.

const STORAGE_KEY = 'trade-study-lab-v1';
const DAY_MS = 86400000;

const $ = (sel, el = document) => el.querySelector(sel);
const main = $('#main');

let curriculum = null;
let progress = null;
let route = { name: 'home' };
let drill = null;
let quiz = null;

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2600);
}

function defaultProgress() {
  return {
    schemaVersion: 1,
    cardState: {},
    chapterPassed: {},
    updatedAt: Date.now(),
  };
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultProgress();
    const p = JSON.parse(raw);
    if (
      p.schemaVersion !== 1
      || !isPlainObject(p.cardState)
      || !isPlainObject(p.chapterPassed)
    ) {
      toast('進度格式不相容，已重置（原資料無法讀取）');
      return defaultProgress();
    }
    return {
      schemaVersion: 1,
      cardState: p.cardState,
      chapterPassed: p.chapterPassed,
      updatedAt: p.updatedAt || Date.now(),
    };
  } catch (_) {
    toast('進度損壞，已重置');
    return defaultProgress();
  }
}

function saveProgress() {
  progress.updatedAt = Date.now();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch (_) {
    toast('無法儲存進度（空間不足？）');
  }
}

function chapterById(id) {
  return curriculum.chapters.find((c) => c.id === id);
}

function cardsOf(chapterId, lessonId = null) {
  return curriculum.cards.filter(
    (c) => c.chapter === chapterId && (lessonId == null || c.lesson === lessonId),
  );
}

function cardState(id) {
  if (progress.cardState[id] != null && !isPlainObject(progress.cardState[id])) {
    delete progress.cardState[id];
  }
  if (!progress.cardState[id]) {
    progress.cardState[id] = {
      reps: 0, bucket: 'new', due: 0, streakGood: 0, lastResult: null, seen: false,
    };
  }
  return progress.cardState[id];
}

function assertChapterOpen(chId, { allowOptionalPrereqToast = true } = {}) {
  const ch = chapterById(chId);
  if (!ch) {
    toast('找不到章節');
    go('#/');
    return null;
  }
  if (!isChapterUnlocked(ch)) {
    if (allowOptionalPrereqToast) toast('請先通過先修章節測驗');
    go('#/');
    return null;
  }
  return ch;
}

function chapterReviewPct(chId) {
  const cards = cardsOf(chId);
  if (!cards.length) return 0;
  const seen = cards.filter((c) => cardState(c.id).seen).length;
  return Math.round((seen / cards.length) * 100);
}

function isChapterUnlocked(ch) {
  if (!ch.prereq?.length) return true;
  return ch.prereq.every((pid) => {
    const pre = chapterById(pid);
    if (pre?.optional) return true;
    return !!progress.chapterPassed[pid];
  });
}

function dueCards(now = Date.now()) {
  return curriculum.cards.filter((c) => {
    const ch = chapterById(c.chapter);
    if (!ch || !isChapterUnlocked(ch)) return false;
    const s = cardState(c.id);
    return s.seen && s.due <= now;
  });
}

function scheduleCard(id, result) {
  const s = cardState(id);
  s.seen = true;
  s.reps += 1;
  s.lastResult = result;
  const steps = curriculum.mastery.srs.goodDays || [1, 3, 7, 14, 30];
  if (result === 'again') {
    s.bucket = 'learning';
    s.streakGood = 0;
    s.due = Date.now() + (curriculum.mastery.srs.againMinutes || 10) * 60_000;
  } else {
    s.bucket = 'review';
    s.streakGood = (s.streakGood || 0) + 1;
    const idx = Math.min(s.streakGood - 1, steps.length - 1);
    s.due = Date.now() + steps[Math.max(0, idx)] * DAY_MS;
  }
  saveProgress();
}

function parseHash() {
  const h = (location.hash || '#/').replace(/^#/, '');
  const parts = h.split('/').filter(Boolean);
  if (!parts.length) return { name: 'home' };
  if (parts[0] === 'chapter' && parts[1]) {
    return { name: 'chapter', id: parts[1] };
  }
  if (parts[0] === 'drill' && parts[1]) {
    return { name: 'drill', id: parts[1], lesson: parts[2] || null };
  }
  if (parts[0] === 'quiz' && parts[1]) {
    return { name: 'quiz', id: parts[1] };
  }
  if (parts[0] === 'review') return { name: 'review' };
  if (parts[0] === 'search') return { name: 'search' };
  if (parts[0] === 'map') return { name: 'map' };
  if (parts[0] === 'glossary') return { name: 'glossary' };
  return { name: 'home' };
}

function go(hash) {
  location.hash = hash;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderHome() {
  const passed = Object.keys(progress.chapterPassed).length;
  const due = dueCards().length;
  const seen = curriculum.cards.filter((c) => cardState(c.id).seen).length;
  main.innerHTML = `
    <section class="hero">
      <h1>鋒學</h1>
      <p>把雜亂 Anki「03_Trading」重組成 ${curriculum.chapters.length} 章結構化課：學完再測，測完先解鎖下一章。</p>
      <div class="stats">
        <span>進度 <b>${seen}/${curriculum.cardCount}</b></span>
        <span>已通關 <b>${passed}</b> 章</span>
        <span>待複習 <b>${due}</b></span>
      </div>
      <div class="actions">
        <button type="button" class="primary" id="homeReview" ${due ? '' : 'disabled'}>開始複習佇列</button>
        <button type="button" class="ghost" id="homeGlossary">術語表</button>
      </div>
    </section>
    <div class="section-title">章節課程</div>
    <div class="chapter-list">
      ${curriculum.chapters.map((ch) => {
        const unlocked = isChapterUnlocked(ch);
        const pct = chapterReviewPct(ch.id);
        const done = !!progress.chapterPassed[ch.id];
        const badge = !unlocked ? 'lock' : done ? 'ok' : '';
        const badgeText = !unlocked ? '未解鎖' : done ? '已通關' : (ch.optional ? '可選' : `${pct}%`);
        return `<button type="button" class="chapter-card ${unlocked ? '' : 'locked'} ${done ? 'passed' : ''}"
          data-ch="${ch.id}" ${unlocked ? '' : 'disabled'}>
          <div class="row">
            <h2>第 ${ch.order} 章 · ${escapeHtml(ch.title)}</h2>
            <span class="badge ${badge}">${badgeText}</span>
          </div>
          <div class="muted" style="font-size:13px">${escapeHtml(ch.intro)}</div>
          <div class="progress" aria-hidden="true"><i style="width:${pct}%"></i></div>
          <div class="muted mono" style="font-size:11px">${ch.cardCount} 張卡 · 先修 ${
            ch.prereq.length ? ch.prereq.join(', ') : '無'
          }</div>
        </button>`;
      }).join('')}
    </div>`;
  $('#homeReview')?.addEventListener('click', () => go('#/review'));
  $('#homeGlossary')?.addEventListener('click', () => go('#/glossary'));
  main.querySelectorAll('[data-ch]').forEach((b) => {
    b.addEventListener('click', () => go(`#/chapter/${b.dataset.ch}`));
  });
}

function renderChapter(id) {
  const ch = chapterById(id);
  if (!ch) return go('#/');
  if (!isChapterUnlocked(ch)) {
    toast('請先通過先修章節測驗');
    return go('#/');
  }
  const pct = chapterReviewPct(id);
  const canQuiz = pct >= 100;
  const passed = !!progress.chapterPassed[id];
  main.innerHTML = `
    <button type="button" class="ghost" id="backHome">← 全部章節</button>
    <section class="hero">
      <h1>第 ${ch.order} 章 · ${escapeHtml(ch.title)}</h1>
      <p>${escapeHtml(ch.intro)}</p>
      <div class="stats">
        <span>複習 <b>${pct}%</b></span>
        <span>${passed ? '<b class="badge ok">已通關</b>' : '<b>未通關</b>'}</span>
        ${ch.optional ? '<span class="badge">可選 · 唔會擋住後面</span>' : ''}
      </div>
    </section>
    <div class="panel">
      <h3>學習目標</h3>
      <ul>${ch.objectives.map((o) => `<li>${escapeHtml(o)}</li>`).join('')}</ul>
    </div>
    <div class="panel">
      <h3>圖表思維提示</h3>
      <p class="muted" style="margin:0">${escapeHtml(ch.example || '')}</p>
    </div>
    <div class="panel">
      <h3>本節子課</h3>
      <ul>${ch.lessons.map((les) => {
        const n = cardsOf(id, les.id).length;
        return `<li><b>${escapeHtml(les.title)}</b> · ${n} 張
          <button type="button" class="ghost" style="min-height:32px;margin-left:8px" data-drill="${les.id}">練習</button>
        </li>`;
      }).join('')}</ul>
    </div>
    <div class="actions">
      <button type="button" class="primary" id="drillAll">整章閃卡</button>
      <button type="button" class="primary" id="startQuiz" ${canQuiz ? '' : 'disabled'}
        title="${canQuiz ? '開始測驗' : '請先翻完本章所有閃卡'}">章節測驗（≥80%）</button>
      <button type="button" class="ghost" id="toGlossary">術語表</button>
    </div>
    <p class="muted" style="font-size:12px">流程：簡介 → 術語 → 提示 → 閃卡 → 測驗。時區提醒：${escapeHtml(curriculum.timezoneNote)}</p>
  `;
  $('#backHome').onclick = () => go('#/');
  $('#toGlossary').onclick = () => go('#/glossary');
  $('#drillAll').onclick = () => go(`#/drill/${id}`);
  $('#startQuiz').onclick = () => go(`#/quiz/${id}`);
  main.querySelectorAll('[data-drill]').forEach((b) => {
    b.onclick = () => go(`#/drill/${id}/${b.dataset.drill}`);
  });
}

function startDrill(cards, title, backHash) {
  if (!cards.length) {
    toast('呢課未有卡片');
    return go(backHash);
  }
  drill = {
    cards: shuffle(cards),
    i: 0,
    showBack: false,
    title,
    backHash,
  };
  renderDrill();
}

function renderDrill() {
  if (!drill) return;
  const c = drill.cards[drill.i];
  const side = drill.showBack ? 'back' : 'front';
  const text = drill.showBack ? c.back : c.front;
  main.innerHTML = `
    <button type="button" class="ghost" id="drillBack">← 返回</button>
    <div class="section-title">${escapeHtml(drill.title)} · ${drill.i + 1}/${drill.cards.length}</div>
    <div class="flash ${side}" id="flash" role="button" tabindex="0" aria-label="翻面">
      <div>
        <div class="label">${drill.showBack ? '答案' : '問題'}</div>
        <div class="body">${escapeHtml(text)}</div>
      </div>
    </div>
    <div class="actions">
      <button type="button" class="ghost" id="flip">翻面</button>
      <button type="button" class="again" id="again" ${drill.showBack ? '' : 'disabled'}>再睇（Again）</button>
      <button type="button" class="good" id="good" ${drill.showBack ? '' : 'disabled'}>記得（Good）</button>
    </div>
    ${c.corrected ? '<p class="muted" style="font-size:12px">此卡已相對原 Anki 內容校正。</p>' : ''}
  `;
  const flip = () => { drill.showBack = !drill.showBack; renderDrill(); };
  $('#flash').onclick = flip;
  $('#flip').onclick = flip;
  $('#drillBack').onclick = () => go(drill.backHash);
  const grade = (result) => {
    scheduleCard(c.id, result);
    if (drill.i + 1 >= drill.cards.length) {
      toast('本輪閃卡完成');
      go(drill.backHash);
      return;
    }
    drill.i += 1;
    drill.showBack = false;
    renderDrill();
  };
  $('#again').onclick = () => grade('again');
  $('#good').onclick = () => grade('good');
}

function buildMcq(card, pool) {
  const correct = card.back;
  const distractors = shuffle(
    pool.filter((x) => x.id !== card.id && x.quizEligible).map((x) => x.back),
  ).filter((b) => b && b !== correct).slice(0, 3);
  while (distractors.length < 3) distractors.push('（干擾項不足）請選最接近正確嘅答案');
  const choices = shuffle([correct, ...distractors.slice(0, 3)]);
  return { prompt: card.front, choices, answer: correct, card };
}

function startQuiz(chId) {
  const ch = assertChapterOpen(chId);
  if (!ch) return;
  if (chapterReviewPct(chId) < 100) {
    toast('請先完成整章閃卡');
    return go(`#/chapter/${chId}`);
  }
  const pool = cardsOf(chId).filter((c) => c.quizEligible);
  const pick = shuffle(pool).slice(0, Math.min(8, pool.length));
  if (pick.length < 3) {
    toast('可測驗卡片不足');
    return go(`#/chapter/${chId}`);
  }
  quiz = {
    chId,
    items: pick.map((c) => buildMcq(c, pool)),
    i: 0,
    correct: 0,
    answered: false,
  };
  renderQuiz();
}

function renderQuiz() {
  if (!quiz) return;
  if (quiz.i >= quiz.items.length) {
    const pct = Math.round((quiz.correct / quiz.items.length) * 100);
    const pass = pct >= (curriculum.mastery.passQuizPct || 80);
    if (pass) {
      progress.chapterPassed[quiz.chId] = { pct, at: Date.now() };
      saveProgress();
    }
    main.innerHTML = `
      <section class="hero">
        <h1>測驗結果 · ${pct}%</h1>
        <p>${pass ? '通關！下一章已可解鎖（可選章唔會擋路）。' : `未達 ${curriculum.mastery.passQuizPct}% ，返去再練再考。`}</p>
        <div class="actions">
          <button type="button" class="primary" id="quizDone">返回章節</button>
          <button type="button" class="ghost" id="quizRetry">再考一次</button>
        </div>
      </section>`;
    $('#quizDone').onclick = () => go(`#/chapter/${quiz.chId}`);
    $('#quizRetry').onclick = () => startQuiz(quiz.chId);
    return;
  }
  const item = quiz.items[quiz.i];
  main.innerHTML = `
    <div class="section-title">測驗 ${quiz.i + 1}/${quiz.items.length} · 答對 ${quiz.correct}</div>
    <div class="panel">
      <h3>${escapeHtml(item.prompt)}</h3>
      <div class="choice" id="choices">
        ${item.choices.map((ch, idx) =>
    `<button type="button" data-idx="${idx}">${escapeHtml(ch)}</button>`).join('')}
      </div>
    </div>`;
  $('#choices').onclick = (e) => {
    const b = e.target.closest('button[data-idx]');
    if (!b || quiz.answered) return;
    quiz.answered = true;
    const chosen = item.choices[Number(b.dataset.idx)];
    const ok = chosen === item.answer;
    if (ok) quiz.correct += 1;
    scheduleCard(item.card.id, ok ? 'good' : 'again');
    [...$('#choices').children].forEach((btn) => {
      const t = item.choices[Number(btn.dataset.idx)];
      if (t === item.answer) btn.classList.add('correct');
      else if (btn === b && !ok) btn.classList.add('wrong');
      btn.disabled = true;
    });
    setTimeout(() => {
      quiz.i += 1;
      quiz.answered = false;
      renderQuiz();
    }, 700);
  };
}

function renderReview() {
  const cards = dueCards();
  main.innerHTML = `
    <button type="button" class="ghost" id="backHome">← 首頁</button>
    <section class="hero">
      <h1>複習佇列</h1>
      <p>到期 ${cards.length} 張（Again／Good 全局 SRS）。</p>
      <div class="actions">
        <button type="button" class="primary" id="startDue" ${cards.length ? '' : 'disabled'}>開始複習</button>
      </div>
    </section>`;
  $('#backHome').onclick = () => go('#/');
  $('#startDue').onclick = () => startDrill(cards, '複習佇列', '#/review');
}

function renderSearch() {
  main.innerHTML = `
    <button type="button" class="ghost" id="backHome">← 首頁</button>
    <section class="hero"><h1>搜尋卡片</h1></section>
    <input class="search-box" id="q" placeholder="輸入關鍵字（BOS、假火、FVG…）" />
    <div id="hits"></div>`;
  $('#backHome').onclick = () => go('#/');
  const paint = () => {
    const q = $('#q').value.trim().toLowerCase();
    const hits = !q ? [] : curriculum.cards.filter((c) =>
      (c.front + ' ' + c.back).toLowerCase().includes(q)).slice(0, 40);
    $('#hits').innerHTML = hits.length
      ? hits.map((c) => {
        const ch = chapterById(c.chapter);
        return `<button type="button" class="search-hit" data-id="${c.id}">
          ${escapeHtml(c.front.slice(0, 120))}
          <small>${ch ? `第${ch.order}章 ${ch.title}` : c.chapter} · ${escapeHtml(c.sourceDeck || '')}</small>
        </button>`;
      }).join('')
      : (q ? '<p class="muted">無結果</p>' : '<p class="muted">輸入字詞開始搜尋</p>');
    $('#hits').querySelectorAll('[data-id]').forEach((b) => {
      b.onclick = () => {
        const card = curriculum.cards.find((x) => x.id === b.dataset.id);
        if (!card) return;
        if (!assertChapterOpen(card.chapter)) return;
        startDrill([card], '搜尋結果', '#/search');
      };
    });
  };
  $('#q').oninput = paint;
  paint();
}

function renderMap() {
  main.innerHTML = `
    <button type="button" class="ghost" id="backHome">← 首頁</button>
    <section class="hero">
      <h1>Anki 牌組 → 新章節</h1>
      <p>原本子牌組太散，對照如下，方便你由舊習慣過渡。</p>
    </section>
    <div class="panel"><ul>
      ${curriculum.deckMap.map((d) =>
    `<li>${escapeHtml(d.anki)} → <b class="mono">${d.chapter}</b> · ${
      escapeHtml(chapterById(d.chapter)?.title || '')
    }</li>`).join('')}
    </ul></div>`;
  $('#backHome').onclick = () => go('#/');
}

function renderGlossary() {
  main.innerHTML = `
    <button type="button" class="ghost" id="backHome">← 首頁</button>
    <section class="hero"><h1>術語表</h1>
      <p>粵語／英文混用卡面嘅統一對照。</p>
    </section>
    <div class="panel"><dl class="glossary">
      ${curriculum.glossary.map((g) =>
    `<dt>${escapeHtml(g.term)} <span class="muted">· ${escapeHtml(g.en)}</span></dt>
       <dd>${escapeHtml(g.def)}</dd>`).join('')}
    </dl></div>`;
  $('#backHome').onclick = () => go('#/');
}

function render() {
  route = parseHash();
  if (route.name === 'home') return renderHome();
  if (route.name === 'chapter') return renderChapter(route.id);
  if (route.name === 'drill') {
    const ch = assertChapterOpen(route.id);
    if (!ch) return;
    const cards = cardsOf(route.id, route.lesson);
    const title = route.lesson
      ? `${ch.title} · ${ch.lessons.find((l) => l.id === route.lesson)?.title || route.lesson}`
      : `${ch.title} · 整章`;
    return startDrill(cards, title, `#/chapter/${route.id}`);
  }
  if (route.name === 'quiz') return startQuiz(route.id);
  if (route.name === 'review') return renderReview();
  if (route.name === 'search') return renderSearch();
  if (route.name === 'map') return renderMap();
  if (route.name === 'glossary') return renderGlossary();
  renderHome();
}

async function boot() {
  progress = loadProgress();
  const res = await fetch('data/curriculum.json');
  curriculum = await res.json();
  $('#btnHome').onclick = () => go('#/');
  $('#btnReview').onclick = () => go('#/review');
  $('#btnSearch').onclick = () => go('#/search');
  $('#btnMap').onclick = () => go('#/map');
  window.addEventListener('hashchange', render);
  render();
}

boot().catch((e) => {
  main.innerHTML = `<p class="muted">載入失敗：${escapeHtml(e.message || e)}</p>`;
});
