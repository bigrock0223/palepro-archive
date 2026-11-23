// data/videos.json にジャンルを付けて、サイト用の public/data/archives.js を生成します。
// あわせて確認画面（review.html）用の public/data/review-data.js と public/data/desc/*.js（概要欄）も作ります。
// 使い方:  node scripts/build.mjs
// 優先順位: 確認画面での修正（config/site-edits.json） ＞ Excel（config/genres.xlsx） ＞ 自動判定
// 手動ジャンル:
//   - config/overrides.csv（ローカル）
//   - 環境変数 SHEET_CSV_URL があれば、Googleスプレッドシートの「ウェブに公開」CSVも読み込み（こちらが優先）
// CSVの列: videoId,genres,mode,memo
//   genres … 「|」か「、」区切りで複数可
//   mode   … replace（自動判定を置き換え）/ add（自動判定に追加）。空なら replace

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readXlsx } from './xlsx-read.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (p) => JSON.parse(await readFile(path.join(ROOT, p), 'utf8'));

// 表記ゆれ吸収: 全角半角・大文字小文字・カタカナ→ひらがな
export function normalize(s = '') {
  return s.normalize('NFKC').toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((x) => x.trim()));
  const h = header.map((x) => x.trim().replace(/^﻿/, ''));
  return body.map((r) => Object.fromEntries(h.map((k, i) => [k, (r[i] ?? '').trim()])));
}

async function loadOverrides() {
  const map = new Map();
  const add = (rows, src) => {
    for (const r of rows) {
      if (!r.videoId) continue;
      const genres = r.genres.split(/[|、,]/).map((g) => g.trim()).filter(Boolean);
      map.set(r.videoId, { genres, mode: r.mode === 'add' ? 'add' : 'replace' });
    }
    console.log(`手動ジャンル（${src}）: ${rows.length} 行`);
  };
  const local = path.join(ROOT, 'config/overrides.csv');
  if (existsSync(local)) add(parseCsv(await readFile(local, 'utf8')), 'overrides.csv');
  if (process.env.SHEET_CSV_URL) {
    const res = await fetch(process.env.SHEET_CSV_URL);
    if (!res.ok) throw new Error(`スプレッドシート取得失敗: ${res.status}`);
    add(parseCsv(await res.text()), 'スプレッドシート');
  }
  return map;
}

// config/genres.xlsx（ジャンル管理用Excel）を読み込む
// 返り値: { map: 動画ID → ジャンル配列, order: Excelの列順のジャンル名 }
const XLSX_FIXED = ['配信日時', 'メンバー', '種類', '長さ', 'タイトル', '確認済', 'メモ', '動画ID', 'URL'];
async function loadExcel() {
  const file = path.join(ROOT, 'config/genres.xlsx');
  const map = new Map();
  const listed = new Set();
  const reviewed = new Set();
  if (!existsSync(file)) return { map, listed, reviewed, cast: new Map(), types: new Map(), order: [] };
  const rows = await readXlsx(file, 'ジャンル');
  const head = (rows[0] || []).map((h) => String(h).trim());
  const idCol = head.indexOf('動画ID');
  if (idCol < 0) throw new Error('genres.xlsx の1行目に「動画ID」列がありません');
  const isCast = (h) => h.startsWith('出演:');
  const isUnit = (h) => h.startsWith('ユニット:');
  const genreCols = head.map((h, i) => [h, i]).filter(([h]) => h && !XLSX_FIXED.includes(h) && !isCast(h) && !isUnit(h));
  const castCols = head.map((h, i) => [h.slice(3).trim(), i]).filter((_, i) => isCast(head[i]));
  const unitCols = head.map((h, i) => [h.slice(5).trim(), i]).filter((_, i) => isUnit(head[i]));
  const cast = new Map();
  // 「種類」列（配信 / 動画 / ショート）。書かれていればサイトの種類はこの値になる
  const TYPE_OF = { '配信': 'live', '動画': 'video', 'ショート': 'short' };
  const typeCol = head.indexOf('種類');
  const reviewedCol = head.indexOf('確認済'); // 空欄でなければ確認済み
  const types = new Map();
  let blank = 0;
  for (const r of rows.slice(1)) {
    const id = String(r[idCol] ?? '').trim();
    if (!id) continue;
    listed.add(id);
    const ty = typeCol >= 0 ? TYPE_OF[String(r[typeCol] ?? '').trim()] : undefined;
    if (ty) types.set(id, ty);
    if (reviewedCol >= 0 && String(r[reviewedCol] ?? '').trim() !== '') reviewed.add(id);
    const on = ([, i]) => String(r[i] ?? '').trim() !== '';
    const gs = genreCols.filter(on).map(([h]) => h);
    if (gs.length) map.set(id, gs); else blank++; // ○が1つもない行は自動判定に任せる
    // 出演・ユニット列に○が1つでもあれば、その行の出演者・ユニットはExcelのとおりにする
    const ps = castCols.filter(on).map(([h]) => h);
    const us = unitCols.filter(on).map(([h]) => h);
    if (ps.length || us.length) cast.set(id, { names: ps, units: us });
  }
  console.log(`ジャンル管理Excel: ${map.size} 件（○なし ${blank} 件は自動判定） / ジャンル列 ${genreCols.length} 個 / 出演・ユニット指定 ${cast.size} 件 / 確認済 ${reviewed.size} 件`);
  return { map, listed, reviewed, cast, types, order: genreCols.map(([h]) => h) };
}

