(() => {
  const DATA = window.PALEPRO_DATA;
  const PAGE = 60;
  const $ = (id) => document.getElementById(id);
  const chMap = Object.fromEntries(DATA.channels.map((c) => [c.key, c]));
  // メンバーカラーのCSS変数（gradient=グラデーション / ring=縁取り）
  const chStyle = (c) => `--c:${c.color}` + (c.gradient ? `;--g:${c.gradient}` : '') + (c.ring ? `;--r:${c.ring}` : '');

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
      hour: j.getUTCHours(), dow: j.getUTCDay(),
      label: `${j.getUTCFullYear()}/${pad(j.getUTCMonth() + 1)}/${pad(j.getUTCDate())}(${'日月火水木金土'[j.getUTCDay()]}) ${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())}`,
      norm: normalize(v.t),
      all: [...v.m, ...v.g],
    };
  });

  // ---- 状態（URLのクエリと同期）----
  const state = { q: '', members: [], genres: [], genreAnd: false, from: '', to: '', tod: '', dow: '', len: '', type: '', sort: 'new' };
  let page = 1;

  function readUrl() {
    const p = new URLSearchParams(location.search);
    state.q = p.get('q') || '';
    state.members = (p.get('member') || '').split(',').filter(Boolean);
    state.genres = (p.get('genre') || '').split(',').filter(Boolean);
    state.genreAnd = p.get('and') === '1';
    for (const k of ['from', 'to', 'tod', 'dow', 'len', 'type']) state[k] = p.get(k) || '';
    state.sort = p.get('sort') || 'new';
    page = Math.max(1, parseInt(p.get('page'), 10) || 1);
  }
  function writeUrl(push = false) {
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.members.length) p.set('member', state.members.join(','));
    if (state.genres.length) p.set('genre', state.genres.join(','));
    if (state.genreAnd) p.set('and', '1');
    for (const k of ['from', 'to', 'tod', 'dow', 'len', 'type']) if (state[k]) p.set(k, state[k]);
    if (state.sort !== 'new') p.set('sort', state.sort);
    if (page > 1) p.set('page', page);
    const qs = p.toString();
    const url = qs ? `?${qs}` : location.pathname;
    // ページ移動はブラウザの「戻る」で戻れるよう履歴に積む
    // 埋め込み表示など履歴を操作できない環境でも止まらないようにする
    try { if (push) history.pushState(null, '', url); else history.replaceState(null, '', url); } catch (e) { /* 無視 */ }
  }

  // ---- 絞り込み ----
  const TOD = { morning: [5, 12], day: [12, 18], night: [18, 24], late: [0, 5] };
  function filter() {
    const words = normalize(state.q).split(/\s+/).filter(Boolean);
    const [lmin, lmax] = state.len ? state.len.split('-').map((x) => (x === '' ? Infinity : Number(x))) : [0, Infinity];
    const tod = TOD[state.tod];
    const res = videos.filter((v) => {
      if (words.length && !words.every((w) => v.norm.includes(w))) return false;
      if (state.members.length && !state.members.includes(v.c)) return false;
      if (state.genres.length) {
        const ok = state.genreAnd ? state.genres.every((g) => v.all.includes(g)) : state.genres.some((g) => v.all.includes(g));
        if (!ok) return false;
      }
      if (state.from && v.day < state.from) return false;
      if (state.to && v.day > state.to) return false;
      if (tod && !(v.hour >= tod[0] && v.hour < tod[1])) return false;
      if (state.dow !== '' && v.dow !== Number(state.dow)) return false;
      if (state.len && !(v.d >= lmin && v.d < lmax)) return false;
      if (state.type && v.ty !== state.type) return false;
      return true;
    });
    const cmp = {
      new: (a, b) => b.ms - a.ms, old: (a, b) => a.ms - b.ms,
      long: (a, b) => b.d - a.d, short: (a, b) => a.d - b.d,
    }[state.sort];
    return res.sort(cmp);
  }

  // ---- 表示 ----
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDur = (s) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  };

  function card(v) {
    const ch = chMap[v.c] || { name: v.c, color: '#999' };
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`;
    const thumb = v.th
      ? `<img loading="lazy" src="${esc(v.th)}" alt="" onerror="this.remove()">`
      : `<span class="noimg">${esc(ch.name)}</span>`;
    const tags = [
      ...v.m.map((g) => `<button type="button" class="tag manual" data-genre="${esc(g)}" title="手動で付けたジャンル">${esc(g)}</button>`),
      ...v.g.map((g) => `<button type="button" class="tag" data-genre="${esc(g)}" title="自動判定のジャンル">${esc(g)}</button>`),
    ].join('');
    return `<li class="card">
      <a class="thumb" href="${url}" target="_blank" rel="noopener" style="${chStyle(ch)}">${thumb}<span class="dur">${fmtDur(v.d)}</span></a>
      <div class="body">
        <p class="title"><a href="${url}" target="_blank" rel="noopener">${esc(v.t)}</a></p>
        <div class="meta"><span class="who" style="${chStyle(ch)}"><span class="dot"></span>${esc(ch.name)}</span><span>${v.label}</span></div>
        <div class="tags">${tags}</div>
      </div>
    </li>`;
  }

  function renderChips() {
    // 件数は「その条件を除いた現在の絞り込み」ではなく全体件数（シンプルさ優先）
    const mCount = {}, gCount = {};
    for (const v of videos) { mCount[v.c] = (mCount[v.c] || 0) + 1; for (const g of v.all) gCount[g] = (gCount[g] || 0) + 1; }
    $('members').innerHTML = DATA.channels.filter((c) => mCount[c.key]).map((c) =>
      `<button type="button" class="chip" data-member="${c.key}" aria-pressed="${state.members.includes(c.key)}" style="${chStyle(c)}"><span class="dot"></span>${esc(c.name)} <span class="n">${mCount[c.key]}</span></button>`).join('');
    $('genres').innerHTML = DATA.genres.filter((g) => gCount[g]).map((g) =>
      `<button type="button" class="chip" data-genre="${esc(g)}" aria-pressed="${state.genres.includes(g)}">${esc(g)} <span class="n">${gCount[g]}</span></button>`).join('');
  }

  // 表示するページ番号: 1 … 4 5 [6] 7 8 … 20
  function pageList(cur, total) {
    // スマホ幅では前後1ページ、PCでは前後2ページまで表示
    const r = window.matchMedia('(max-width: 480px)').matches ? 1 : 2;
    const near = Array.from({ length: r * 2 + 1 }, (_, i) => cur - r + i);
    const set = new Set([1, total, ...near].filter((n) => n >= 1 && n <= total));
    const nums = [...set].sort((a, b) => a - b);
    const out = [];
    nums.forEach((n, i) => { if (i && n - nums[i - 1] > 1) out.push(null); out.push(n); });
    return out;
  }
  function renderPager(total) {
    if (total <= 1) return '';
    const btn = (n, label, aria) => `<button type="button" data-page="${n}" ${n === page ? 'disabled' : ''} aria-label="${aria}">${label}</button>`;
    return [
      btn(Math.max(1, page - 1), '‹', '前のページ'),
      ...pageList(page, total).map((n) => n === null ? '<span class="gap">…</span>'
        : `<button type="button" data-page="${n}" ${n === page ? 'aria-current="page" disabled' : ''} aria-label="${n}ページ">${n}</button>`),
      btn(Math.min(total, page + 1), '›', '次のページ'),
    ].join('');
  }

  function render(push = false) {
    const res = filter();
    const total = Math.max(1, Math.ceil(res.length / PAGE));
    page = Math.min(Math.max(1, page), total);
    const start = (page - 1) * PAGE;
    $('count').textContent = res.length
      ? `${res.length.toLocaleString()} 件中 ${(start + 1).toLocaleString()}〜${Math.min(start + PAGE, res.length).toLocaleString()} 件目`
      : '0 件';
    $('list').innerHTML = res.slice(start, start + PAGE).map(card).join('');
    $('pagerTop').innerHTML = $('pagerBottom').innerHTML = renderPager(total);
    $('empty').hidden = res.length > 0;
    const active = (state.q ? 1 : 0) + state.members.length + state.genres.length
      + ['from', 'to'].filter((k) => state[k]).length;
    $('filterToggle').textContent = active ? `絞り込み条件（${active}）` : '絞り込み条件';
    for (const el of document.querySelectorAll('#members .chip')) el.setAttribute('aria-pressed', state.members.includes(el.dataset.member));
    for (const el of document.querySelectorAll('#genres .chip')) el.setAttribute('aria-pressed', state.genres.includes(el.dataset.genre));
    writeUrl(push);
  }

  function syncInputs() {
    $('q').value = state.q; $('genreAnd').checked = state.genreAnd;
    for (const k of ['from', 'to', 'tod', 'dow', 'len', 'type', 'sort']) $(k).value = state[k];
  }

  const update = () => { page = 1; render(); };
  const toggle = (arr, x) => (arr.includes(x) ? arr.filter((y) => y !== x) : [...arr, x]);

  // ---- イベント ----
  let timer;
  $('q').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { state.q = e.target.value; update(); }, 150); });
  for (const k of ['from', 'to', 'tod', 'dow', 'len', 'type', 'sort']) $(k).addEventListener('change', (e) => { state[k] = e.target.value; update(); });
  $('genreAnd').addEventListener('change', (e) => { state.genreAnd = e.target.checked; update(); });
  $('members').addEventListener('click', (e) => { const b = e.target.closest('[data-member]'); if (b) { state.members = toggle(state.members, b.dataset.member); update(); } });
  $('genres').addEventListener('click', (e) => { const b = e.target.closest('[data-genre]'); if (b) { state.genres = toggle(state.genres, b.dataset.genre); update(); } });
  $('list').addEventListener('click', (e) => {
    const b = e.target.closest('.tag'); if (!b) return;
    if (!state.genres.includes(b.dataset.genre)) state.genres = [...state.genres, b.dataset.genre];
    update(); window.scrollTo({ top: 0, behavior: 'smooth' });
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
  $('filterToggle').addEventListener('click', (e) => {
    const open = $('filters').classList.toggle('open');
    e.currentTarget.setAttribute('aria-expanded', open);
  });
  for (const id of ['pagerTop', 'pagerBottom']) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('[data-page]'); if (!b || b.disabled) return;
      page = Number(b.dataset.page); render(true);
      $('count').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  window.addEventListener('popstate', () => { readUrl(); syncInputs(); render(); });
  $('reset').addEventListener('click', () => {
    Object.assign(state, { q: '', members: [], genres: [], genreAnd: false, from: '', to: '', tod: '', dow: '', len: '', type: '', sort: 'new' });
    syncInputs(); update();
  });

  // ---- 初期化 ----
  if (DATA.updatedAt) {
    const j = new Date(Date.parse(DATA.updatedAt) + JST);
    $('updated').textContent = `データ更新: ${j.getUTCFullYear()}/${pad(j.getUTCMonth() + 1)}/${pad(j.getUTCDate())} ${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())}（${videos.length.toLocaleString()} 件）`;
  }
  readUrl(); syncInputs(); renderChips(); render();
})();
