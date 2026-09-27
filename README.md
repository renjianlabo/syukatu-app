# 就活情報整理アプリ

就活中の元情報を情報カードとして保存する、Node.js と素の JavaScript/CSS のWebアプリです。画面は [Figma UI-test-ver.7](https://www.figma.com/design/GD21XxMqZEZyiiJRmZbF6L/UI-test-ver.7?node-id=8-8) の共通トークン、Desktop、Mobile、Statesを基準にしています。

## 起動

Node.js 20以上が必要です。アプリ本体にnpm依存パッケージはありません。

```powershell
npm start
```

既定では `http://localhost:3000` に起動し、`data/app-data.json` に保存します。`PORT` と `DATA_FILE` で変更できます。

## 保存内容と互換性

- 保存先は企業、自分、その他です。企業は名前だけ作成できます。
- カードはタイトル、本文、保存先、複数カテゴリー、任意の日付、作成・更新日時、ピン状態、AI作成区分と元情報を保持します。
- 日付はユーザーが日付欄で設定した場合だけ保存します。本文から抽出しません。
- カテゴリー削除ではカードを残し、当該カテゴリーIDの紐付けだけ解除します。
- AIカードの生成本文は700文字以内です。手動作成と保存後の手動編集には同じ制限を課しません。
- 既存JSONのURL・企業情報フィールドは読み込み時に破棄しません。最新画面では表示・編集・新規入力しません。旧クライアント向け企業編集APIと企業AI APIは互換性のため残しています。

## AI整理

Geminiを使うときは、起動前に `GEMINI_API_KEY` を設定します。キーはサーバー側だけで使用します。

```powershell
$env:GEMINI_API_KEY = "your-api-key"
npm start
```

AIは入力された元情報だけを整理し、確認目的に応じて複数カードを提案します。結果画面で各カードを編集してから、`POST /api/cards/batch` で全件を一括保存します。カテゴリー候補は既存IDに限ります。`GEMINI_MODEL` でモデルを変更できます。既定値は `src/gemini.mjs` にあります。

## 検証

```powershell
npm test
node --check public/app.js
node --check server.mjs
node scripts/verify-ui.mjs
```

`npm test` はドメイン処理、REST API、AIプロンプト、JSON保存を確認します。`scripts/verify-ui.mjs` は一時JSONファイルとChrome/PlaywrightでPC・モバイルの主要操作を試し、`artifacts/latest-ui-checks` に比較用画像を保存します。UI検証のAI応答はテスト用の模擬応答です。`PLAYWRIGHT_MODULE`、`BROWSER_EXECUTABLE`、`UI_SCREENSHOT_DIR` で検証環境を変更できます。

実Geminiの疎通はキー設定後に `npm run test:gemini` で確認できます。ビルド工程とTypeScript型検査はなく、静的ファイルをそのまま配信します。
