# CLAUDE.md ― パレプロ アーカイブ検索

Palette Project（パレプロ）の配信アーカイブを検索できる**非公式ファンサイト**。
お金をかけずに公開する前提で、GitHub Pages ＋ GitHub Actions だけで動かしている（サーバー・DB なし）。

- 公開サイト：https://bigrock0223.github.io/palepro-archive/
- 確認モード：https://bigrock0223.github.io/palepro-archive/review.html
- リポジトリ：`bigrock0223/palepro-archive`（Public、ブランチ `main`）
- 運用ルールの詳細は `README.md` にある（Excel・確認モード・鍵の作り方など）

## 進め方（ユーザーとの約束）

- やりとりは**日本語**。ユーザーはプログラマーではないので、専門用語はかみくだいて説明する
- **曖昧な点は作業前に確認する**（選択肢を出すと答えやすい）
- 「案出しだけ」「まだ修正しないで」と言われたら、ファイルを変更しない
- 変更後は、実際に動かして確認してから報告する（ビルド、画面の表示など）
- **commit / push はユーザーに頼まれたときだけ**。push の前に必ず `git pull --rebase origin main`（自動更新が頻繁にコミットするため）。**force push はしない**
- ユーザーは普段 GitHub Desktop で **Commit → Pull origin → Push origin** の順に操作している
- 画面の操作はクリックが基本（キーボードショートカットは補助）

## デザイン（DESIGN.md に従う）

- **検索サイト・確認モードの見た目を変えるときは、必ず先に `DESIGN.md` を読み、そのルールに従う**（色は `:root` の変数、文字の大きさ・余白・角丸は決まった値だけ）
- 変更後は `DESIGN.md` の「6. 変更時のチェックリスト」で確認してから報告する
- ルールに合わない変更が必要なときは、勝手に例外を作らずユーザーに相談し、決まったら `DESIGN.md` も更新する
- 参考サイトのスクリーンショットはリポジトリの外（`..\palepro-design-refs\`）に置いている。他サイトの画像なのでリポジトリには入れない

## よく使うコマンド

```bash
node scripts/build.mjs                       # サイト用データを生成（public/data/ 以下）
YT_API_KEY=xxx node scripts/fetch.mjs        # YouTube から取得（通常は GitHub Actions が実行）
python tools/append_xlsx.py public/data/archives.js config/genres.xlsx config/genres.xlsx   # Excel に新着を追記
python tools/import_site_edits.py config/genres.xlsx config/site-edits.json config/genre-rules.json  # 確認モードの結果を Excel に取り込む
```

- 画面確認は `public/index.html` / `public/review.html` をブラウザで開くだけでよい（file:// で動く作り）
- Python のツールは `openpyxl` が必要。Node.js は 18 以上（Actions は 20）

## 全体の仕組み

```
GitHub Actions「update-archives」（3時間ごと／push 時／手動）
  build:  fetch.mjs → data/videos.json（コミット） → build.mjs → public/ 一式をアップロード
  deploy: needs: build → GitHub Pages に公開
ブラウザ
  index.html  … 検索サイト（素の HTML+JS。archives.js を <script> で読み込み）
  review.html … 確認モード（ユーザーの鍵で config/site-edits.json を GitHub API 経由で直接更新）
```

**ジャンル・出演者・ユニット・種類の優先順位：確認モードの修正（site-edits.json） ＞ Excel（genres.xlsx） ＞ 自動判定**

## フォルダ構成

```
DESIGN.md           画面のデザインルール（参考サイト10件の分析つき）
config/
  channels.json     チャンネル（key・名前・色・@ハンドル）。並び順＝サイトのメンバー並び順
  genres.xlsx       ユーザーが編集する管理用 Excel（ジャンル・出演・ユニット・種類・確認済）
  genre-rules.json  ジャンル自動判定のキーワード
  cast.json         出演者・ユニット自動判定（名前・愛称・ユニット・コンビ・デビュー日・全員回）
  site-edits.json   確認モードの結果（確認モードが書く。手で編集しない）
  overrides.csv     予備（ほぼ未使用）
scripts/
  fetch.mjs         YouTube Data API v3（差分取得、25日で取り直し、概要欄冒頭300字も保存）
  build.mjs         サイト用データ生成（下記）
  xlsx-read.mjs     依存なしの xlsx リーダー（日本語版 Excel のふりがな <rPh> を除去）
  make-dummy.mjs    ダミーデータ作成（初期の試作用）
tools/              Python + openpyxl。Excel を書式ごと扱うためのツール
  append_xlsx.py / import_site_edits.py / add_cast_columns.py / export_xlsx.py
public/
  index.html app.js search.css           検索サイト（B案）
  review.html review.js style.css review.css   確認モード（style.css は確認モード用に旧デザインのまま）
  data/archives.js, review-data.js, desc/d0〜15.js   生成物（.gitignore 済み）