// 確認画面での修正（config/site-edits.json）
// { "newGenres": [{ "name": "料理", "keywords": ["料理", "クッキング"] }],
//   "videos": { "動画ID": { "reviewed": "2026-11-23", "type": "動画", "genres": [...], "cast": [...], "units": [...] } } }
// 書かれている項目だけを上書きする（書かれていない項目は Excel・自動判定のまま）
async function loadSiteEdits() {
  const file = path.join(ROOT, 'config/site-edits.json');
  const empty = { newGenres: [], videos: {} };
  if (!existsSync(file)) return empty;
  const txt = (await readFile(file, 'utf8')).trim();
  if (!txt) return empty;
  const d = JSON.parse(txt);
  const out = { newGenres: Array.isArray(d.newGenres) ? d.newGenres : [], videos: d.videos || {} };
  console.log(`確認画面の修正: ${Object.keys(out.videos).length} 件 / 追加ジャンル ${out.newGenres.length} 個`);
  return out;
}

// 出演者・ユニットの自動判定（config/cast.json）
// カタカナとひらがなは区別する（「ことはない」→コトハ のような誤判定を防ぐため）
const castNorm = (s = '') => s.normalize('NFKC').toLowerCase();
async function loadCastRules(channels) {
  const file = path.join(ROOT, 'config/cast.json');
  if (!existsSync(file)) return null;
  const c = JSON.parse(await readFile(file, 'utf8'));
  const shortName = (key) => (channels.find((ch) => ch.key === key)?.name || key).replace(/^(暁月|七海|常磐|藤宮|江波|鬼多見|香鳴|夏渚)/, '');
  const members = Object.entries(c.members).map(([key, m]) => ({
    key, debut: m.debut || '0000',
    names: (m.names || []).map(castNorm),
    aliases: (m.aliases || []).map(castNorm),
    excludes: (m.excludes || []).map(castNorm),
  }));
  const units = (c.units || []).map((u) => ({ ...u, kws: u.keywords.map(castNorm) }));
  const combos = (c.combos || []).map((u) => ({ ...u, kws: [castNorm(u.name), ...(u.keywords || []).map(castNorm)] }));
  const all = c.allMembers ? { kws: c.allMembers.keywords.map(castNorm), channels: c.allMembers.channels || null } : null;
  // Excelの「出演:クララ」の表記 ⇔ メンバーキー
  const nameOf = Object.fromEntries(members.map((m) => [m.key, shortName(m.key)]));
  const keyOf = Object.fromEntries(Object.entries(nameOf).map(([k, n]) => [n, k]));
  return { members, units, combos, all, nameOf, keyOf };
}
function detectCast(rules, v) {
  const t = castNorm(v.title);
  const p = new Set();
  const strong = new Set(); // 名前（フルネーム・名字・名前）で見つかったメンバー
  const u = [];
  let weak = false, all = false;
  if (v.channel !== 'official' && rules.nameOf[v.channel]) { p.add(v.channel); strong.add(v.channel); }
  for (const m of rules.members) {
    let s = t;
    for (const x of m.excludes) s = s.split(x).join('');
    if (m.names.some((k) => s.includes(k))) { p.add(m.key); strong.add(m.key); }
    else if (m.aliases.some((k) => s.includes(k))) { p.add(m.key); weak = true; } // 愛称だけで判定
  }
  for (const un of rules.units) if (un.kws.some((k) => t.includes(k))) { u.push(un.name); un.members.forEach((k) => p.add(k)); }
  for (const co of rules.combos) if (co.kws.some((k) => t.includes(k))) co.members.forEach((k) => { if (!strong.has(k)) weak = true; p.add(k); });
  if (rules.all && (!rules.all.channels || rules.all.channels.includes(v.channel)) && rules.all.kws.some((k) => t.includes(k))) {
    const day = new Date(Date.parse(v.startAt) + 9 * 3600e3).toISOString().slice(0, 10);
    for (const m of rules.members) if (m.debut <= day) p.add(m.key);
    all = true;
  }
  const order = rules.members.map((m) => m.key);
  return { p: order.filter((k) => p.has(k)), u, weak, all };
}

