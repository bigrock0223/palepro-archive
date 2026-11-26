(() => {
  const DATA = window.PALEPRO_DATA;
  const PAGE = 60;
  const GENRE_SHOW = 10; // ジャンルは最初この数だけ表示し、「すべて表示」で全部出す
  const $ = (id) => document.getElementById(id);
  const chMap = Object.fromEntries(DATA.channels.map((c) => [c.key, c]));
  // メンバーカラーのCSS変数（gradient=グラデーション / ring=縁取り）
  const chStyle = (c) => `--c:${c.color}` + (c.gradient ? `;--g:${c.gradient}` : '') + (c.ring ? `;--r:${c.ring}` : '');
  const TYPES = [['', 'すべて'], ['live', '配信'], ['video', '動画'], ['short', 'ショート']];
  const TYPE_LABEL = { live: '配信', video: '動画', short: 'ショート' };
  const mqSp = window.matchMedia('(max-width: 860px)');

  // ---- 表記ゆれ吸収（ビルド側と同じルール）----
  const normalize = (s = '') => s.normalize('NFKC').toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

  // ---- 日本時間に変換して前計算 ----
  const JST = 9 * 3600e3;
  const pad = (n) => String(n).padStart(2, '0');
  const videos = DATA.videos.map((v) => {
    const ms = Date.parse(v.s);
    const j = new Date(ms + JST);
    return {
      ...v, ms,
      day: `${j.getUTCFullYear()}-${pad(j.getUTCMonth() + 1)}-${pad(j.getUTCDate())}`,
      label: `${j.getUTCFullYear()}/${pad(j.getUTCMonth() + 1)}/${pad(j.getUTCDate())}(${'日月火水木金土'[j.getUTCDay()]}) ${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())}`,
      norm: normalize(v.t),
      all: [...v.m, ...v.g],
    };
  });

  // ---- 状態（URLのクエリと同期）----
  // members: 出演者（公式はチャンネル）/ memberAnd: 全員出演 / ownerOnly: チャンネルの持ち主で絞る / units: ユニット
  // view: 表示のしかた（list / card）。スマホは常にリスト
  const INITIAL = { q: '', members: [], memberAnd: false, memberOnly: false, ownerOnly: false, units: [], genres: [], genreAnd: false, from: '', to: '', len: '', type: '', sort: 'new', view: 'list' };
  const state = { ...INITIAL };
  let page = 1;
  let genresOpen = false;

  function readUrl() {
    const p = new URLSearchParams(location.search);
    state.q = p.get('q') || '';
    state.members = (p.get('member') || '').split(',').filter(Boolean);
    state.memberAnd = p.get('mand') === '1';
    state.memberOnly = p.get('monly') === '1';
    state.ownerOnly = p.get('owner') === '1';
    state.units = (p.get('unit') || '').split(',').filter(Boolean);
    state.genres = (p.get('genre') || '').split(',').filter(Boolean);
    state.genreAnd = p.get('and') === '1';
    for (const k of ['from', 'to', 'len', 'type']) state[k] = p.get(k) || '';
    state.sort = p.get('sort') || 'new';
    state.view = p.get('view') === 'card' ? 'card' : 'list';
    page = Math.max(1, parseInt(p.get('page'), 10) || 1);
  }
  function writeUrl(push = false) {
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.members.length) p.set('member', state.members.join(','));
    if (state.memberAnd) p.set('mand', '1');
    if (state.memberOnly) p.set('monly', '1');
    if (state.ownerOnly) p.set('owner', '1');
    if (state.units.length) p.set('unit', state.units.join(','));
    if (state.genres.length) p.set('genre', state.genres.join(','));
    if (state.genreAnd) p.set('and', '1');
    for (const k of ['from', 'to', 'len', 'type']) if (state[k]) p.set(k, state[k]);
    if (state.sort !== 'new') p.set('sort', state.sort);
    if (state.view !== 'list') p.set('view', state.view);
    if (page > 1) p.set('page', page);
    const qs = p.toString();
    const url = qs ? `?${qs}` : location.pathname;
    // ページ移動はブラウザの「戻る」で戻れるよう履歴に積む
    // 埋め込み表示など履歴を操作できない環境でも止まらないようにする
    try { if (push) history.pushState(null, '', url); else history.replaceState(null, '', url); } catch (e) { /* 無視 */ }
  }

  // ---- 絞り込み ----
  function filter() {
    const words = normalize(state.q).split(/\s+/).filter(Boolean);
    const [lmin, lmax] = state.len ? state.len.split('-').map((x) => (x === '' ? Infinity : Number(x))) : [0, Infinity];
    const res = videos.filter((v) => {
      if (words.length && !words.every((w) => v.norm.includes(w))) return false;
      if (state.members.length) {
        // 公式はチャンネルで判定、メンバーは出演者で判定（「チャンネル主のみ」ならチャンネルで判定）
        const has = (k) => (k === 'official' || state.ownerOnly ? v.c === k : v.p.includes(k));
        const people = state.members.filter((k) => k !== 'official');
        if (state.memberOnly && !state.ownerOnly && people.length) {
          // 完全一致: 出演者が選んだメンバーとぴったり同じ（公式も選んでいれば公式チャンネルに限る）
          if (v.p.length !== people.length || !people.every((k) => v.p.includes(k))) return false;
          if (state.members.includes('official') && v.c !== 'official') return false;
        } else if (!(state.memberAnd && !state.ownerOnly ? state.members.every(has) : state.members.some(has))) return false;
      }
      if (state.units.length && !state.units.some((u) => v.u.includes(u))) return false;
      if (state.genres.length) {
        const ok = state.genreAnd ? state.genres.every((g) => v.all.includes(g)) : state.genres.some((g) => v.all.includes(g));
        if (!ok) return false;
      }
      if (state.from && v.day < state.from) return false;
      if (state.to && v.day > state.to) return false;
      if (state.len && !(v.d >= lmin && v.d < lmax)) return false;
      if (state.type && v.ty !== state.type) return false;
      return true;
    });
    const cmp = {
      new: (a, b) => b.ms - a.ms, old: (a, b) => a.ms - b.ms,
      long: (a, b) => b.d - a.d, short: (a, b) => a.d - b.d,
    }[state.sort] || ((a, b) => b.ms - a.ms);
    return res.sort(cmp);
  }

  // ---- 表示 ----
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDur = (s) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  };
  const num = (n) => n.toLocaleString();

  // 1件分。リスト・カードとも同じ中身で、見た目だけ CSS で切り替える
  // 並び：サムネイル → タイトル → チャンネル → 出演者 → 種類・日付 → タグ（リストのパソコン表示では種類・日付は右端）
  function item(v) {
    const ch = chMap[v.c] || { name: v.c, color: '#999' };
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`;
    const thumb = v.th
      ? `<img loading="lazy" src="${esc(v.th)}" alt="" onerror="this.remove()">`
      : `<span class="noimg">${esc(ch.name)}</span>`;
    const tags = [
      ...v.m.map((g) => `<button type="button" class="tag manual" data-genre="${esc(g)}" title="手動で付けたジャンル（押すとこのジャンルで絞り込み）">${esc(g)}</button>`),
      ...v.g.map((g) => `<button type="button" class="tag" data-genre="${esc(g)}" title="自動判定のジャンル（押すとこのジャンルで絞り込み）">${esc(g)}</button>`),
    ].join('');
    const ty = TYPE_LABEL[v.ty] || '';
    return `<li class="item">
      <a class="thumb" href="${url}" target="_blank" rel="noopener" style="${chStyle(ch)}" tabindex="-1" aria-hidden="true">${thumb}<span class="dur">${fmtDur(v.d)}</span></a>
      <div class="body">
        <p class="title"><a href="${url}" target="_blank" rel="noopener" title="${esc(v.t)}">${esc(v.t)}</a></p>
        <div class="chline"><span class="lbl">チャンネル</span><span class="who" style="${chStyle(ch)}"><span class="dot"></span>${esc(ch.name)}</span></div>
        ${castLine(v)}
        <div class="sub"><span class="ty">${ty}</span><span aria-hidden="true">·</span><span>${v.label}</span><span class="sr">長さ ${fmtDur(v.d)}</span></div>
        ${tags ? `<div class="tags">${tags}</div>` : ''}
      </div>
      <div class="side"><span class="ty">${ty}</span><span class="dt">${v.label}</span></div>
    </li>`;
  }

  // 出演者とユニットの表示（例: 出演 ●クララ ●ハノン  [Sputrip]）。チャンネルは別の行（item の .chline）
  const shortName = (c) => c.name.replace(/^(暁月|七海|常磐|藤宮|江波|鬼多見|香鳴|夏渚)/, '');
  function castLine(v) {
    const ps = v.p.map((k) => chMap[k]).filter(Boolean)
      .map((c) => `<button type="button" class="cast" data-member="${c.key}" style="${chStyle(c)}" title="${esc(c.name)}で絞り込む"><span class="dot"></span>${esc(shortName(c))}</button>`).join('');
    const us = v.u.map((u) => `<button type="button" class="unit" data-unit="${esc(u)}" title="${esc(u)}で絞り込む">${esc(u)}</button>`).join('');
    if (!ps && !us) return '';
    return `<div class="castline"><span class="lbl">出演</span>${ps}${us}</div>`;
  }

  // 絞り込み欄の選択肢（件数は全体の件数。シンプルさ優先）
  function renderChoices() {
    const mCount = {}, gCount = {}, uCount = {}, tCount = { '': videos.length };
    for (const v of videos) {
      if (state.ownerOnly || v.c === 'official') mCount[v.c] = (mCount[v.c] || 0) + 1;
      if (!state.ownerOnly) for (const k of v.p) mCount[k] = (mCount[k] || 0) + 1;
      for (const g of v.all) gCount[g] = (gCount[g] || 0) + 1;
      for (const u of v.u) uCount[u] = (uCount[u] || 0) + 1;
      tCount[v.ty] = (tCount[v.ty] || 0) + 1;
    }
    $('types').innerHTML = TYPES.map(([k, name]) =>
      `<label><input type="radio" name="type" value="${k}" ${state.type === k ? 'checked' : ''}><span class="name">${name}</span><span class="n">${num(tCount[k] || 0)}</span></label>`).join('');
    $('members').innerHTML = DATA.channels.filter((c) => mCount[c.key]).map((c) =>
      `<label style="${chStyle(c)}"><input type="checkbox" value="${c.key}" ${state.members.includes(c.key) ? 'checked' : ''}><span class="dot"></span><span class="name">${esc(c.name)}</span><span class="n">${num(mCount[c.key])}</span></label>`).join('');
    const units = (DATA.units || []).filter((u) => uCount[u]);
    $('units').innerHTML = units.map((u) =>
      `<button type="button" class="chip" data-unit="${esc(u)}" aria-pressed="${state.units.includes(u)}">${esc(u)} <span class="n">${num(uCount[u])}</span></button>`).join('');
    $('unitField').hidden = !units.length;
    const genres = DATA.genres.filter((g) => gCount[g]);
    const shown = genresOpen ? genres : genres.filter((g, i) => i < GENRE_SHOW || state.genres.includes(g));
    $('genres').innerHTML = shown.map((g) =>
      `<label><input type="checkbox" value="${esc(g)}" ${state.genres.includes(g) ? 'checked' : ''}><span class="name">${esc(g)}</span><span class="n">${num(gCount[g])}</span></label>`).join('');
    $('genreMore').hidden = genres.length <= GENRE_SHOW;
    $('genreMore').textContent = genresOpen ? '少なく表示' : `すべて表示（${genres.length}）`;
  }

  // 表示するページ番号: 1 … 4 5 [6] 7 8 … 20
  function pageList(cur, total) {
    const r = 2;
    const near = Array.from({ length: r * 2 + 1 }, (_, i) => cur - r + i);
    const set = new Set([1, total, ...near].filter((n) => n >= 1 && n <= total));
    const nums = [...set].sort((a, b) => a - b);
    const out = [];
    nums.forEach((n, i) => { if (i && n - nums[i - 1] > 1) out.push(null); out.push(n); });
    return out;
  }
  function renderPager(total, count, start) {
    if (!count) return '';
    const info = `<span class="info">${num(start + 1)}〜${num(Math.min(start + PAGE, count))}件 / ${num(count)}件</span>`;
    if (total <= 1) return info;
    const nav = (n, label, cls, aria) => `<button type="button" class="${cls}" data-page="${n}" ${n === page ? 'disabled' : ''} aria-label="${aria}">${label}</button>`;
    const nums = pageList(page, total).map((n) => n === null ? '<span class="gap">…</span>'
      : `<button type="button" data-page="${n}" ${n === page ? 'aria-current="page" disabled' : ''} aria-label="${n}ページ">${n}</button>`).join('');
    return info
      + `<div class="nums">${nav(Math.max(1, page - 1), '前へ', 'prev', '前のページ')}${nums}${nav(Math.min(total, page + 1), '次へ', 'next', '次のページ')}</div>`
      // スマホ用：前へ / 1 / 204 ページ / 次へ
      + `<div class="spnav">${nav(Math.max(1, page - 1), '前へ', 'prev', '前のページ')}<span class="pos"><strong>${page}</strong> / ${total} ページ</span>${nav(Math.min(total, page + 1), '次へ', 'next', '次のページ')}</div>`;
  }

  let lastCount = 0;
  function render(push = false) {
    const res = filter();
    const total = Math.max(1, Math.ceil(res.length / PAGE));
    page = Math.min(Math.max(1, page), total);
    const start = (page - 1) * PAGE;
    lastCount = res.length;
    $('count').innerHTML = res.length
      ? `<strong>${num(res.length)}件</strong> が見つかりました <span class="range">（${num(start + 1)}〜${num(Math.min(start + PAGE, res.length))}件目）</span>`
      : '<strong>0件</strong>';
    $('list').className = `items ${state.view}`;
    $('list').innerHTML = res.slice(start, start + PAGE).map(item).join('');
    $('pager').innerHTML = renderPager(total, res.length, start);
    $('empty').hidden = res.length > 0;
    for (const b of $('viewSwitch').querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', b.dataset.view === state.view);
    const active = (state.q ? 1 : 0) + state.members.length + state.units.length + state.genres.length
      + (state.type ? 1 : 0) + (state.len ? 1 : 0) + (state.from || state.to ? 1 : 0);
    $('filterToggleText').textContent = active ? `絞り込み（${active}）` : '絞り込み';
    $('filterDone').textContent = `${num(res.length)}件を表示`;
    for (const el of document.querySelectorAll('#members input')) el.checked = state.members.includes(el.value);
    for (const el of document.querySelectorAll('#genres input')) el.checked = state.genres.includes(el.value);
    for (const el of document.querySelectorAll('#types input')) el.checked = state.type === el.value;
    for (const el of document.querySelectorAll('#units .chip')) el.setAttribute('aria-pressed', state.units.includes(el.dataset.unit));
    writeUrl(push);
  }

  function syncInputs() {
    $('q').value = state.q; $('genreAnd').checked = state.genreAnd;
    $('memberAnd').checked = state.memberAnd; $('ownerOnly').checked = state.ownerOnly;
    $('memberOnly').checked = state.memberOnly;
    $('memberAnd').disabled = state.ownerOnly || state.memberOnly;
    $('memberOnly').disabled = state.ownerOnly;
    for (const k of ['from', 'to', 'len', 'sort']) $(k).value = state[k];
  }

  const update = () => { page = 1; render(); };
  const toggle = (arr, x) => (arr.includes(x) ? arr.filter((y) => y !== x) : [...arr, x]);
  const scrollToResults = () => {
    const top = $('resultsPanel').getBoundingClientRect().top + window.scrollY - 8;
    if (window.scrollY > top) window.scrollTo({ top, behavior: 'smooth' });
  };

  // ---- 絞り込み欄の開閉（スマホ）----
  function openFilters(open) {
    $('filters').classList.toggle('open', open);
    document.body.classList.toggle('filters-opened', open && mqSp.matches);
    $('filterToggle').setAttribute('aria-expanded', open);
    if (open) $('filterClose').focus(); else if (mqSp.matches) $('filterToggle').focus();
  }
  mqSp.addEventListener('change', () => { if (!mqSp.matches) openFilters(false); });

  // ---- イベント ----
  let timer;
  $('q').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { state.q = e.target.value; update(); }, 150); });
  $('searchForm').addEventListener('submit', (e) => {
    e.preventDefault(); clearTimeout(timer);
    state.q = $('q').value; update();
    if (mqSp.matches) $('q').blur(); // スマホではキーボードを閉じて結果を見せる
  });
  for (const k of ['from', 'to', 'len', 'sort']) $(k).addEventListener('change', (e) => { state[k] = e.target.value; update(); });
  $('types').addEventListener('change', (e) => { if (e.target.name === 'type') { state.type = e.target.value; update(); } });
  $('genreAnd').addEventListener('change', (e) => { state.genreAnd = e.target.checked; update(); });
  $('memberAnd').addEventListener('change', (e) => { state.memberAnd = e.target.checked; update(); });
  $('memberOnly').addEventListener('change', (e) => { state.memberOnly = e.target.checked; syncInputs(); update(); });
  $('ownerOnly').addEventListener('change', (e) => { state.ownerOnly = e.target.checked; syncInputs(); renderChoices(); update(); });
  $('members').addEventListener('change', (e) => { if (e.target.type === 'checkbox') { state.members = toggle(state.members, e.target.value); update(); } });
  $('genres').addEventListener('change', (e) => { if (e.target.type === 'checkbox') { state.genres = toggle(state.genres, e.target.value); update(); } });
  $('units').addEventListener('click', (e) => { const b = e.target.closest('[data-unit]'); if (b) { state.units = toggle(state.units, b.dataset.unit); update(); } });
  $('genreMore').addEventListener('click', () => { genresOpen = !genresOpen; renderChoices(); });
  $('viewSwitch').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]'); if (!b || b.dataset.view === state.view) return;
    state.view = b.dataset.view; render(); // 表示を変えても件数・並び順・ページはそのまま
  });
  $('list').addEventListener('click', (e) => {
    // 一覧の中のジャンル・出演者・ユニットを押すと、その条件を追加
    const b = e.target.closest('.tag, .cast, .unit'); if (!b) return;
    if (b.dataset.genre && !state.genres.includes(b.dataset.genre)) state.genres = [...state.genres, b.dataset.genre];
    if (b.dataset.member && !state.members.includes(b.dataset.member)) state.members = [...state.members, b.dataset.member];
    if (b.dataset.unit && !state.units.includes(b.dataset.unit)) state.units = [...state.units, b.dataset.unit];
    renderChoices(); update(); window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('quick').addEventListener('click', (e) => {
    const b = e.target.closest('[data-range]'); if (!b) return;
    const days = Number(b.dataset.range);
    if (!days) { state.from = state.to = ''; }
    else {
      const j = new Date(Date.now() + JST - days * 86400e3);
      state.from = `${j.getUTCFullYear()}-${pad(j.getUTCMonth() + 1)}-${pad(j.getUTCDate())}`; state.to = '';
    }
    syncInputs(); update();
  });
  $('filterToggle').addEventListener('click', () => openFilters(true));
  $('filterClose').addEventListener('click', () => openFilters(false));
  $('filterDone').addEventListener('click', () => { openFilters(false); window.scrollTo({ top: 0 }); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('filters').classList.contains('open')) openFilters(false); });
  $('pager').addEventListener('click', (e) => {
    const b = e.target.closest('[data-page]'); if (!b || b.disabled) return;
    page = Number(b.dataset.page); render(true);
    scrollToResults();
  });
  window.addEventListener('popstate', () => { readUrl(); syncInputs(); renderChoices(); render(); });
  const reset = () => {
    Object.assign(state, INITIAL, { members: [], units: [], genres: [], view: state.view });
    syncInputs(); renderChoices(); update();
  };
  $('reset').addEventListener('click', reset);
  $('resetSp').addEventListener('click', reset);

  // ---- 初期化 ----
  if (DATA.updatedAt) {
    const j = new Date(Date.parse(DATA.updatedAt) + JST);
    const t = `${j.getUTCFullYear()}/${pad(j.getUTCMonth() + 1)}/${pad(j.getUTCDate())} ${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())}`;
    $('updated').textContent = `最終更新 ${t}（${num(videos.length)}件）`;
    $('updatedFoot').textContent = `最終更新 ${t}（${num(videos.length)}件）`;
  }
  // 確認モードの鍵を登録したブラウザだけ、フッターに確認モードへのリンクを出す
  try { if (localStorage.getItem('palepro-review-config')) $('reviewLink').hidden = false; } catch { /* */ }
  readUrl(); syncInputs(); renderChoices(); render();
})();
