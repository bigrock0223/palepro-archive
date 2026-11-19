// data/videos.json にジャンルを付けて、サイト用の public/data/archives.js を生成します。
// 使い方:  node scripts/build.mjs
// 手動ジャンル:
//   - config/overrides.csv（ローカル）
//   - 環境変数 SHEET_CSV_URL があれば、Googleスプレッドシートの「ウェブに公開」CSVも読み込み（こちらが優先）
// CSVの列: videoId,genres,mode,memo
//   genres … 「|」か「、」区切りで複数可
//   mode   … replace（自動判定を置き換え）/ add（自動判定に追加）。空なら replace

import { readFile, writeFile, mkdir } from 'node:fs/promises';
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
const XLSX_FIXED = ['配信日時', 'メンバー', '種類', '長さ', 'タイトル', 'メモ', '動画ID', 'URL'];
async function loadExcel() {
  const file = path.join(ROOT, 'config/genres.xlsx');
  const map = new Map();
  const listed = new Set();
  if (!existsSync(file)) return { map, listed, cast: new Map(), order: [] };
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
  let blank = 0;
  for (const r of rows.slice(1)) {
    const id = String(r[idCol] ?? '').trim();
    if (!id) continue;
    listed.add(id);
    const on = ([, i]) => String(r[i] ?? '').trim() !== '';
    const gs = genreCols.filter(on).map(([h]) => h);
    if (gs.length) map.set(id, gs); else blank++; // ○が1つもない行は自動判定に任せる
    // 出演・ユニット列に○が1つでもあれば、その行の出演者・ユニットはExcelのとおりにする
    const ps = castCols.filter(on).map(([h]) => h);
    const us = unitCols.filter(on).map(([h]) => h);
    if (ps.length || us.length) cast.set(id, { names: ps, units: us });
  }
  console.log(`ジャンル管理Excel: ${map.size} 件（○なし ${blank} 件は自動判定） / ジャンル列 ${genreCols.length} 個 / 出演・ユニット指定 ${cast.size} 件`);
  return { map, listed, cast, order: genreCols.map(([h]) => h) };
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
    terms: [...(m.names || []), ...(m.aliases || [])].map(castNorm),
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
  const u = [];
  if (v.channel !== 'official' && rules.nameOf[v.channel]) p.add(v.channel);
  for (const m of rules.members) {
    let s = t;
    for (const x of m.excludes) s = s.split(x).join('');
    if (m.terms.some((k) => s.includes(k))) p.add(m.key);
  }
  for (const un of rules.units) if (un.kws.some((k) => t.includes(k))) { u.push(un.name); un.members.forEach((k) => p.add(k)); }
  for (const co of rules.combos) if (co.kws.some((k) => t.includes(k))) co.members.forEach((k) => p.add(k));
  if (rules.all && (!rules.all.channels || rules.all.channels.includes(v.channel)) && rules.all.kws.some((k) => t.includes(k))) {
    const day = new Date(Date.parse(v.startAt) + 9 * 3600e3).toISOString().slice(0, 10);
    for (const m of rules.members) if (m.debut <= day) p.add(m.key);
  }
  const order = rules.members.map((m) => m.key);
  return { p: order.filter((k) => p.has(k)), u };
}

async function main() {
  const { channels } = await readJson('config/channels.json');
  const { rules, fallback } = await readJson('config/genre-rules.json');
  const db = await readJson('data/videos.json');
  const overrides = await loadOverrides();
  const excel = await loadExcel();
  const castRules = await loadCastRules(channels);
  const normRules = rules.map((r) => ({
    genre: r.genre,
    kws: r.keywords.map(normalize),
    excludes: (r.excludes || []).map(normalize),
    types: r.types || null,
  }));
  // 種類: live=配信アーカイブ / short=ショート（3分以内の動画 or #shorts）/ video=動画
  const typeOf = (v) => (v.type === 'video' && (v.durationSec <= 180 || /#shorts/i.test(v.title)) ? 'short' : v.type);

  const videos = Object.values(db.videos)
    .sort((a, b) => b.startAt.localeCompare(a.startAt))
    .map((v) => {
      const t = normalize(v.title);
      const ty = typeOf(v);
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
      let p = [], u = [];
      if (castRules) {
        const ex = excel.cast.get(v.id);
        if (ex) {
          p = ex.names.map((n) => castRules.keyOf[n]).filter(Boolean);
          u = ex.units;
        } else ({ p, u } = detectCast(castRules, v));
      }
      // 出力はファイルサイズを抑えるため短いキー名
      return { id: v.id, c: v.channel, t: v.title, s: v.startAt, d: v.durationSec, ty, th: v.thumbnail, g: finalAuto, m: manual, p, u };
    });

  // ジャンルの並び順: Excelの列順 → 自動判定ルールにしかないジャンル → その他
  const genreOrder = [...new Set([...excel.order, ...rules.map((r) => r.genre), fallback])];
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
  const notInExcel = excel.listed.size ? Object.keys(db.videos).filter((id) => !excel.listed.has(id)).length : 0;
  console.log(`public/data/archives.js を生成（${videos.length} 件${excel.listed.size ? `、うちExcel未登録の新着 ${notInExcel} 件` : ''}）`);
}

main().catch((e) => { console.error(e); process.exit(1); });
