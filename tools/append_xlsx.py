# 既存の genres.xlsx に、まだ載っていない新着動画の行を差し込む（書式はそのまま残す）
# 使い方: append_xlsx.py archives.js 既存のgenres.xlsx 出力.xlsx
#   - 新着は見出しのすぐ下（2行目〜）に新しい順で差し込む
#   - 新着行の書式は、差し込み前の2行目（既存の先頭データ行）の書式を列ごとに写す
#   - 入力規則・条件付き書式・フィルターの範囲は、差し込んだ行数ぶん広げる
#   - 自動判定のジャンルのうち、Excelに列がないものはメモ欄に書く（列は増やさない）
import json, sys, copy, datetime, re
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter, range_boundaries
from openpyxl.worksheet.cell_range import MultiCellRange

arch, src, out = sys.argv[1:4]
txt = open(arch, encoding='utf8').read()
d = json.loads(txt[txt.index('{'):txt.rstrip().rstrip(';').rindex('}') + 1])
ch = {c['key']: c['name'] for c in d['channels']}
TYPE = {'live': '配信', 'video': '動画', 'short': 'ショート'}
FIXED = ['配信日時', 'メンバー', '種類', '長さ', 'タイトル', '確認済', 'メモ', '動画ID', 'URL']
JST = datetime.timezone(datetime.timedelta(hours=9))

wb = load_workbook(src)
ws = wb['ジャンル']
head = [str(c.value).strip() if c.value is not None else '' for c in ws[1]]
col = {h: i + 1 for i, h in enumerate(head) if h}
if '動画ID' not in col:
    sys.exit('1行目に「動画ID」列がありません')
genre_cols = [(h, i + 1) for i, h in enumerate(head) if h and h not in FIXED and not h.startswith(('出演:', 'ユニット:'))]
cast_cols = [(h[3:].strip(), i + 1) for i, h in enumerate(head) if h.startswith('出演:')]
unit_cols = [(h[5:].strip(), i + 1) for i, h in enumerate(head) if h.startswith('ユニット:')]
PREFIX = ('暁月', '七海', '常磐', '藤宮', '江波', '鬼多見', '香鳴', '夏渚')
def short(name):
    for p in PREFIX:
        if name.startswith(p): return name[len(p):]
    return name
listed = set()
for r in range(2, ws.max_row + 1):
    v = ws.cell(r, col['動画ID']).value
    if v is not None and str(v).strip():
        listed.add(str(v).strip())

new = [v for v in d['videos'] if v['id'] not in listed]  # archives.js は新しい順
n = len(new)
if n == 0:
    wb.save(out)
    print('追加 0 件（新着なし）')
    sys.exit(0)

old_max = ws.max_row
ncols = ws.max_column
# 差し込み前の先頭データ行の書式を控えておく
template = {c: ws.cell(2, c) for c in range(1, ncols + 1)} if old_max >= 2 else {}
tstyle = {c: (copy.copy(t.font), copy.copy(t.fill), copy.copy(t.border), copy.copy(t.alignment), t.number_format, copy.copy(t.protection)) for c, t in template.items()}
theight = ws.row_dimensions[2].height if old_max >= 2 else None

# 行の高さ・グループ化（アウトライン）・非表示は insert_rows で動かないので、自前でずらす
ROW_ATTRS = ('height', 'hidden', 'outlineLevel', 'outline_level', 'collapsed')
saved = {}
for r in range(2, old_max + 1):
    dim = ws.row_dimensions.get(r) if hasattr(ws.row_dimensions, 'get') else ws.row_dimensions[r]
    if dim is None: continue
    attrs = {a: getattr(dim, a) for a in ('height', 'hidden', 'outlineLevel', 'collapsed') if getattr(dim, a, None)}
    if attrs: saved[r] = attrs
ws.insert_rows(2, n)
for r in saved:
    dim = ws.row_dimensions[r]
    dim.height = None; dim.hidden = False; dim.outlineLevel = 0; dim.collapsed = False
for r, attrs in saved.items():
    dim = ws.row_dimensions[r + n]
    for a, v in attrs.items(): setattr(dim, a, v)

def shift_range(ref):
    """2行目以降にかかる範囲を n 行ぶん下へ広げる（開始が2行目以下なら開始はそのまま）"""
    out_parts = []
    for part in str(ref).split():
        min_col, min_row, max_col, max_row = range_boundaries(part)
        if max_row is None or max_row < 2:
            out_parts.append(part); continue
        new_min = min_row if min_row <= 2 else min_row + n
        out_parts.append(f'{get_column_letter(min_col)}{new_min}:{get_column_letter(max_col)}{max_row + n}')
    return ' '.join(out_parts)

for dv in ws.data_validations.dataValidation:
    dv.sqref = MultiCellRange(shift_range(dv.sqref))
cf_old = ws.conditional_formatting
from openpyxl.formatting.formatting import ConditionalFormattingList
cf_new = ConditionalFormattingList()
for rng in cf_old:
    for rule in rng.rules:
        cf_new.add(shift_range(rng.sqref), rule)
ws.conditional_formatting = cf_new
if ws.auto_filter.ref:
    ws.auto_filter.ref = shift_range(ws.auto_filter.ref)

for k, v in enumerate(new):
    r = 2 + k
    t = datetime.datetime.fromisoformat(v['s'].replace('Z', '+00:00')).astimezone(JST).replace(tzinfo=None)
    h, m = divmod(v['d'] // 60, 60)
    gs = [g for g in v['g'] + v['m'] if g != 'その他']
    missing = [g for g in gs if g not in dict(genre_cols)]
    memo = '新着（自動判定）' + (f'／列なし: {"・".join(missing)}' if missing else '')
    values = {'配信日時': t, 'メンバー': ch.get(v['c'], v['c']), '種類': TYPE.get(v['ty'], v['ty']), '長さ': f'{h}:{m:02d}',
              'タイトル': v['t'], 'メモ': memo, '動画ID': v['id'], 'URL': 'https://www.youtube.com/watch?v=' + v['id']}
    for name, c in col.items():
        if name in values:
            ws.cell(r, c).value = values[name]
    for g, c in genre_cols:
        ws.cell(r, c).value = '○' if g in gs else None
    cast_names = {short(ch.get(k, k)) for k in v.get('p', [])}
    for name, c in cast_cols:
        ws.cell(r, c).value = '○' if name in cast_names else None
    for name, c in unit_cols:
        ws.cell(r, c).value = '○' if name in v.get('u', []) else None
    for c, (font, fill, border, align, fmt, prot) in tstyle.items():
        cell = ws.cell(r, c)
        cell.font, cell.fill, cell.border, cell.alignment, cell.number_format, cell.protection = font, fill, border, align, fmt, prot
    if theight is not None:
        ws.row_dimensions[r].height = theight

wb.save(out)
print(f'追加 {n} 件（{new[-1]["s"][:10]} 〜 {new[0]["s"][:10]}）')