// シリーズ名: タイトル先頭付近の【】の中身から日付・回数・数字を除いたもの（チャンネルごとに分ける）
// メンバー名やグループ名だけの【】（例:【藤宮コトハ / パレプロ】）は内容が分からないのでシリーズにしない
const NAME_ONLY = /(暁月|クララ|七海|ロナ|常磐|カナメ|藤宮|コトハ|江波|キョウカ|鬼多見|アユム|香鳴|ハノン|夏渚|まはろ|パレプロ|palette ?project|vtuber|新人vtuber|#|\/|\||¦|｜|・|×|x|\s|【|】|\(|\)|（|）)/gi;
function seriesKey(title) {
  let t = title.normalize('NFKC').toLowerCase();
  t = t.replace(/\d+[/月]\d+日?/g, '').replace(/#\d+|第\d+[回話弾]|vol\.?\d+|part\.?\d+|\d+/g, '');
  const m = [...t.matchAll(/[【\[]([^】\]]{1,25})[】\]]/g)].map((x) => x[1].replace(/^[\s!！?？]+|[\s!！?？]+$/g, '').trim())
    .filter((x) => x && x !== 'live');
  const k = m.find((x) => x.replace(NAME_ONLY, '').length >= 2);
  return k || null;
}
// 概要欄の分割ファイル番号（動画IDから0〜15）
const descChunk = (id) => { let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 16; };

async function main() {
  const { channels } = await readJson('config/channels.json');
  const { rules, fallback } = await readJson('config/genre-rules.json');
  const db = await readJson('data/videos.json');
  const overrides = await loadOverrides();
  const excel = await loadExcel();
  const edits = await loadSiteEdits();
  const castRules = await loadCastRules(channels);
  // 確認画面で追加したジャンルも自動判定に使う（キーワードがあれば）
  const allRules = [...rules, ...edits.newGenres.filter((g) => g.name && (g.keywords || []).length).map((g) => ({ genre: g.name, keywords: g.keywords }))];
  const normRules = allRules.map((r) => ({
    genre: r.genre,
    kws: r.keywords.map(normalize),
    excludes: (r.excludes || []).map(normalize),
    types: r.types || null,
  }));
  // 種類: live=配信アーカイブ / short=ショート（3分以内の動画 or #shorts）/ video=動画
  const typeOf = (v) => (v.type === 'video' && (v.durationSec <= 180 || /#shorts/i.test(v.title)) ? 'short' : v.type);

  let typeChanged = 0;
  const TYPE_CODE = { '配信': 'live', '動画': 'video', 'ショート': 'short' };
  const review = { base: {}, info: {}, series: [], reviewed: [] };
  const seriesIndex = new Map();
  const seriesCount = new Map();
  for (const v of Object.values(db.videos)) {
    const k = seriesKey(v.title);
    if (k) seriesCount.set(`${v.channel}|${k}`, (seriesCount.get(`${v.channel}|${k}`) || 0) + 1);
  }
  const descs = Array.from({ length: 16 }, () => ({}));
  const videos = Object.values(db.videos)
    .sort((a, b) => b.startAt.localeCompare(a.startAt))
    .map((v) => {
      const t = normalize(v.title);
      // 種類: Excelの「種類」列に値があればそれを優先（例：ショート機能がなかった頃の短い動画を「動画」に）
      const autoTy = typeOf(v);
      const ty = excel.types.get(v.id) || autoTy;
      if (ty !== autoTy) typeChanged++;
      let auto = [...new Set(normRules
        .filter((r) => (!r.types || r.types.includes(ty)) && !r.excludes.some((x) => t.includes(x)) && r.kws.some((k) => t.includes(k)))
        .map((r) => r.genre))];
      if (!auto.length) auto = [fallback];
      // Excelに載っている動画は、Excelの○をそのままジャンルにする（自動判定より優先）
      const fromExcel = excel.map.get(v.id);
      if (fromExcel) auto = fromExcel;
      const ov = overrides.get(v.id);
      const manual = ov ? ov.genres : [];
      const finalAuto = ov?.mode === 'replace' ? [] : auto.filter((g) => !manual.includes(g));
      // 出演者(p)・ユニット(u): Excelに指定があればそれを、なければ自動判定
      let p = [], u = [], det = { weak: false, all: false, u: [] };
      if (castRules) {
        det = detectCast(castRules, v);
        const ex = excel.cast.get(v.id);
        if (ex) {
          p = ex.names.map((n) => castRules.keyOf[n]).filter(Boolean);
          u = ex.units;
        } else ({ p, u } = det);
      }
      // 確認画面での修正（書かれている項目だけ上書き）
      const e = edits.videos[v.id];
      let rec = { id: v.id, c: v.channel, t: v.title, s: v.startAt, d: v.durationSec, ty, th: v.thumbnail, g: finalAuto, m: manual, p, u };
      if (e) {
        review.base[v.id] = { ty: rec.ty, g: [...rec.m, ...rec.g].filter((x) => x !== fallback), p: rec.p, u: rec.u };
        if (e.type && TYPE_CODE[e.type]) rec.ty = TYPE_CODE[e.type];
        if (Array.isArray(e.genres)) { rec.g = e.genres.length ? e.genres : [fallback]; rec.m = []; }
        if (Array.isArray(e.cast) && castRules) rec.p = castRules.members.map((m) => m.key).filter((k) => e.cast.includes(castRules.nameOf[k]));
        if (Array.isArray(e.units)) rec.u = e.units;
      }
      // 確認画面用の情報: 要確認の理由・シリーズ・概要欄
      const gs = [...rec.m, ...rec.g].filter((x) => x !== fallback);
      const reasons = [];
      if (!gs.length) reasons.push('noGenre');
      if (rec.c === 'official' && !rec.p.length) reasons.push('officialNoCast');
      if (rec.c !== 'official' && det.u.length && !excel.cast.has(v.id)) reasons.push('unitSolo');
      if (det.weak && !excel.cast.has(v.id)) reasons.push('weakCast');
      if (det.all && !excel.cast.has(v.id)) reasons.push('allMembers');
      if (v.type === 'video' && v.durationSec <= 180 && !/#shorts/i.test(v.title)) reasons.push('typeCheck');
      const sk = seriesKey(v.title);
      let si = -1;
      if (sk && seriesCount.get(`${v.channel}|${sk}`) >= 3) {
        const key = `${v.channel}|${sk}`;
        if (!seriesIndex.has(key)) { seriesIndex.set(key, review.series.length); review.series.push([v.channel, sk]); }
        si = seriesIndex.get(key);
      }
      if (reasons.length || si >= 0) review.info[v.id] = [reasons, si];
      if (excel.reviewed.has(v.id) || e?.reviewed) review.reviewed.push(v.id);
      if (v.desc) descs[descChunk(v.id)][v.id] = v.desc;
      // 出力はファイルサイズを抑えるため短いキー名
      return rec;
    });

  // ジャンルの並び順: Excelの列順 → 自動判定ルールにしかないジャンル → その他
  const genreOrder = [...new Set([...excel.order, ...edits.newGenres.map((g) => g.name).filter(Boolean), ...rules.map((r) => r.genre), fallback])];
  for (const v of videos) for (const g of v.m) if (!genreOrder.includes(g)) genreOrder.push(g);

  const out = {
    updatedAt: db.updatedAt,
    channels: channels.map(({ key, name, color, gradient, ring }) => ({ key, name, color, ...(gradient ? { gradient } : {}), ...(ring ? { ring } : {}) })),
    genres: genreOrder,
    units: castRules ? castRules.units.map((x) => x.name) : [],
    videos,
  };
  await mkdir(path.join(ROOT, 'public/data'), { recursive: true });
  // file:// で直接開いても動くよう、JSONではなく JS として書き出す
  await writeFile(path.join(ROOT, 'public/data/archives.js'), `window.PALEPRO_DATA = ${JSON.stringify(out)};\n`);
  // 確認画面用データ（公開サイトでは読み込まない）
  const reviewOut = {
    builtAt: new Date().toISOString(),
    excelGenres: excel.order,                 // Excelのジャンル列（確認画面のボタンの並び順）
    newGenres: edits.newGenres,
    reviewed: review.reviewed,                // ビルド時点で確認済みの動画（Excel「確認済」＋確認画面）
    base: review.base,                        // 確認画面で修正した動画の、修正前の状態（「元に戻す」用）
    series: review.series,                    // [チャンネル, シリーズ名]
    info: review.info,                        // 動画ID → [要確認の理由, シリーズ番号]
  };
  await writeFile(path.join(ROOT, 'public/data/review-data.js'), `window.PALEPRO_REVIEW = ${JSON.stringify(reviewOut)};\n`);
  await rm(path.join(ROOT, 'public/data/desc'), { recursive: true, force: true });
  await mkdir(path.join(ROOT, 'public/data/desc'), { recursive: true });
  for (let i = 0; i < 16; i++) {
    await writeFile(path.join(ROOT, `public/data/desc/d${i}.js`),
      `window.PALEPRO_DESC = window.PALEPRO_DESC || {}; Object.assign(window.PALEPRO_DESC, ${JSON.stringify(descs[i])});\n`);
  }
  const descCount = descs.reduce((n, d) => n + Object.keys(d).length, 0);
  console.log(`確認画面用データ: 確認済 ${review.reviewed.length} 件 / 要確認・シリーズ情報 ${Object.keys(review.info).length} 件 / シリーズ ${review.series.length} 個 / 概要欄 ${descCount} 件`);
  if (typeChanged) console.log(`種類をExcelの指定で変更: ${typeChanged} 件`);
  const notInExcel = excel.listed.size ? Object.keys(db.videos).filter((id) => !excel.listed.has(id)).length : 0;
  console.log(`public/data/archives.js を生成（${videos.length} 件${excel.listed.size ? `、うちExcel未登録の新着 ${notInExcel} 件` : ''}）`);
}

main().catch((e) => { console.error(e); process.exit(1); });
