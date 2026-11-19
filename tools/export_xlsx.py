# 現在の判定結果（archives.js）から config/genres.xlsx を作る
import json, sys, datetime
from openpyxl import Workbook
from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.formatting.rule import CellIsRule
from openpyxl.utils import get_column_letter
# 使い方: export_xlsx.py archives.js 出力.xlsx [既存のgenres.xlsx]
# 既存ファイルを渡すと、既存の行（○・メモ・列の並び）はそのまま残し、未登録の新着だけを自動判定のジャンルで追加する
from openpyxl import load_workbook
arch, out = sys.argv[1], sys.argv[2]
prev = sys.argv[3] if len(sys.argv) > 3 else None
FIXED = ['配信日時', 'メンバー', '種類', '長さ', 'タイトル', 'メモ', '動画ID', 'URL']
PREFIX = ('暁月', '七海', '常磐', '藤宮', '江波', '鬼多見', '香鳴', '夏渚')
def short(name):
    for p in PREFIX:
        if name.startswith(p): return name[len(p):]
    return name
kept = {}; prev_genres = []
if prev:
    pws = load_workbook(prev, read_only=True)['ジャンル']
    rows = list(pws.iter_rows(values_only=True))
    ph = [str(h).strip() if h is not None else '' for h in rows[0]]
    prev_genres = [h for h in ph if h and h not in FIXED]  # 出演:・ユニット: 列もここに含めて並び順を引き継ぐ
    for r in rows[1:]:
        rec = dict(zip(ph, r))
        vid = str(rec.get('動画ID') or '').strip()
        if vid: kept[vid] = rec
txt = open(arch, encoding='utf8').read()
d = json.loads(txt[txt.index('{'):txt.rstrip().rstrip(';').rindex('}')+1])
ch = {c['key']: c['name'] for c in d['channels']}
genres = [g for g in d['genres'] if g != 'その他']
member_keys = [c['key'] for c in d['channels'] if any(c['key'] in v.get('p', []) for v in d['videos'])]
genres += [f"出演:{short(ch[k])}" for k in member_keys] + [f'ユニット:{u}' for u in d.get('units', [])]
if prev:
    new_ids = {v['id'] for v in d['videos'] if v['id'] not in kept}
    extra = [g for g in genres if g not in prev_genres and any(v['id'] in new_ids and g in v['g'] + v['m'] for v in d['videos'])]
    genres = prev_genres + extra
added = 0
TYPE = {'live': '配信', 'video': '動画', 'short': 'ショート'}
wb = Workbook(); ws = wb.active; ws.title = 'ジャンル'
head = ['配信日時', 'メンバー', '種類', '長さ', 'タイトル'] + genres + ['メモ', '動画ID', 'URL']
ws.append(head)
JST = datetime.timezone(datetime.timedelta(hours=9))
for v in d['videos']:
    t = datetime.datetime.fromisoformat(v['s'].replace('Z', '+00:00')).astimezone(JST).replace(tzinfo=None)
    h, m = divmod(v['d'] // 60, 60)
    url = 'https://www.youtube.com/watch?v=' + v['id']
    if v['id'] in kept:
        rec = kept[v['id']]
        marks = ['○' if str(rec.get(g) or '').strip() else None for g in genres]
        memo = rec.get('メモ')
    else:
        gs = set(v['g']) | set(v['m']) | {f"出演:{short(ch.get(k, k))}" for k in v.get('p', [])} | {f'ユニット:{u}' for u in v.get('u', [])}
        marks = ['○' if g in gs else None for g in genres]
        memo = '新着（自動判定）' if prev else None
        added += 1
    ws.append([t, ch.get(v['c'], v['c']), TYPE.get(v['ty'], v['ty']), f'{h}:{m:02d}', v['t']] + marks + [memo, v['id'], url])
n = ws.max_row; g0 = 6; g1 = 5 + len(genres)
thin = Side(style='thin', color='DDDDDD')
hdr_fill = PatternFill('solid', fgColor='F3F0FA')
for c in range(1, len(head) + 1):
    cell = ws.cell(1, c); cell.font = Font(bold=True); cell.fill = hdr_fill
    cell.alignment = Alignment(horizontal='center', vertical='bottom', wrap_text=True, text_rotation=255 if g0 <= c <= g1 else 0)
    cell.border = Border(bottom=thin)
ws.row_dimensions[1].height = 96
widths = {'A': 17, 'B': 16, 'C': 8, 'D': 7, 'E': 70}
for k, w in widths.items(): ws.column_dimensions[k].width = w
for c in range(g0, g1 + 1): ws.column_dimensions[get_column_letter(c)].width = 4.2
ws.column_dimensions[get_column_letter(g1 + 1)].width = 24
ws.column_dimensions[get_column_letter(g1 + 2)].width = 14
ws.column_dimensions[get_column_letter(g1 + 3)].width = 44
for r in range(2, n + 1):
    ws.cell(r, 1).number_format = 'yyyy/mm/dd hh:mm'
    for c in range(g0, g1 + 1): ws.cell(r, c).alignment = Alignment(horizontal='center')
gl, gr = get_column_letter(g0), get_column_letter(g1)
dv = DataValidation(type='list', formula1='"○"', allow_blank=True, showErrorMessage=True, errorTitle='入力できるのは○だけです', error='ジャンルに当てはまる場合は○、当てはまらない場合は空欄にしてください。')
ws.add_data_validation(dv); dv.add(f'{gl}2:{gr}{n}')
ws.conditional_formatting.add(f'{gl}2:{gr}{n}', CellIsRule(operator='equal', formula=['"○"'], fill=PatternFill('solid', fgColor='E3DCF7')))
ws.freeze_panes = 'F2'
ws.auto_filter.ref = f'A1:{get_column_letter(len(head))}{n}'
# 説明シート
info = wb.create_sheet('使い方')
for line in [
  'このファイルの使い方',
  '・「ジャンル」シートの○を付け外しすると、サイトのジャンルが変わります（○以外は空欄に）。',
  '・この表に載っている動画は、この表の○だけがジャンルになります（自動判定は使いません）。',
  '・ある行の○をすべて消すと、その動画は自動判定のジャンルに戻ります。',
  '・この表にない新着動画は自動判定のジャンルになります。新着の追記はClaudeに依頼してください。',
  '・ジャンルを増やすときは、「メモ」列の左に列を挿入して1行目にジャンル名を書きます。',
  '・ジャンル名を変えるときは1行目を書き換えます（新着の自動判定にも反映したいときはClaudeに伝えてください）。列の並び順がサイトでのジャンルの並び順になります。',
  '・新着として追加された行は「メモ」列に「新着（自動判定）」と入ります。確認したらメモを消してかまいません。',
  '・「配信日時」「メンバー」「種類」「長さ」「タイトル」「URL」は参照用です（書き換えても反映されません）。',
  '・「動画ID」列は消したり書き換えたりしないでください。',
  '・編集後は上書き保存（.xlsx のまま）→ GitHub Desktop で Commit → Push すると反映されます。',
]:
    info.append([line])
info['A1'].font = Font(bold=True, size=13); info.column_dimensions['A'].width = 110
wb.save(out); print('rows', n - 1, 'genres', len(genres), 'added', added if prev else '-')
