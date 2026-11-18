// 画面確認用のダミーデータ data/videos.json を作ります（タイトルはすべて架空）。
// 使い方:  node scripts/make-dummy.mjs  →  node scripts/build.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { channels } = JSON.parse(await readFile(path.join(ROOT, 'config/channels.json'), 'utf8'));

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (a) => a[Math.floor(rand() * a.length)];

const templates = [
  ['【歌枠】まったり歌うよ〜🎤 #{n}', 7200], ['【KARAOKE】リクエスト多めの歌枠！', 6000],
  ['【雑談】今週あったことを話す', 3600], ['【朝活】おはよう雑談☀', 1800],
  ['【マイクラ】拠点づくりの続き！', 9000], ['【初見プレイ】話題のホラーゲームに挑戦', 10800],
  ['【リズム天国】パーフェクト目指して', 5400], ['【APEX】ランクいくぞ！', 12000],
  ['【ASMR】ささやき雑談でおやすみ', 3600], ['【コラボ】メンバーとわちゃわちゃゲーム', 7200],
  ['【耐久企画】クリアするまで終われません', 18000], ['【重大発表】大事なお知らせがあります', 1800],
  ['【3D LIVE】記念ライブ配信', 5400], ['【歌ってみた】カバー曲を歌いました', 240],
  ['【雑談】マシュマロ読み', 4500], ['お絵描きしながらおしゃべり', 5000],
];

const videos = {};
const now = Date.parse('2026-11-14T12:00:00Z');
let n = 1;
for (let i = 0; i < 480; i++) {
  const ch = pick(channels);
  const [title, base] = pick(templates);
  // 過去2年のどこか。開始は日本時間 12〜24時あたりに寄せる
  const day = Math.floor(rand() * 730);
  const hourJst = pick([12, 18, 19, 20, 20, 21, 21, 22, 23, 7]);
  const start = new Date(now - day * 86400e3);
  start.setUTCHours((hourJst - 9 + 24) % 24, pick([0, 0, 0, 30]), 0, 0);
  const id = `dummy${String(n).padStart(4, '0')}`;
  const isVideo = title.includes('歌ってみた');
  videos[id] = {
    id, channel: ch.key,
    title: title.replace('{n}', n++),
    publishedAt: start.toISOString(), startAt: start.toISOString(),
    durationSec: Math.round(base * (0.6 + rand() * 0.8)),
    type: isVideo ? 'video' : 'live',
    thumbnail: '', fetchedAt: new Date().toISOString(),
  };
}

await mkdir(path.join(ROOT, 'data'), { recursive: true });
await writeFile(path.join(ROOT, 'data/videos.json'),
  JSON.stringify({ updatedAt: new Date().toISOString(), channelIds: {}, videos }, null, 1));
console.log(`ダミー ${Object.keys(videos).length} 件を data/videos.json に作成`);
