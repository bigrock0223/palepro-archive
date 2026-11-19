// 追加パッケージなしで .xlsx（Excelファイル）の1シートを読み込む小さなリーダー。
// 返り値: 行の配列（各行はセル文字列の配列。1行目が見出し）
// 対応: 共有文字列 / インライン文字列 / 数値・真偽値（文字列として返す）
import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

function unzip(buf) {
  // End of Central Directory を末尾から探す
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('xlsx（zip）として読み込めません');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zipの目次が壊れています');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    files.set(name, { method, compSize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return (name) => {
    const f = files.get(name);
    if (!f) return null;
    const start = f.local + 30 + buf.readUInt16LE(f.local + 26) + buf.readUInt16LE(f.local + 28);
    const data = buf.subarray(start, start + f.compSize);
    if (f.method === 0) return data.toString('utf8');
    if (f.method === 8) return inflateRawSync(data).toString('utf8');
    throw new Error(`未対応の圧縮形式です: ${f.method}`);
  };
}

const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');
// 日本語版Excelはふりがな（<rPh>）を一緒に保存するので取り除いてから文字を集める
const texts = (xml) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
  .map((m) => decode(m[1])).join('');
const colIndex = (ref) => {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

export async function readXlsx(path, sheetName) {
  const get = unzip(await readFile(path));
  const wb = get('xl/workbook.xml');
  const rels = get('xl/_rels/workbook.xml.rels') || '';
  const sheets = [...wb.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => ({
    name: decode((m[1].match(/\bname="([^"]*)"/) || [])[1] || ''),
    rid: (m[1].match(/\br:id="([^"]*)"/) || m[1].match(/\bid="([^"]*)"/) || [])[1],
  }));
  const sheet = sheets.find((s) => s.name === sheetName) || sheets[0];
  const rel = [...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => m[1])
    .find((a) => a.includes(`Id="${sheet.rid}"`));
  let target = (rel?.match(/Target="([^"]*)"/) || [])[1] || 'worksheets/sheet1.xml';
  target = target.startsWith('/') ? target.slice(1) : `xl/${target}`;

  const ssXml = get('xl/sharedStrings.xml') || '';
  const shared = [...ssXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));

  const xml = get(target);
  if (!xml) throw new Error(`シートが見つかりません: ${sheetName}`);
  const rows = [];
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNo = Number((rm[1].match(/\br="(\d+)"/) || [])[1]) || rows.length + 1;
    const row = [];
    for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
      const idx = ref ? colIndex(ref) : row.length;
      const type = (attrs.match(/\bt="([^"]*)"/) || [])[1];
      const body = cm[2] || '';
      const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let val = '';
      if (type === 's') val = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') val = texts(body);
      else if (v !== undefined) val = decode(v);
      row[idx] = val;
    }
    rows[rowNo - 1] = Array.from(row, (x) => x ?? '');
  }
  return Array.from(rows, (r) => r ?? []);
}
