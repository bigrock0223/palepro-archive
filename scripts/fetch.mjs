// YouTube Data API v3 から各チャンネルの動画・配信アーカイブを取得して data/videos.json に保存します。
// 使い方:  YT_API_KEY=xxxx node scripts/fetch.mjs          （差分取得）
//          YT_API_KEY=xxxx node scripts/fetch.mjs --full   （全件取り直し）
// 必要: Node.js 18 以上（fetch が標準で使えるため追加パッケージ不要）
//
// API使用量の目安（1日 10,000 ユニットまで無料）
//   channels.list (handle→ID) 1ユニット / playlistItems.list 1ユニット(50件) / videos.list 1ユニット(50件)
//   search.list（100ユニット）は使いません。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'config/channels.json');
const OUT = path.join(ROOT, 'data/videos.json');
const API = 'https://www.googleapis.com/youtube/v3';
const KEY = process.env.YT_API_KEY;
const FULL = process.argv.includes('--full');
const REFRESH_DAYS = 25; // YouTube API規約: 保存データは30日以内に取り直す
let units = 0;

if (!KEY) {
  console.error('環境変数 YT_API_KEY が設定されていません。');
  process.exit(1);
}

async function api(endpoint, params) {
  const url = new URL(`${API}/${endpoint}`);
  for (const [k, v] of Object.entries({ ...params, key: KEY })) url.searchParams.set(k, v);
  const res = await fetch(url);
  units += 1;
  if (!res.ok) throw new Error(`${endpoint} ${res.status}: ${await res.text()}`);
  return res.json();
}

// ISO8601 期間 (PT1H2M3S) → 秒
function parseDuration(iso = '') {
  const m = iso.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const [, d = 0, h = 0, mi = 0, s = 0] = m.map((x) => Number(x || 0));
  return d * 86400 + h * 3600 + mi * 60 + s;
}

async function resolveChannelId(ch) {
  if (ch.channelId) return ch.channelId;
  if (!ch.handle) return null;
  const json = await api('channels', { part: 'id', forHandle: ch.handle });
  return json.items?.[0]?.id ?? null;
}

async function listPlaylistIds(channelId, known) {
  const playlistId = 'UU' + channelId.slice(2); // アップロード再生リスト
  const ids = [];
  let pageToken;
  do {
    const json = await api('playlistItems', {
      part: 'contentDetails', playlistId, maxResults: 50, ...(pageToken ? { pageToken } : {}),
    });
    const pageIds = json.items.map((i) => i.contentDetails.videoId);
    ids.push(...pageIds);
    // 差分モード: このページが全部既知なら、それ以前は取得済みとみなして終了
    if (!FULL && pageIds.length && pageIds.every((id) => known.has(id))) break;
    pageToken = json.nextPageToken;
  } while (pageToken);
  return ids;
}

async function fetchDetails(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const json = await api('videos', {
      part: 'snippet,contentDetails,liveStreamingDetails',
      id: ids.slice(i, i + 50).join(','),
    });
    out.push(...json.items);
  }
  return out;
}

function toRecord(item, channelKey) {
  const live = item.liveStreamingDetails;
  const sn = item.snippet;
  const th = sn.thumbnails || {};
  return {
    id: item.id,
    channel: channelKey,
    title: sn.title,
    publishedAt: sn.publishedAt,
    startAt: live?.actualStartTime || live?.scheduledStartTime || sn.publishedAt,
    durationSec: parseDuration(item.contentDetails?.duration),
    type: live ? 'live' : 'video',
    thumbnail: (th.medium || th.high || th.default || {}).url || '',
    desc: (sn.description || '').slice(0, 300), // 概要欄の冒頭（確認画面で表示）
    fetchedAt: new Date().toISOString(),
  };
}

async function main() {
  const config = JSON.parse(await readFile(CONFIG, 'utf8'));
  const db = existsSync(OUT)
    ? JSON.parse(await readFile(OUT, 'utf8'))
    : { updatedAt: null, channelIds: {}, videos: {} };
  if (FULL) db.videos = {};

  for (const ch of config.channels) {
    const channelId = db.channelIds[ch.key] || (await resolveChannelId(ch));
    if (!channelId) {
      console.warn(`⚠ ${ch.name}: handle / channelId が未設定のためスキップ`);
      continue;
    }
    db.channelIds[ch.key] = channelId;

    const known = new Set(Object.values(db.videos).filter((v) => v.channel === ch.key).map((v) => v.id));
    const ids = (await listPlaylistIds(channelId, known)).filter((id) => !known.has(id));
    const items = await fetchDetails(ids);
    let added = 0;
    for (const item of items) {
      if (item.snippet.liveBroadcastContent !== 'none') continue; // 配信予定・配信中は除外
      db.videos[item.id] = toRecord(item, ch.key);
      added++;
    }
    console.log(`✔ ${ch.name}: 新規 ${added} 件`);
  }

  // 概要欄をまだ持っていない動画（この機能を入れる前に取得した分）を取り直す
  const noDesc = Object.values(db.videos).filter((v) => v.desc === undefined);
  if (noDesc.length) {
    const items = await fetchDetails(noDesc.map((v) => v.id));
    const alive = new Set(items.map((i) => i.id));
    for (const item of items) db.videos[item.id] = toRecord(item, db.videos[item.id].channel);
    for (const v of noDesc) if (!alive.has(v.id)) delete db.videos[v.id];
    console.log(`＋ 概要欄を補完 ${items.length} 件`);
  }

  // 古くなったデータを取り直す（削除・非公開になった動画は消す）
  const limit = Date.now() - REFRESH_DAYS * 86400e3;
  const stale = Object.values(db.videos).filter((v) => new Date(v.fetchedAt).getTime() < limit);
  if (stale.length) {
    const items = await fetchDetails(stale.map((v) => v.id));
    const alive = new Set(items.map((i) => i.id));
    for (const item of items) db.videos[item.id] = toRecord(item, db.videos[item.id].channel);
    for (const v of stale) if (!alive.has(v.id)) delete db.videos[v.id];
    console.log(`↻ 再取得 ${items.length} 件 / 削除 ${stale.length - items.length} 件`);
  }

  db.updatedAt = new Date().toISOString();
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(db, null, 1));
  console.log(`合計 ${Object.keys(db.videos).length} 件を保存（API使用量 約 ${units} ユニット）`);
}

main().catch((e) => { console.error(e); process.exit(1); });