.github/workflows/update.yml             自動更新（build / deploy の2ジョブ）
```

## build.mjs の決まりごと

- **種類**：`live`（配信）/ `video`（動画）/ `short`（3分以内 or #shorts）。Excel「種類」列（配信/動画/ショート）があれば優先
- **ジャンル**：Excel の行に○が1つでもあれば Excel の○だけ。なければ `genre-rules.json`。どれにも当たらなければ「その他」
  - ジャンルのキーワード照合は NFKC＋小文字化＋**ひらがな・カタカナを同一視**
- **出演者(p)・ユニット(u)**：Excel の「出演:」「ユニット:」列に○が1つでもあればそれ、なければ `cast.json` で自動判定
  - 名前の照合は NFKC＋小文字化のみ。**ひらがなとカタカナは区別する**（「ことはない」→コトハ、「歩む」→アユム の誤判定防止）
  - チャンネル主は常に出演者。ユニット名 → ユニットのメンバー全員＋ユニットタグ。コンビ名 → メンバー
  - 公式チャンネルで「全員集合」「全員」→ その日までにデビュー済みのメンバー全員
- **site-edits.json** は書かれた項目だけ上書き。確認モードで追加したジャンルはキーワードで自動判定にも使う
- **要確認の理由**：noGenre / officialNoCast / unitSolo / weakCast / allMembers / typeCheck
- **シリーズ**：タイトルの【】内から日付・数字を除いたもの（メンバー名だけの【】は除外）。チャンネル＋シリーズ名で3本以上
- archives.js の動画レコード：`{id, c, t, s, d, ty, th, g, m, p, u}`（c=チャンネル, s=開始日時, d=秒, g=ジャンル, m=手動, p=出演者キー, u=ユニット）

## Excel（config/genres.xlsx）

- シート名「ジャンル」。固定見出し：`配信日時 メンバー 種類 長さ タイトル 確認済 メモ 動画ID URL`
- 固定以外の列はジャンル列。ただし `出演:〇〇`（8列）と `ユニット:〇〇`（5列）は別扱い
- サイトに反映されるのは：ジャンル・出演・ユニットの○、種類、確認済（空欄でなければ確認済み）、動画ID
- ジャンル列の順番＝サイトのジャンル並び順。ジャンルの追加は列を挿入して見出しを書く
- 現在のジャンル列：歌枠、歌ってみた、踊ってみた、オリジナル曲、ライブ、3D、ゲーム、雑談、作業配信、同時視聴、お絵描き、朝活、ASMR、コラボ、参加型、企画、誕生日・記念、お知らせ、公式配信（自動判定ルールの名前は「公式番組」のまま）、切り抜き、冒頭無料、シチュボ
- **注意**
  - Excel はバイナリなので Git でマージできない。Excel を触る作業の前に、ユーザーに「Excel を閉じて Commit → Pull → Push」してもらう
  - ユーザーがフォント（Meiryo UI 8pt）・列幅・グループ化・ウィンドウ枠固定を設定している。**書き換えるときは書式を保つ**（`append_xlsx.py` / `import_site_edits.py` は対応済み。`export_xlsx.py` は作り直しなので書式が消える）
  - openpyxl の `insert_rows` / `insert_cols` は、行の高さ・列幅・グループ化・入力規則・条件付き書式・フィルター範囲をずらさない。ツール側で自前でずらしている（まとめて設定された列幅 min/max の展開にも注意）

## メンバー・ユニット

対象は**現役8名のみ**（卒業・休止メンバー、パレプロ外のゲストは対象外）。

| key | 名前 | 色 | デビュー日 | 愛称など（cast.json） |
|---|---|---|---|---|
| official | Palette Project 公式 | 白＋金の縁取り（color #ffffff, ring #d4a52c） | – | – |
| clara | 暁月クララ | オレンジ #f39a4c | 2018-07-23 | クララちゃん、くーちゃん、ぷりん |
| rona | 七海ロナ | 青 #5a8fe0 | 2018-07-23 | ロナちゃん、ロナロナ（除外：コロナ等） |
| kaname | 常磐カナメ | 濃い緑 #2f9e5a | 2019-04-28 | カナメちゃん、なめなめ、なめこ、ちくわぶ |
| kotoha | 藤宮コトハ | ピンク #f2a7c3 | 2019-05-06 | コトハちゃん、こぱちゃん |
| kyouka | 江波キョウカ | 赤 #e05555 | 2020-02-07 | キョウカちゃん、きょんち、江波ちゃん、ぴよ |
| ayumu | 鬼多見アユム | 紫 #9a72d6 | 2020-06-15 | アユムちゃん、あゆゆ |
| hanon | 香鳴ハノン | 水色 #6ec8f0 | 2020-10-01 | ハノンちゃん、はのは、なっとう |
| mahalo | 夏渚まはろ | パールアクア #88d8c0 | 2024-05-11（研究生デビュー） | まはろん、隊長 |

- デビュー日は「データ上で最初に名前が出た日」からの推定（全員回の判定に使用）
- メンバー欄の並び：公式 → クララ → ロナ → カナメ → コトハ → キョウカ → アユム → ハノン → まはろ
- ヘッダーの8色の点：オレンジ、青、緑、ピンク、赤、紫、水色、パールアクア
- **ユニット（検索可）**：Sputrip＝クララ・カナメ・ハノン／REGALILIA＝キョウカ・アユム／RouteHeart＝ロナ・コトハ／Alt!!＝ロナ・クララ／Altimate＝ロナ・コトハ
- **コンビ（出演者を付けるだけ）**：ぎゃるばぶ＝ロナ・コトハ・カナメ・アユム、ろなめこ＝ロナ・カナメ、ぴよノン＝キョウカ・ハノン、くらきょん＝クララ・キョウカ、小川コンビ＝カナメ・まはろ、ばぶず＝アユム・カナメ、えばまは＝キョウカ・まはろ、はのまはろん＝ハノン・まはろ

## 検索サイト（index.html）

- **B案（Steam 型）のデザイン**（2026-11-26 反映）。見た目は `search.css`（確認モードの `style.css` とは別）
- 暗いヘッダー：サイト名＋キーワード検索＋最終更新、下にメンバー8色の線
- 左：結果（件数・並び順・「リスト／カード」切り替え → 一覧 → ページ番号）。最初はリスト、`view=card` でカード
- 右：絞り込み欄（種類〈件数つき〉、メンバー（出演）＋「全員出演」「選んだメンバーだけが出演（完全一致）」「そのメンバーのチャンネルの動画だけ」、ユニット、ジャンル（「すべて含む」・最初は10件で「すべて表示」）、長さ・配信日（日付2つ＋1週間/1か月/1年/指定なし））
- スマホ（860px 以下）：リストだけ。「絞り込み」ボタンで全画面の絞り込みを開き、下の「〇件を表示」で閉じる。ページは「前へ / 次へ」
- 1ページ60件。条件はすべて URL クエリに保持（共有・戻る対応）
- 変更前のバックアップ：リポジトリの外 `..\palepro-backup\2026-11-26_B案反映前\`、Git のタグ `before-B-design`（ローカルのみ）
- 確認モードの設定を保存したブラウザだけ、フッターに「確認モード」リンク

## 確認モード（review.html）

- 鍵：GitHub の fine-grained personal access token（対象は `palepro-archive` のみ、Contents: Read and write、**期限 2027-02-21**）。ブラウザの localStorage（`palepro-review-config`）にだけ保存
- 1件ずつ（OK → 次へ）／一覧で一括／前の動画と同じ／Excel・自動判定に戻す／シリーズ一括（**ジャンルとユニットだけ**適用、出演者・種類は個別）
- ＋新しいジャンル（ジャンルのみ追加可、キーワード任意）→ キーワードで探して過去の動画にまとめて付与。改名・削除・統合は Excel か依頼で行う
- 20件ごと・2分ごとに自動保存。GitHub Contents API で `config/site-edits.json` を PUT（sha で競合を検知して最大3回やり直し）
- site-edits.json の形式：
  ```json
  { "newGenres": [{"name":"料理","keywords":["料理"],"added":"2026-11-23"}],
    "videos": { "動画ID": {"reviewed":"2026-11-23","type":"動画","genres":[],"cast":["クララ"],"units":["Sputrip"]} } }
  ```
- 保存後の反映は、自動更新（数分）＋ GitHub Pages のキャッシュ（最大10分）。すぐ見たいときは Ctrl+F5
- 確認結果が増えたら `tools/import_site_edits.py` で Excel に取り込み、site-edits.json を空に戻す（一本化）

## 自動更新（.github/workflows/update.yml）のメモ

- Secrets：`YT_API_KEY`（YouTube Data API v3 のみに制限）。Variables：`SHEET_CSV_URL`（未使用）
- upload と deploy を同じジョブで続けると「artifact が見つからない」で失敗したため、build / deploy の2ジョブに分けている
- コミット前に `git pull --rebase origin main` を入れている（確認モードの保存と重なっても push できるように）
- 失敗したときの「Re-run failed jobs」は古いコミットでやり直すため push が拒否されることがある → 「Run workflow」で新しく実行する
- YouTube API の無料枠は 1日 10,000 ユニット。`search.list`（100ユニット）は使わない

## 今後の候補（未着手）

- 自動判定の材料を増やす：概要欄（保存済み）、YouTube のカテゴリ、チャンネルの再生リスト
- 自信の低い動画だけ Claude が推奨タグを提案する
- Excel 未登録の新着の追記（2026-11-23 時点で29件）
- 確認モード結果の Excel 取り込み（定期的に）
- みんなでタグ付け（Cloudflare Workers + D1 + Turnstile）は説明済み・未採用
- 鍵の期限切れ（2027-02-21）時は作り直して確認モードの「鍵の設定」に貼り直す
- 公開時は公式の二次創作ガイドライン（paletteproject.jp/guidelines）を確認し、「非公式」を明記
