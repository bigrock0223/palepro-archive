// 確認モード（review.html）
// 自動判定・Excel の結果を1件ずつ（または一覧でまとめて）確認し、結果を GitHub の config/site-edits.json に保存する。
// 保存には、このブラウザにだけ保存した GitHub の鍵（fine-grained personal access token）を使う。
(() => {
  const D = window.PALEPRO_DATA;
  const R = window.PALEPRO_REVIEW || { reviewed: [], base: {}, series: [], info: {}, excelGenres: [], newGenres: [] };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const JST = 9 * 3600e3;
  const today = () => { const j = new Date(Date.now() + JST); return `${j.getUTCFullYear()}-${pad(j.getUTCMonth() + 1)}-${pad(j.getUTCDate())}`; };
  const FALLBACK = 'その他';
  const LS_CONFIG = 'palepro-review-config';
  const LS_PENDING = 'palepro-review-pending';
  const LS_TODAY = 'palepro-review-today';
  const TYPE_LABEL = { live: '配信', video: '動画', short: 'ショート' };
  const TYPE_CODE = { '配信': 'live', '動画': 'video', 'ショート': 'short' };
  const REASONS = {
    noGenre: ['ジャンルが空（その他）', 3],
    officialNoCast: ['公式チャンネルで出演者が空', 3],
    unitSolo: ['個人チャンネルにユニット名', 3],
    weakCast: ['愛称・コンビ名だけで出演者を判定', 2],
    allMembers: ['全員回の自動付与', 2],
    typeCheck: ['種類が微妙（3分以内・#shortsなし）', 1],
  };
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できない環境でも動かす */ } };

  // ---- 基本データ ----
  const chMap = Object.fromEntries(D.channels.map((c) => [c.key, c]));
  const shortName = (c) => c.name.replace(/^(暁月|七海|常磐|藤宮|江波|鬼多見|香鳴|夏渚)/, '');
  const chStyle = (c) => `--c:${c.color}` + (c.gradient ? `;--g:${c.gradient}` : '') + (c.ring ? `;--r:${c.ring}` : '');
  const memberKeys = D.channels.map((c) => c.key).filter((k) => k !== 'official' && D.videos.some((v) => v.p && v.p.includes(k)));
  const keyByName = Object.fromEntries(memberKeys.map((k) => [shortName(chMap[k]), k]));
  const units = D.units || [];
  const byId = new Map(D.videos.map((v) => [v.id, v]));
  const reviewedAtBuild = new Set(R.reviewed || []);
  const norm = (s = '') => s.normalize('NFKC').toLowerCase().replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

  // ---- 保存状態 ----
  let config = lsGet(LS_CONFIG, null);           // { token, owner, repo, branch, local }
  let remote = { sha: null, data: { newGenres: [], videos: {} }, loaded: false };
  let pending = lsGet(LS_PENDING, { newGenres: [], videos: {} });
  let undoStack = [];
  let sinceSave = 0;
  let saving = false;
  let lastSavedAt = null;
  let todayStat = lsGet(LS_TODAY, { day: today(), n: 0 });
  if (todayStat.day !== today()) todayStat = { day: today(), n: 0 };

  const editOf = (id) => (id in pending.videos ? pending.videos[id] : remote.data.videos[id]);
  const allNewGenres = () => {
    const m = new Map();
    for (const g of [...(R.newGenres || []), ...(remote.data.newGenres || []), ...(pending.newGenres || [])]) if (g && g.name) m.set(g.name, g);
    return [...m.values()];
  };
  const genreList = () => {
    const names = [...(R.excelGenres || [])];
    for (const g of allNewGenres()) if (!names.includes(g.name)) names.push(g.name);
    for (const g of D.genres) if (g !== FALLBACK && !names.includes(g) && D.videos.some((v) => v.g.includes(g) || v.m.includes(g))) names.push(g);
    return names;
  };

  // 修正前（Excel・自動判定）の状態
  function baseOf(id) {
    if (R.base && R.base[id]) return R.base[id];
    const v = byId.get(id);
    return { ty: v.ty, g: [...v.m, ...v.g].filter((x) => x !== FALLBACK), p: v.p || [], u: v.u || [] };
  }
  // 今の状態（修正前 ＋ 確認画面の修正）
  function currentOf(id) {
    const b = baseOf(id);
    const e = editOf(id);
    const cur = { ty: b.ty, g: [...b.g], p: [...b.p], u: [...b.u] };
    if (e) {
      if (e.type && TYPE_CODE[e.type]) cur.ty = TYPE_CODE[e.type];
      if (Array.isArray(e.genres)) cur.g = [...e.genres];
      if (Array.isArray(e.cast)) cur.p = memberKeys.filter((k) => e.cast.includes(shortName(chMap[k])));
      if (Array.isArray(e.units)) cur.u = [...e.units];
    }
    return cur;
  }
  const isReviewed = (id) => { const e = editOf(id); return !!(e && e.reviewed) || reviewedAtBuild.has(id); };
  const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

  // 状態から保存用の記録を作る（修正前と違う項目だけを書く）
  function makeEntry(id, state, reviewed) {
    const b = baseOf(id);
    const prev = editOf(id) || {};
    const e = {};
    const rv = reviewed === undefined ? prev.reviewed : reviewed;
    if (rv) e.reviewed = rv;
    if (state.ty !== b.ty) e.type = TYPE_LABEL[state.ty];
    if (!sameSet(state.g, b.g)) e.genres = [...state.g];
    if (!sameSet(state.p, b.p)) e.cast = state.p.map((k) => shortName(chMap[k]));
    if (!sameSet(state.u, b.u)) e.units = [...state.u];
    return Object.keys(e).length ? e : null;
  }
  // 複数の動画の記録をまとめて書き換える（取り消し用の記録も残す）
  function commitEntries(map, label) {
    const prev = {};
    // 取り消し用に「その時点の記録」（保存済みの分も含む）を控える。保存後に取り消した場合も、次の保存で元に戻る
    for (const id of Object.keys(map)) prev[id] = editOf(id) ?? null;
    undoStack.push({ prev, label });
    if (undoStack.length > 50) undoStack.shift();
    for (const [id, e] of Object.entries(map)) {
      // 記録が空になる場合も、GitHub側の古い記録を消すために null を入れておく
      pending.videos[id] = e;
    }
    persistPending();
    sinceSave += Object.keys(map).length;
    if (sinceSave >= 20) save();
  }
  function persistPending() { lsSet(LS_PENDING, pending); updateStatus(); }
  const pendingCount = () => Object.keys(pending.videos).length + (pending.newGenres || []).length;

  // ---- GitHub とのやりとり ----
  function defaultRepo() {
    const h = location.hostname;
    if (h.endsWith('.github.io')) return { owner: h.split('.')[0], repo: location.pathname.split('/').filter(Boolean)[0] || '' };
    return { owner: '', repo: 'palepro-archive' };
  }
  const api = (path, opts = {}) => fetch(`https://api.github.com/repos/${config.owner}/${config.repo}${path}`, {
    ...opts,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${config.token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) },
  });
  async function loadRemote() {
    if (!config || config.local) { remote.loaded = true; return; }
    const br = encodeURIComponent(config.branch || 'main');
    const dir = await api(`/contents/config?ref=${br}`);
    if (!dir.ok) throw new Error(`GitHubに接続できません（${dir.status}）。鍵とリポジトリ名を確認してください。`);
    const f = (await dir.json()).find((x) => x.name === 'site-edits.json');
    if (!f) { remote = { sha: null, data: { newGenres: [], videos: {} }, loaded: true }; return; }
    const raw = await api(`/contents/config/site-edits.json?ref=${br}`, { headers: { Accept: 'application/vnd.github.raw' } });
    if (!raw.ok) throw new Error(`site-edits.json を読み込めません（${raw.status}）`);
    const txt = (await raw.text()).trim();
    const data = txt ? JSON.parse(txt) : {};
    remote = { sha: f.sha, data: { newGenres: data.newGenres || [], videos: data.videos || {} }, loaded: true };
  }
  // 1動画1行の読みやすいJSONにする（差分が見やすく、Gitで扱いやすい）
  function stringify(data) {
    const vids = Object.entries(data.videos).filter(([, e]) => e).sort(([a], [b]) => a.localeCompare(b));
    return '{\n  "newGenres": [' + data.newGenres.map((g) => '\n    ' + JSON.stringify(g)).join(',') + (data.newGenres.length ? '\n  ' : '') + '],\n'
      + '  "videos": {' + vids.map(([id, e]) => `\n    ${JSON.stringify(id)}: ${JSON.stringify(e)}`).join(',') + (vids.length ? '\n  ' : '') + '}\n}\n';
  }
  const b64 = (str) => {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  async function save() {
    if (saving || !pendingCount()) return;
    if (!config) { openSettings(); return; }
    saving = true; updateStatus();
    const snapshot = JSON.parse(JSON.stringify(pending));
    try {
      if (config.local) {
        // 鍵なしのお試し：このブラウザの中にだけ保存
        Object.assign(remote.data.videos, snapshot.videos);
        mergeGenres(remote.data, snapshot.newGenres);
        lsSet('palepro-review-local', remote.data);
      } else {
        for (let attempt = 0; attempt < 3; attempt++) {
          await loadRemote();
          const merged = { newGenres: [...remote.data.newGenres], videos: { ...remote.data.videos } };
          for (const [id, e] of Object.entries(snapshot.videos)) { if (e) merged.videos[id] = e; else delete merged.videos[id]; }
          mergeGenres(merged, snapshot.newGenres);
          const n = Object.keys(snapshot.videos).length;
          const res = await api('/contents/config/site-edits.json', {
            method: 'PUT',
            body: JSON.stringify({
              message: `確認モード: ${n}件を更新${snapshot.newGenres.length ? `・ジャンル追加 ${snapshot.newGenres.map((g) => g.name).join('、')}` : ''}`,
              content: b64(stringify(merged)),
              branch: config.branch || 'main',
              ...(remote.sha ? { sha: remote.sha } : {}),
            }),
          });
          if (res.ok) { remote = { sha: (await res.json()).content.sha, data: merged, loaded: true }; break; }
          if ((res.status === 409 || res.status === 422) && attempt < 2) continue; // 別の端末が先に保存した → 読み直してやり直す
          throw new Error(`保存できませんでした（${res.status}）${res.status === 401 || res.status === 403 ? '：鍵の権限や有効期限を確認してください' : ''}`);
        }
      }
      // 保存中に増えた分は残し、保存できた分だけ消す
      for (const [id, e] of Object.entries(snapshot.videos)) if (JSON.stringify(pending.videos[id]) === JSON.stringify(e)) delete pending.videos[id];
      pending.newGenres = (pending.newGenres || []).filter((g) => !snapshot.newGenres.some((s) => s.name === g.name));
      persistPending();
      sinceSave = 0;
      lastSavedAt = new Date();
      statusMsg = '';
    } catch (err) {
      statusMsg = err.message;
    } finally {
      saving = false; updateStatus();
    }
  }
  function mergeGenres(data, list) {
    for (const g of list || []) {
      const i = data.newGenres.findIndex((x) => x.name === g.name);
      if (i >= 0) data.newGenres[i] = g; else data.newGenres.push(g);
    }
  }
  let statusMsg = '';
  setInterval(() => { if (pendingCount() && !saving) save(); }, 120000); // 2分ごとに自動保存
  window.addEventListener('beforeunload', (e) => { if (pendingCount()) { e.preventDefault(); e.returnValue = ''; } });

  // ---- 絞り込みと並び順 ----
  const F = { view: 'single', channel: '', type: '', reason: '', scope: 'todo', seriesFirst: true, q: '' };
  let queue = [];   // [{ id, rep }]
  let pos = 0;
  let lastState = null; // 「前の動画と同じ」用
  const infoOf = (id) => (R.info && R.info[id]) || [[], -1];
  function buildQueue(keepId) {
    const q = norm(F.q).split(/\s+/).filter(Boolean);
    const list = D.videos.filter((v) => {
      const done = isReviewed(v.id);
      if (F.scope === 'todo' && done) return false;
      if (F.scope === 'done' && !done) return false;
      if (F.channel && v.c !== F.channel) return false;
      if (F.type && currentOf(v.id).ty !== F.type) return false;
      if (F.reason && !infoOf(v.id)[0].includes(F.reason)) return false;
      if (q.length) { const t = norm(v.t); if (!q.every((w) => t.includes(w))) return false; }
      return true;
    });
    const weight = (id) => infoOf(id)[0].reduce((n, r) => n + (REASONS[r] ? REASONS[r][1] : 0), 0);
    const chOrder = Object.fromEntries(D.channels.map((c, i) => [c.key, i]));
    const sorted = list.slice().sort((a, b) => weight(b.id) - weight(a.id) || chOrder[a.c] - chOrder[b.c]
      || infoOf(a.id)[1] - infoOf(b.id)[1] || b.s.localeCompare(a.s));
    let out = sorted.map((v) => ({ id: v.id, rep: false }));
    if (F.seriesFirst) {
      const groups = new Map();
      for (const v of list) { const si = infoOf(v.id)[1]; if (si >= 0) { if (!groups.has(si)) groups.set(si, []); groups.get(si).push(v); } }
      const reps = [...groups.values()].filter((g) => g.length >= 2).sort((a, b) => b.length - a.length).map((g) => g[0].id);
      const repSet = new Set(reps);
      out = [...reps.map((id) => ({ id, rep: true })), ...out.filter((x) => !repSet.has(x.id))];
    }
    queue = out;
    pos = keepId ? Math.max(0, queue.findIndex((x) => x.id === keepId)) : 0;
    if (pos >= queue.length) pos = Math.max(0, queue.length - 1);
  }
  function seriesMembers(si) { return D.videos.filter((v) => infoOf(v.id)[1] === si); }

  // ---- 状態表示 ----
  function updateStatus() {
    const total = D.videos.length;
    const done = D.videos.filter((v) => isReviewed(v.id)).length;
    $('progressText').textContent = `確認済み ${done.toLocaleString()} / ${total.toLocaleString()}件（残り ${(total - done).toLocaleString()}）`;
    $('progressBar').style.width = `${(done / total) * 100}%`;
    $('todayText').textContent = `今日 ${todayStat.n}件`;
    const n = pendingCount();
    const t = $('saveText');
    t.className = 'rv-save-text';
    if (statusMsg) { t.textContent = statusMsg; t.classList.add('err'); }
    else if (saving) t.textContent = '保存中…';
    else if (n) { t.textContent = `未保存 ${n}件`; t.classList.add('warn'); }
    else if (lastSavedAt) t.textContent = `保存しました ${pad(lastSavedAt.getHours())}:${pad(lastSavedAt.getMinutes())}（サイトへの反映は数分後）`;
    else t.textContent = config && config.local ? 'お試しモード（このブラウザにだけ保存）' : '';
    $('saveBtn').disabled = !n || saving;
    $('undoBtn').disabled = !undoStack.length;
  }

  // ---- 表示部品 ----
  function fmtDate(s) {
    const j = new Date(Date.parse(s) + JST);
    return `${j.getUTCFullYear()}/${pad(j.getUTCMonth() + 1)}/${pad(j.getUTCDate())}(${'日月火水木金土'[j.getUTCDay()]}) ${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())}`;
  }
  function fmtDur(s) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}:${pad(m)}:${pad(x)}` : `${m}:${pad(x)}`; }
  function thumbHtml(v) {
    const ch = chMap[v.c] || { color: '#999', name: v.c };
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`;
    const img = v.th ? `<img loading="lazy" src="${esc(v.th)}" alt="" onerror="this.remove()">` : '';
    return `<a class="rv-thumb" href="${url}" target="_blank" rel="noopener" style="${chStyle(ch)}">${img}<span class="dur">${fmtDur(v.d)}</span></a>`;
  }
  // 概要欄は16個のファイルに分けてあり、必要になったときだけ読み込む
  const descLoaded = new Set();
  function descChunk(id) { let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 16; }
  function loadDesc(id) {
    const n = descChunk(id);
    if (descLoaded.has(n)) return Promise.resolve();
    descLoaded.add(n);
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = `data/desc/d${n}.js`; s.onload = resolve; s.onerror = resolve;
      document.head.appendChild(s);
    });
  }

  // ---- 1件ずつ ----
  let draft = null;
  function renderSingle() {
    const item = queue[pos];
    $('emptyMsg').hidden = !!item;
    $('singleView').hidden = !item;
    if (!item) return;
    const v = byId.get(item.id);
    const ch = chMap[v.c] || { name: v.c, color: '#999' };
    const [reasons, si] = infoOf(v.id);
    draft = currentOf(v.id);
    const done = isReviewed(v.id);
    $('itemPane').innerHTML = `
      <div class="rv-pos">${pos + 1} / ${queue.length}件目${item.rep ? '<span class="rv-rep">シリーズ代表</span>' : ''}</div>
      ${thumbHtml(v)}
      <h2 class="rv-itemtitle"><a href="https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}" target="_blank" rel="noopener">${esc(v.t)}</a></h2>
      <div class="rv-meta"><span class="who" style="${chStyle(ch)}"><span class="dot"></span>${esc(ch.name)}</span>
        <span>${fmtDate(v.s)}</span><span>${fmtDur(v.d)}</span></div>
      <div class="rv-reasons">${done ? '<span class="rv-badge-done">確認済み</span>' : ''}${reasons.map((r) => `<span class="rv-reason">⚠ ${esc(REASONS[r] ? REASONS[r][0] : r)}</span>`).join('')}</div>
      <div class="rv-desc empty" id="descBox">概要欄を読み込み中…</div>`;
    loadDesc(v.id).then(() => {
      const box = $('descBox');
      if (!box || queue[pos]?.id !== v.id) return;
      const d = (window.PALEPRO_DESC || {})[v.id];
      box.className = 'rv-desc' + (d ? '' : ' empty');
      box.textContent = d || '（概要欄のデータはまだありません。次回の自動更新で取得されます）';
    });
    renderEdit();
    renderSeries(v, si);
    $('prevBtn').disabled = pos === 0;
    $('sameBtn').disabled = !lastState;
  }
  function chip(kind, key, label, on, changed, style = '') {
    return `<button type="button" class="rv-chip ${kind}${on ? ' on' : ''}${changed ? ' changed' : ''}" data-kind="${kind}" data-key="${esc(key)}" ${style ? `style="${style}"` : ''}>${kind === 'cast' ? '<span class="dot"></span>' : ''}${esc(label)}</button>`;
  }
  function renderEdit() {
    const id = queue[pos].id;
    const b = baseOf(id);
    const tyHtml = ['live', 'video', 'short'].map((t) => chip('type', t, TYPE_LABEL[t], draft.ty === t, draft.ty === t && b.ty !== t)).join('');
    const gHtml = genreList().map((g) => chip('genre', g, g, draft.g.includes(g), draft.g.includes(g) !== b.g.includes(g))).join('')
      + '<button type="button" class="rv-chip newg" id="newGenreBtn">＋新しいジャンル</button>';
    const pHtml = memberKeys.map((k) => chip('cast', k, shortName(chMap[k]), draft.p.includes(k), draft.p.includes(k) !== b.p.includes(k), chStyle(chMap[k]))).join('');
    const uHtml = units.map((u) => chip('unit', u, u, draft.u.includes(u), draft.u.includes(u) !== b.u.includes(u))).join('');
    $('editPane').innerHTML = `
      <div class="rv-box"><h3>種類</h3><div class="rv-chips rv-type">${tyHtml}</div></div>
      <div class="rv-box"><h3>ジャンル</h3><div class="rv-chips">${gHtml}</div></div>
      <div class="rv-box"><h3>出演者</h3><div class="rv-chips">${pHtml}</div></div>
      <div class="rv-box"><h3>ユニット</h3><div class="rv-chips">${uHtml}</div></div>`;
  }
  function renderSeries(v, si) {
    if (si < 0 || !R.series[si]) { $('seriesPane').innerHTML = ''; return; }
    const members = seriesMembers(si);
    const todo = members.filter((x) => !isReviewed(x.id) && x.id !== v.id);
    $('seriesPane').innerHTML = `シリーズ：<span class="name">${esc(R.series[si][1])}</span>（${esc(chMap[R.series[si][0]]?.name || '')}・全${members.length}件、ほかに未確認 ${todo.length}件）<br>
      <button type="button" class="rv-btn primary" id="seriesApplyBtn" ${todo.length ? '' : 'disabled'}>未確認の${todo.length}件にも同じジャンル・ユニットを付けてOK</button>
      <button type="button" class="rv-btn" id="seriesListBtn">一覧を見る</button>`;
  }
  function toggleDraft(kind, key) {
    if (kind === 'type') draft.ty = key;
    else {
      const f = { genre: 'g', cast: 'p', unit: 'u' }[kind];
      draft[f] = draft[f].includes(key) ? draft[f].filter((x) => x !== key) : [...draft[f], key];
    }
    renderEdit();
  }
  function confirmCurrent(extra = {}) {
    const item = queue[pos];
    if (!item) return;
    const map = { [item.id]: makeEntry(item.id, draft, today()), ...extra };
    commitEntries(map, '確認');
    countToday(Object.keys(map).length);
    lastState = { g: [...draft.g], p: [...draft.p], u: [...draft.u] };
    advanceAfterConfirm(Object.keys(map));
  }
  function advanceAfterConfirm(ids) {
    const curId = queue[pos]?.id;
    if (F.scope === 'todo') {
      const rm = new Set(ids);
      const before = queue.slice(0, pos).filter((x) => !rm.has(x.id)).length;
      queue = queue.filter((x) => !rm.has(x.id));
      pos = Math.min(before, Math.max(0, queue.length - 1));
    } else {
      pos = Math.min(queue.findIndex((x) => x.id === curId) + 1, queue.length - 1);
    }
    render();
  }
  function countToday(n) {
    if (todayStat.day !== today()) todayStat = { day: today(), n: 0 };
    todayStat.n += n; lsSet(LS_TODAY, todayStat);
  }
  function applySeries() {
    const item = queue[pos];
    const si = infoOf(item.id)[1];
    const targets = seriesMembers(si).filter((x) => !isReviewed(x.id) && x.id !== item.id);
    const g = genreNamesStr(draft.g), u = draft.u.join('・') || 'なし';
    openModal(`<h2>シリーズにまとめて適用</h2>
      <p>「${esc(R.series[si][1])}」の未確認 <b>${targets.length}件</b> に、<br>ジャンル：<b>${esc(g)}</b> ／ ユニット：<b>${esc(u)}</b><br>を付けて確認済みにします。種類と出演者は、それぞれの動画のままです。</p>
      <ul class="rv-list">${targets.slice(0, 200).map((x) => `<li><span class="m">${fmtDate(x.s).slice(0, 10)}</span>${esc(x.t)}</li>`).join('')}</ul>
      <div class="rv-form"><div class="row"><button type="button" class="rv-btn" data-close>やめる</button><button type="button" class="rv-btn primary" id="seriesGo">適用する</button></div></div>`);
    $('seriesGo').onclick = () => {
      const extra = {};
      for (const x of targets) {
        const cur = currentOf(x.id);
        extra[x.id] = makeEntry(x.id, { ...cur, g: [...draft.g], u: [...draft.u] }, today());
      }
      closeModal();
      confirmCurrent(extra);
    };
  }
  const genreNamesStr = (gs) => (gs.length ? gs.join('・') : 'なし（その他）');
  function showSeriesList() {
    const item = queue[pos];
    const si = infoOf(item.id)[1];
    const members = seriesMembers(si);
    openModal(`<h2>シリーズ：${esc(R.series[si][1])}（${members.length}件）</h2>
      <ul class="rv-list">${members.map((x) => { const c = currentOf(x.id); const done = isReviewed(x.id);
        return `<li class="${done ? 'done' : ''}"><span class="m">${done ? '✔ ' : ''}${fmtDate(x.s).slice(0, 10)}</span><span>${esc(x.t)}<br><span class="m">${esc(genreNamesStr(c.g))}</span></span></li>`; }).join('')}</ul>`);
  }

  // ---- 一覧で一括 ----
  const PAGE = 60;
  let gridPage = 1;
  const selected = new Set();
  const bulk = { g: {}, p: {}, u: {}, ty: '' }; // 値: 'add' / 'remove'
  function renderGrid() {
    const total = queue.length;
    $('emptyMsg').hidden = total > 0;
    $('gridView').hidden = total === 0;
    if (!total) return;
    const pages = Math.max(1, Math.ceil(total / PAGE));
    gridPage = Math.min(gridPage, pages);
    const items = queue.slice((gridPage - 1) * PAGE, gridPage * PAGE);
    $('gridList').innerHTML = items.map(({ id }) => {
      const v = byId.get(id); const c = currentOf(id); const ch = chMap[v.c] || { name: v.c };
      const tags = [...c.g.map((g) => `<span>${esc(g)}</span>`), ...c.p.map((k) => `<span class="c">${esc(shortName(chMap[k]))}</span>`), ...c.u.map((u) => `<span class="u">${esc(u)}</span>`)].join('');
      return `<li class="rv-card${selected.has(id) ? ' sel' : ''}" data-id="${esc(id)}"><input type="checkbox" ${selected.has(id) ? 'checked' : ''} aria-label="選択">
        ${thumbHtml(v)}<div class="body"><div class="t">${esc(v.t)}</div><div class="m">${esc(ch.name)}・${fmtDate(v.s).slice(0, 10)}・${TYPE_LABEL[c.ty]}${isReviewed(id) ? '・✔確認済み' : ''}</div><div class="tags">${tags || '<span>ジャンルなし</span>'}</div></div></li>`;
    }).join('');
    $('gridCount').textContent = `${total.toLocaleString()}件中 ${((gridPage - 1) * PAGE + 1).toLocaleString()}〜${Math.min(gridPage * PAGE, total).toLocaleString()}件目 ／ 選択 ${selected.size}件`;
    $('selectPage').checked = items.length > 0 && items.every(({ id }) => selected.has(id));
    $('gridPager').innerHTML = pages > 1 ? [
      `<button type="button" data-page="${gridPage - 1}" ${gridPage === 1 ? 'disabled' : ''}>‹</button>`,
      `<span class="gap">${gridPage} / ${pages}</span>`,
      `<button type="button" data-page="${gridPage + 1}" ${gridPage === pages ? 'disabled' : ''}>›</button>`].join('') : '';
    renderBulk();
  }
  function renderBulk() {
    const st = (f, k) => bulk[f][k] || '';
    const c3 = (kind, f, k, label, style = '') => `<button type="button" class="rv-chip ${kind} ${st(f, k)}" data-bulk="${f}" data-key="${esc(k)}" ${style ? `style="${style}"` : ''}>${kind === 'cast' ? '<span class="dot"></span>' : ''}${esc(label)}</button>`;
    $('bulkPane').innerHTML = `
      <div class="rv-box"><h3>種類</h3><select id="bulkType"><option value="">変更しない</option><option value="live">配信</option><option value="video">動画</option><option value="short">ショート</option></select></div>
      <div class="rv-box"><h3>ジャンル</h3><div class="rv-chips">${genreList().map((g) => c3('genre', 'g', g, g)).join('')}<button type="button" class="rv-chip newg" id="newGenreBtn2">＋新しいジャンル</button></div></div>
      <div class="rv-box"><h3>出演者</h3><div class="rv-chips">${memberKeys.map((k) => c3('cast', 'p', k, shortName(chMap[k]), chStyle(chMap[k]))).join('')}</div></div>
      <div class="rv-box"><h3>ユニット</h3><div class="rv-chips">${units.map((u) => c3('unit', 'u', u, u)).join('')}</div></div>`;
    $('bulkType').value = bulk.ty;
    $('bulkApplyBtn').disabled = !selected.size;
    $('bulkOkBtn').disabled = !selected.size;
  }
  function applyBulk(withChanges) {
    const map = {};
    for (const id of selected) {
      const c = currentOf(id);
      if (withChanges) {
        for (const f of ['g', 'p', 'u']) for (const [k, op] of Object.entries(bulk[f])) {
          if (op === 'add' && !c[f].includes(k)) c[f].push(k);
          if (op === 'remove') c[f] = c[f].filter((x) => x !== k);
        }
        if (bulk.ty) c.ty = bulk.ty;
      }
      map[id] = makeEntry(id, c, today());
    }
    if (!Object.keys(map).length) return;
    commitEntries(map, '一括');
    countToday(Object.keys(map).length);
    selected.clear();
    if (F.scope === 'todo') { const rm = new Set(Object.keys(map)); queue = queue.filter((x) => !rm.has(x.id)); }
    render();
  }

  // ---- 新しいジャンル ----
  function existsGenre(name) { const n = norm(name); return genreList().some((g) => norm(g) === n); }
  const FIXED = ['配信日時', 'メンバー', '種類', '長さ', 'タイトル', '確認済', 'メモ', '動画ID', 'URL', 'その他'];
  function openNewGenre(fromGrid) {
    openModal(`<h2>新しいジャンルを追加</h2>
      <div class="rv-form">
        <label>ジャンル名<input type="text" id="ngName" placeholder="例：料理"></label>
        <label>自動判定用のキーワード（任意・「、」かスペース区切り）<input type="text" id="ngKw" placeholder="例：料理、クッキング、手作り"></label>
        <p class="rv-hint">キーワードを入れると、新着動画にもこのジャンルが自動で付きます。追加したあと、キーワードで過去の動画を探して、まとめて付けることもできます。</p>
        <div class="rv-err" id="ngErr"></div>
        <div class="row"><button type="button" class="rv-btn" data-close>やめる</button><button type="button" class="rv-btn primary" id="ngGo">追加する</button></div>
      </div>`);
    $('ngName').focus();
    $('ngGo').onclick = () => {
      const name = $('ngName').value.trim();
      const kws = $('ngKw').value.split(/[、,，\s]+/).map((x) => x.trim()).filter(Boolean);
      let err = '';
      if (!name) err = 'ジャンル名を入れてください。';
      else if (existsGenre(name)) err = '同じ名前のジャンルがすでにあります。';
      else if (/^(出演|ユニット)[:：]/.test(name) || FIXED.includes(name)) err = 'この名前はジャンル名に使えません。';
      if (err) { $('ngErr').textContent = err; return; }
      pending.newGenres = [...(pending.newGenres || []), { name, keywords: kws, added: today() }];
      undoStack.push({ newGenre: name, label: 'ジャンル追加' });
      persistPending();
      if (!fromGrid && draft) { draft.g = [...draft.g, name]; renderEdit(); }
      if (fromGrid) { bulk.g[name] = 'add'; renderBulk(); }
      openFinder(name, kws.join(' ') || name);
    };
  }

  // ---- キーワードで探してまとめて付ける ----
  function openFinder(genre, kw = '') {
    const opts = genreList().map((g) => `<option ${g === genre ? 'selected' : ''}>${esc(g)}</option>`).join('');
    openModal(`<h2>キーワードで探して付ける</h2>
      <div class="rv-form">
        <label>付けるジャンル<select id="fdGenre">${opts}</select></label>
        <label>キーワード（スペース区切りで「どれかを含む」）<input type="text" id="fdKw" value="${esc(kw)}"></label>
        <p class="rv-hint">タイトルから探します（確認済みの動画も含みます）。付けても確認済みかどうかは変わりません。</p>
        <div id="fdCount" class="rv-hint"></div>
        <ul class="rv-list" id="fdList"></ul>
        <div class="row"><button type="button" class="rv-btn" data-close>閉じる</button><button type="button" class="rv-btn primary" id="fdGo">チェックした動画に付ける</button></div>
      </div>`);
    let hits = [];
    const run = () => {
      const g = $('fdGenre').value;
      const words = norm($('fdKw').value).split(/\s+/).filter(Boolean);
      hits = words.length ? D.videos.filter((v) => { const t = norm(v.t); return words.some((w) => t.includes(w)); }) : [];
      $('fdCount').textContent = words.length ? `${hits.length}件見つかりました（すでに「${g}」が付いている動画はチェックなし）` : '';
      $('fdList').innerHTML = hits.slice(0, 500).map((v) => {
        const has = currentOf(v.id).g.includes(g);
        return `<li><input type="checkbox" data-id="${esc(v.id)}" ${has ? 'disabled' : 'checked'}><span class="m">${fmtDate(v.s).slice(0, 10)}</span><span>${esc(v.t)}${has ? '<br><span class="m">付与済み</span>' : ''}</span></li>`;
      }).join('') + (hits.length > 500 ? '<li class="m">500件まで表示しています。キーワードを絞ってください。</li>' : '');
    };
    $('fdKw').addEventListener('input', run);
    $('fdGenre').addEventListener('change', run);
    run();
    $('fdGo').onclick = () => {
      const g = $('fdGenre').value;
      const ids = [...$('fdList').querySelectorAll('input:checked')].map((x) => x.dataset.id);
      if (!ids.length) return;
      const map = {};
      for (const id of ids) { const c = currentOf(id); if (!c.g.includes(g)) c.g.push(g); map[id] = makeEntry(id, c); }
      commitEntries(map, 'キーワードで付与');
      closeModal();
      render();
    };
  }

  // ---- 鍵の設定 ----
  function openSettings(msg = '') {
    const d = defaultRepo();
    const c = config || {};
    openModal(`<h2>鍵の設定</h2>
      <p>確認結果は GitHub のリポジトリ（config/site-edits.json）に保存します。GitHub で作った鍵（fine-grained personal access token）を貼り付けてください。鍵はこのブラウザの中にだけ保存されます。作り方は README を見てください。</p>
      <div class="rv-form">
        <label>鍵（github_pat_…）<input type="password" id="stToken" value="${esc(c.token || '')}" autocomplete="off"></label>
        <label>GitHubのユーザー名<input type="text" id="stOwner" value="${esc(c.owner || d.owner)}"></label>
        <label>リポジトリ名<input type="text" id="stRepo" value="${esc(c.repo || d.repo)}"></label>
        <label>ブランチ<input type="text" id="stBranch" value="${esc(c.branch || 'main')}"></label>
        <div class="rv-err" id="stErr">${esc(msg)}</div>
        <div class="row">
          <button type="button" class="rv-btn" id="stLocal">鍵なしで試す（このブラウザにだけ保存）</button>
          ${config && !config.local ? '<button type="button" class="rv-btn" id="stDelete">鍵を削除</button>' : ''}
          <button type="button" class="rv-btn primary" id="stSave">接続して保存</button>
        </div>
      </div>`);
    $('stSave').onclick = async () => {
      const next = { token: $('stToken').value.trim(), owner: $('stOwner').value.trim(), repo: $('stRepo').value.trim(), branch: $('stBranch').value.trim() || 'main' };
      if (!next.token || !next.owner || !next.repo) { $('stErr').textContent = '鍵・ユーザー名・リポジトリ名を入れてください。'; return; }
      const prev = config; config = next;
      try { await loadRemote(); lsSet(LS_CONFIG, config); closeModal(); statusMsg = ''; buildQueue(); render(); }
      catch (e) { config = prev; $('stErr').textContent = e.message; }
    };
    $('stLocal').onclick = () => {
      config = { local: true }; lsSet(LS_CONFIG, config);
      remote = { sha: null, data: lsGet('palepro-review-local', { newGenres: [], videos: {} }), loaded: true };
      closeModal(); buildQueue(); render();
    };
    if ($('stDelete')) $('stDelete').onclick = () => { try { localStorage.removeItem(LS_CONFIG); } catch { /* */ } config = null; closeModal(); openSettings('鍵を削除しました。'); };
  }

  // ---- ダイアログ ----
  function openModal(html) { $('modalBody').innerHTML = html; $('modal').hidden = false; }
  function closeModal() { $('modal').hidden = true; $('modalBody').innerHTML = ''; }
  $('modalClose').onclick = closeModal;
  $('modal').addEventListener('click', (e) => { if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal(); });

  // ---- 取り消し ----
  function undo() {
    const u = undoStack.pop();
    if (!u) return;
    if (u.newGenre) pending.newGenres = (pending.newGenres || []).filter((g) => g.name !== u.newGenre);
    else for (const [id, e] of Object.entries(u.prev)) {
      // 元の記録が GitHub 側と同じなら保存待ちから外す。違えば（保存後の取り消し）元の記録を保存待ちに入れる
      if (JSON.stringify(remote.data.videos[id] ?? null) === JSON.stringify(e)) delete pending.videos[id]; else pending.videos[id] = e;
    }
    persistPending();
    const firstId = u.prev ? Object.keys(u.prev)[0] : queue[pos]?.id;
    buildQueue(firstId);
    render();
  }

  // ---- 描画 ----
  function render() {
    $('singleView').hidden = F.view !== 'single';
    $('gridView').hidden = F.view !== 'grid';
    if (F.view === 'single') renderSingle(); else renderGrid();
    updateStatus();
  }

  // ---- イベント ----
  $('editPane').addEventListener('click', (e) => {
    if (e.target.closest('#newGenreBtn')) { openNewGenre(false); return; }
    const b = e.target.closest('.rv-chip[data-kind]');
    if (b) toggleDraft(b.dataset.kind, b.dataset.key);
  });
  $('seriesPane').addEventListener('click', (e) => {
    if (e.target.closest('#seriesApplyBtn')) applySeries();
    if (e.target.closest('#seriesListBtn')) showSeriesList();
  });
  $('okBtn').onclick = () => confirmCurrent();
  $('skipBtn').onclick = () => { if (pos < queue.length - 1) { pos++; renderSingle(); } };
  $('prevBtn').onclick = () => { if (pos > 0) { pos--; renderSingle(); } };
  $('sameBtn').onclick = () => { if (lastState) { draft = { ...draft, g: [...lastState.g], p: [...lastState.p], u: [...lastState.u] }; renderEdit(); } };
  $('resetBtn').onclick = () => { const b = baseOf(queue[pos].id); draft = { ty: b.ty, g: [...b.g], p: [...b.p], u: [...b.u] }; renderEdit(); };
  $('saveBtn').onclick = () => save();
  $('undoBtn').onclick = undo;
  $('settingsBtn').onclick = () => openSettings();
  $('findBtn').onclick = () => openFinder(genreList()[0], '');

  $('gridList').addEventListener('click', (e) => {
    const li = e.target.closest('.rv-card');
    if (!li || e.target.closest('a')) return;
    const id = li.dataset.id;
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    renderGrid();
  });
  $('selectPage').addEventListener('change', (e) => {
    const items = queue.slice((gridPage - 1) * PAGE, gridPage * PAGE);
    for (const { id } of items) { if (e.target.checked) selected.add(id); else selected.delete(id); }
    renderGrid();
  });
  $('gridPager').addEventListener('click', (e) => { const b = e.target.closest('[data-page]'); if (b && !b.disabled) { gridPage = Number(b.dataset.page); renderGrid(); window.scrollTo({ top: 0 }); } });
  $('bulkPane').addEventListener('click', (e) => {
    if (e.target.closest('#newGenreBtn2')) { openNewGenre(true); return; }
    const b = e.target.closest('[data-bulk]');
    if (!b) return;
    const f = b.dataset.bulk, k = b.dataset.key;
    bulk[f][k] = bulk[f][k] === 'add' ? 'remove' : bulk[f][k] === 'remove' ? undefined : 'add';
    if (!bulk[f][k]) delete bulk[f][k];
    renderBulk();
  });
  $('bulkPane').addEventListener('change', (e) => { if (e.target.id === 'bulkType') bulk.ty = e.target.value; });
  $('bulkApplyBtn').onclick = () => applyBulk(true);
  $('bulkOkBtn').onclick = () => applyBulk(false);

  const bindFilter = (id, key, conv = (x) => x) => $(id).addEventListener('change', (e) => {
    F[key] = conv(e.target.type === 'checkbox' ? e.target.checked : e.target.value);
    selected.clear(); gridPage = 1; buildQueue(); render();
  });
  bindFilter('fView', 'view');
  bindFilter('fChannel', 'channel');
  bindFilter('fType', 'type');
  bindFilter('fReason', 'reason');
  bindFilter('fScope', 'scope');
  bindFilter('fSeriesFirst', 'seriesFirst');
  let qt;
  $('fQuery').addEventListener('input', (e) => { clearTimeout(qt); qt = setTimeout(() => { F.q = e.target.value; selected.clear(); gridPage = 1; buildQueue(); render(); }, 250); });

  document.addEventListener('keydown', (e) => {
    if (!$('modal').hidden) { if (e.key === 'Escape') closeModal(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (e.target.matches('input, select, textarea')) return;
    if (F.view !== 'single') return;
    if (e.key === 'Enter') { e.preventDefault(); confirmCurrent(); }
    else if (e.key === 'ArrowRight') $('skipBtn').click();
    else if (e.key === 'ArrowLeft') $('prevBtn').click();
  });

  // ---- 初期化 ----
  $('fChannel').innerHTML += D.channels.map((c) => `<option value="${esc(c.key)}">${esc(c.name)}</option>`).join('');
  $('fReason').innerHTML += Object.entries(REASONS).map(([k, [label]]) => `<option value="${k}">${esc(label)}</option>`).join('');
  (async () => {
    if (config && config.local) remote = { sha: null, data: lsGet('palepro-review-local', { newGenres: [], videos: {} }), loaded: true };
    else if (config) {
      try { await loadRemote(); } catch (e) { statusMsg = e.message; }
    }
    buildQueue();
    render();
    if (!config) openSettings();
  })();
})();
