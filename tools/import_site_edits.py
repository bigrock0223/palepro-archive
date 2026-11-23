# 確認モードの結果（config/site-edits.json）を genres.xlsx に取り込む（書式・グループ化・入力規則はそのまま残す）
# 使い方: import_site_edits.py config/genres.xlsx config/site-edits.json config/genre-rules.json [出力.xlsx]
#   - 「確認済」列がなければ「メモ」列の左に作る
#   - 確認モードで追加したジャンルは、ジャンル列の右端（最初の「出演:」列の左）に列を作り、genre-rules.json にもキーワードを登録する
#   - 取り込めた分は site-edits.json から消す（Excel に載っていない動画の分は残す）
import json, sys, copy, re
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter, column_index_from_string, range_boundaries
from openpyxl.worksheet.dimensions import ColumnDimension
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.formatting.rule import CellIsRule
from openpyxl.styles import PatternFill

xlsx, edits_path, rules_path = sys.argv[1:4]
out = sys.argv[4] if len(sys.argv) > 4 else xlsx
FIXED = ['配信日時', 'メンバー', '種類', '長さ', 'タイトル', '確認済', 'メモ', '動画ID', 'URL']

edits = json.load(open(edits_path, encoding='utf8')) if open(edits_path, encoding='utf8').read().strip() else {}
new_genres = edits.get('newGenres', [])
videos = edits.get('videos', {})

wb = load_workbook(xlsx)
ws = wb['ジャンル']

def header():
    return [str(c.value).strip() if c.value is not None else '' for c in ws[1]]

def col_widths():
    out = {}
    for key, dim in list(ws.column_dimensions.items()):
        if not dim.width: continue
        lo = dim.min or column_index_from_string(key)
        hi = dim.max or lo
        for c in range(lo, hi + 1): out[c] = (dim.width, dim.hidden, dim.outlineLevel)
    return out

def shift_ref(ref, at, n):
    """列 at 以降を n 列右へずらした範囲（at より左で始まり at 以降にかかる範囲は広げる）"""
    parts = []
    for part in str(ref).split():
        min_col, min_row, max_col, max_row = range_boundaries(part)
        if max_col >= at:
            if min_col >= at: min_col += n
            max_col += n
        parts.append(f'{get_column_letter(min_col)}{min_row}:{get_column_letter(max_col)}{max_row}')
    return ' '.join(parts)

def insert_cols(at, names, tpl_col, width=None):
    """列 at の位置に names の列を差し込む。見出し・セルの書式は tpl_col 列を手本にする"""
    n = len(names)
    widths = col_widths()
    tpl_w = (widths.get(tpl_col) or (4.2, False, 0))[0]
    # 入力規則・条件付き書式・フィルターは insert_cols で動かないので自前でずらす
    for dv in ws.data_validations.dataValidation:
        from openpyxl.worksheet.cell_range import MultiCellRange
        dv.sqref = MultiCellRange(shift_ref(dv.sqref, at, n))
    from openpyxl.formatting.formatting import ConditionalFormattingList
    cf_new = ConditionalFormattingList()
    for rng in ws.conditional_formatting:
        for rule in rng.rules: cf_new.add(shift_ref(rng.sqref, at, n), rule)
    ws.conditional_formatting = cf_new
    if ws.auto_filter.ref: ws.auto_filter.ref = shift_ref(ws.auto_filter.ref, at, n)
    tpl_styles = [copy.copy(ws.cell(r, tpl_col)._style) for r in range(1, ws.max_row + 1)]
    ws.insert_cols(at, n)
    ws.column_dimensions.clear()
    for c, (w, hidden, lvl) in widths.items():
        nc = c if c < at else c + n
        L = get_column_letter(nc)
        ws.column_dimensions[L] = ColumnDimension(ws, index=L, width=w, hidden=hidden, outlineLevel=lvl)
    for i, name in enumerate(names):
        c = at + i
        L = get_column_letter(c)
        ws.column_dimensions[L] = ColumnDimension(ws, index=L, width=width or tpl_w)
        for r in range(1, ws.max_row + 1):
            ws.cell(r, c)._style = copy.copy(tpl_styles[r - 1])
        ws.cell(1, c).value = name

