# genres.xlsx に「出演:〇〇」「ユニット:〇〇」の列を差し込み、自動判定の結果で○を入れる（書式はそのまま残す）
# 使い方: add_cast_columns.py archives.js 既存のgenres.xlsx 出力.xlsx
#   - すでに同じ名前の列がある場合は何もしない（2回実行しても大丈夫）
#   - 列は「メモ」列の左に差し込む
import json, sys, copy
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.formatting.rule import CellIsRule
from openpyxl.styles import PatternFill

arch, src, out = sys.argv[1:4]
txt = open(arch, encoding='utf8').read()
d = json.loads(txt[txt.index('{'):txt.rstrip().rstrip(';').rindex('}') + 1])
PREFIX = ('暁月', '七海', '常磐', '藤宮', '江波', '鬼多見', '香鳴', '夏渚')
def short(name):
    for p in PREFIX:
        if name.startswith(p): return name[len(p):]
    return name
member_keys = []
for v in d['videos']:
    for k in v.get('p', []):
        if k not in member_keys: member_keys.append(k)
ch = {c['key']: c['name'] for c in d['channels']}
order = [c['key'] for c in d['channels'] if c['key'] in member_keys]  # channels.json の並び順
cast_heads = [f'出演:{short(ch[k])}' for k in order]
unit_heads = [f'ユニット:{u}' for u in d.get('units', [])]
by_id = {v['id']: v for v in d['videos']}

wb = load_workbook(src)
ws = wb['ジャンル']
head = [str(c.value).strip() if c.value is not None else '' for c in ws[1]]
new_heads = [h for h in cast_heads + unit_heads if h not in head]
if not new_heads:
    wb.save(out); print('追加する列はありません'); sys.exit(0)
memo = head.index('メモ') + 1
n = len(new_heads)
max_row = ws.max_row
old_ncols = ws.max_column

# 列幅は insert_cols で動かず、まとめて設定された列（F:Z など）もあるので、1列ずつに展開してから付け直す
def col_widths(ws):
    out = {}
    for key, dim in list(ws.column_dimensions.items()):
        if not dim.width: continue
        lo = dim.min or column_index_from_string(key)
        hi = dim.max or lo
        for c in range(lo, hi + 1): out[c] = dim.width
    return out
from openpyxl.utils import column_index_from_string
from openpyxl.worksheet.dimensions import ColumnDimension
widths = col_widths(ws)
tpl_width = widths.get(memo - 1, 4.2)
ws.insert_cols(memo, n)
ws.column_dimensions.clear()
for c, w in widths.items():
    nc = c if c < memo else c + n
    ws.column_dimensions[get_column_letter(nc)] = ColumnDimension(ws, index=get_column_letter(nc), width=w)
for i in range(n):
    L = get_column_letter(memo + i)
    ws.column_dimensions[L] = ColumnDimension(ws, index=L, width=tpl_width)
# 見出し・データの書式は、メモ列のすぐ左（＝最後のジャンル列）を手本にする
tpl_col = memo - 1
for i, h in enumerate(new_heads):
    c = memo + i
    ws.cell(1, c).value = h
    ws.cell(1, c)._style = copy.copy(ws.cell(1, tpl_col)._style)
for r in range(2, max_row + 1):
    tstyle = ws.cell(r, tpl_col)._style
    v = by_id.get(str(ws.cell(r, memo + n + head[memo - 1:].index('動画ID')).value or '').strip())
    names = {f'出演:{short(ch[k])}' for k in (v.get('p', []) if v else [])} | {f'ユニット:{u}' for u in (v.get('u', []) if v else [])}
    for i, h in enumerate(new_heads):
        cell = ws.cell(r, memo + i)
        cell._style = copy.copy(tstyle)
        cell.value = '○' if h in names else None

# ○だけ入力できる設定と色付け（出演=薄い黄色、ユニット=薄い水色）
first, last = get_column_letter(memo), get_column_letter(memo + n - 1)
dv = DataValidation(type='list', formula1='"○"', allow_blank=True, showErrorMessage=True,
                    errorTitle='入力できるのは○だけです', error='当てはまる場合は○、当てはまらない場合は空欄にしてください。')
ws.add_data_validation(dv); dv.add(f'{first}2:{last}{max_row}')
cast_n = sum(1 for h in new_heads if h.startswith('出演:'))
if cast_n:
    ws.conditional_formatting.add(f'{first}2:{get_column_letter(memo + cast_n - 1)}{max_row}',
        CellIsRule(operator='equal', formula=['"○"'], fill=PatternFill('solid', fgColor='FFF0C2')))
if n > cast_n:
    ws.conditional_formatting.add(f'{get_column_letter(memo + cast_n)}2:{last}{max_row}',
        CellIsRule(operator='equal', formula=['"○"'], fill=PatternFill('solid', fgColor='D6EEF8')))
if ws.auto_filter.ref:
    a, b = ws.auto_filter.ref.split(':')
    import re
    col_b, row_b = re.match(r'([A-Z]+)(\d+)', b).groups()
    from openpyxl.utils import column_index_from_string
    ws.auto_filter.ref = f'{a}:{get_column_letter(column_index_from_string(col_b) + n)}{row_b}'

# 使い方シートに説明を追記
if '使い方' in wb.sheetnames:
    info = wb['使い方']
    for line in [
        '',
        '出演者・ユニットについて',
        '・「出演:〇〇」列はその動画に出ているメンバー、「ユニット:〇〇」列はユニットとしての出演です。',
        '・出演・ユニットの列に○が1つでもある行は、その○のとおりになります（自動判定は使いません）。',
        '・出演・ユニットの列の○をすべて消すと、その行は自動判定（タイトルの名前・愛称・ユニット名など）に戻ります。',
        '・ユニットに○を付けても、出演者の○は自動では付きません。出ているメンバーにも○を付けてください。',
    ]:
        info.append([line])

wb.save(out)
print(f'列を追加: {", ".join(new_heads)}')
