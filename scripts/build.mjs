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

async function main() {
  const { channels } = await readJson('config/channels.json');
  const { rules, fallback } = await readJson('config/genre-rules.json');
  const db = await readJson('data/videos.json');
  const overrides = await loadOverrides();
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
      const ov = overrides.get(v.id);
      const manual = ov ? ov.genres : [];
      const finalAuto = ov?.mode === 'replace' ? [] : auto.filter((g) => !manual.includes(g));
      // 出力はファイルサイズを抑えるため短いキー名
      return { id: v.id, c: v.channel, t: v.title, s: v.startAt, d: v.durationSec, ty, th: v.thumbnail, g: finalAuto, m: manual };
    });

  const genreOrder = [...new Set([...rules.map((r) => r.genre), fallback])];
  for (const v of videos) for (const g of v.m) if (!genreOrder.includes(g)) genreOrder.push(g);

  const out = {
    updatedAt: db.updatedAt,
    channels: channels.map(({ key, name, color, gradient }) => ({ key, name, color, ...(gradient ? { gradient } : {}) })),
    genres: genreOrder,
    videos,
  };
  await mkdir(path.join(ROOT, 'public/data'), { recursive: true });
  // file:// で直接開いても動くよう、JSONではなく JS として書き出す
  await writeFile(path.join(ROOT, 'public/data/archives.js'), `window.PALEPRO_DATA = ${JSON.stringify(out)};\n`);
  console.log(`public/data/archives.js を生成（${videos.length} 件）`);
}

main().catch((e) => { console.error(e); process.exit(1); });