max_row = ws.max_row
added_cols = []

# 1) 「確認済」列
h = header()
if '確認済' not in h:
    memo = h.index('メモ') + 1
    insert_cols(memo, ['確認済'], memo, width=11)
    for r in range(2, max_row + 1): ws.cell(r, memo).value = None
    added_cols.append('確認済')

# 2) 確認モードで追加したジャンルの列
h = header()
to_add = [g['name'] for g in new_genres if g.get('name') and g['name'] not in h]
if to_add:
    first_cast = next((i + 1 for i, x in enumerate(h) if x.startswith('出演:') or x.startswith('ユニット:') or x in ('確認済', 'メモ')), len(h) + 1)
    tpl = first_cast - 1  # 最後のジャンル列を手本にする
    insert_cols(first_cast, to_add, tpl)
    for i in range(len(to_add)):
        for r in range(2, max_row + 1): ws.cell(r, first_cast + i).value = None
    L1, L2 = get_column_letter(first_cast), get_column_letter(first_cast + len(to_add) - 1)
    dv = DataValidation(type='list', formula1='"○"', allow_blank=True, showErrorMessage=True,
                        errorTitle='入力できるのは○だけです', error='当てはまる場合は○、当てはまらない場合は空欄にしてください。')
    ws.add_data_validation(dv); dv.add(f'{L1}2:{L2}{max_row}')
    ws.conditional_formatting.add(f'{L1}2:{L2}{max_row}', CellIsRule(operator='equal', formula=['"○"'], fill=PatternFill('solid', fgColor='E3DCF7')))
    added_cols += to_add

# 3) 各動画の行に反映
h = header()
col = {x: i + 1 for i, x in enumerate(h) if x}
genre_cols = [(x, i + 1) for i, x in enumerate(h) if x and x not in FIXED and not x.startswith(('出演:', 'ユニット:'))]
cast_cols = [(x[3:].strip(), i + 1) for i, x in enumerate(h) if x.startswith('出演:')]
unit_cols = [(x[5:].strip(), i + 1) for i, x in enumerate(h) if x.startswith('ユニット:')]
row_of = {}
for r in range(2, max_row + 1):
    v = ws.cell(r, col['動画ID']).value
    if v is not None and str(v).strip(): row_of[str(v).strip()] = r
done, missing = [], []
for vid, e in videos.items():
    r = row_of.get(vid)
    if r is None: missing.append(vid); continue
    if e:
        if e.get('type'): ws.cell(r, col['種類']).value = e['type']
        if isinstance(e.get('genres'), list):
            for g, c in genre_cols: ws.cell(r, c).value = '○' if g in e['genres'] else None
        if isinstance(e.get('cast'), list):
            for n, c in cast_cols: ws.cell(r, c).value = '○' if n in e['cast'] else None
        if isinstance(e.get('units'), list):
            for n, c in unit_cols: ws.cell(r, c).value = '○' if n in e['units'] else None
        if e.get('reviewed'): ws.cell(r, col['確認済']).value = e['reviewed']
    done.append(vid)

# 4) 追加ジャンルのキーワードを自動判定ルールへ
rules = json.load(open(rules_path, encoding='utf8'))
names = {r['genre'] for r in rules['rules']}
for g in new_genres:
    if g.get('name') and g.get('keywords') and g['name'] not in names:
        rules['rules'].append({'genre': g['name'], 'keywords': g['keywords']})
json.dump(rules, open(rules_path, 'w', encoding='utf8'), ensure_ascii=False, indent=2)

wb.save(out)
# 5) 取り込めた分を site-edits.json から消す
rest = {'newGenres': [], 'videos': {k: v for k, v in videos.items() if k in missing}}
with open(edits_path, 'w', encoding='utf8') as f:
    f.write('{\n  "newGenres": [],\n  "videos": {' + ','.join(f'\n    {json.dumps(k, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False, separators=(",", ":"))}' for k, v in rest['videos'].items()) + ('\n  ' if rest['videos'] else '') + '}\n}\n')
print(f'取り込み {len(done)} 件 / Excel未登録で残した分 {len(missing)} 件 / 追加した列: {", ".join(added_cols) or "なし"}')
