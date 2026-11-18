# パレプロ アーカイブ検索（試作）

Palette Project の配信アーカイブを、日時・メンバー・ジャンル・キーワードで検索できる非公式ファンサイトの試作です。
サーバー・DB 不要、GitHub Pages（無料）で公開できる構成です。

## まず画面を見る（ダミーデータ入り）

`public/index.html` をブラウザにドラッグ＆ドロップ（ダブルクリック）するだけで動きます。
今入っているデータは画面確認用の **架空のダミー** です。

## フォルダ構成

```
config/
  channels.json      … 監視するチャンネル（メンバー名・色・@ハンドル）
  genre-rules.json   … 自動ジャンル判定のキーワード
  overrides.csv      … 手動ジャンル（ローカル版）
scripts/
  fetch.mjs          … YouTube API から取得 → data/videos.json
  build.mjs          … ジャンル付け → public/data/archives.js
  make-dummy.mjs     … ダミーデータ作成
data/videos.json     … 取得した生データ（Actions が自動更新）
public/              … 公開されるサイト本体（index.html / style.css / app.js）
_github/workflows/update.yml … 3時間ごとに自動取得して Pages に公開
                     ※ フォルダ名 `_github` を `.github` に変更してから push してください
```

## 本番データで動かす手順

1. **YouTube API キーを作る**
   Google Cloud Console でプロジェクト作成 → 「YouTube Data API v3」を有効化 → 「認証情報」で API キーを作成。
   キーの制限で「YouTube Data API v3 のみ」にしておくと安全です。
2. **チャンネルを設定**
   `config/channels.json` の `handle`（例 `@paletteproject`）を埋めます。空欄のメンバーは取得をスキップします。
   メンバー構成は最新の公式情報に合わせて増減してください。
3. **ローカルで試す（任意・Node.js 18以上）**
   ```
   set YT_API_KEY=取得したキー        (PowerShell なら $env:YT_API_KEY="...")
   node scripts/fetch.mjs --full
   node scripts/build.mjs
   ```
   `public/index.html` を開くと実データで表示されます。
4. **GitHub で公開**
   - フォルダ `_github` の名前を `.github` に変更（先頭の _ を . に）
   - このフォルダを GitHub リポジトリ（main ブランチ）に push
   - Settings > Secrets and variables > Actions > **Secrets** に `YT_API_KEY` を登録
   - Settings > Pages > Source を **GitHub Actions** に
   - Actions タブで `update-archives` を手動実行 → `https://<ユーザー名>.github.io/<リポジトリ名>/` で公開
   - 以後は 3 時間ごとに自動更新

   ※ 初回は全件取得になるので、ローカルで `--full` 実行後の `data/videos.json` を一緒に push しておくと楽です。
   ※ ダミーデータのまま push した場合は、`data/videos.json` を削除してから実行してください。

## ジャンルを手動で付ける（Googleスプレッドシート）

1. スプレッドシートを作り、1行目に `videoId,genres,mode,memo` の見出しを入れる
2. 1行ごとに動画ID（URL の `v=` の後ろ）・ジャンル（`|` 区切りで複数可）・モードを書く
   - `replace` … 自動判定を捨てて手動ジャンルにする
   - `add` … 自動判定に追加する
3. 「ファイル > 共有 > ウェブに公開」→ そのシートを **CSV** で公開し、URL をコピー
4. GitHub の Settings > Secrets and variables > Actions > **Variables** に `SHEET_CSV_URL` として登録

次回の自動更新（または Actions の手動実行）で反映されます。サイト上では手動ジャンルは紫色のタグで表示されます。
ローカルの `config/overrides.csv` も同じ書式で使えます（スプレッドシートが優先）。

## 自動ジャンルの調整

`config/genre-rules.json` にキーワードを足すだけです。全角半角・大文字小文字・ひらがなカタカナの違いは自動で吸収します。
どれにも当てはまらないものは「その他」になります。

## 注意
- YouTube API の規約に沿って、取得から 25 日経ったデータは自動で取り直し、削除・非公開になった動画は消えます。
- サムネイルは YouTube の画像をそのまま表示しています（自前で保存しない）。
- 公開前に公式の二次創作ガイドライン（https://paletteproject.jp/guidelines）を確認してください。
