# Umbrella Parade 原稿制作ツール

Kindle向け原稿と、しまうまマルシェ等に出稿するPDF原稿を、ページ設定に合わせて編集・書き出しするためのビジュアル原稿制作ツールです。

## 現在の実装

- Next.js + TypeScript + Tailwind CSS
- TipTapベースの見たまま本文エディタ
- 章の追加、削除、並び替え、タイトル編集
- Kindle / しまうまA6塗り足し版 / しまうまA5塗り足し版 / カスタムのページプリセット
- 余白、本文サイズ、ルビサイズ、行間、段落間隔の調整
- ルビ、画像、QRカード、改ページの挿入
- QRリンクライブラリ
- ブラウザ内の自動保存
- JSONインポート / エクスポート
- 現在の原稿レイアウトをPDFファイルとして書き出し
- Kindle向けの簡易DOCX出力
- Google Drive保存の接続口
- GitHub Pages用の静的デプロイワークフロー

## 開発

```bash
npm install
npm run dev
```

ローカルURL:

```text
http://127.0.0.1:3000
```

## ビルド

```bash
npm run typecheck
npm run build
```

`next.config.mjs` は GitHub Actions 上では `/novel-drafting-tool` の basePath を付けて静的出力します。

## Google Drive連携

Google Drive保存を有効にする場合は、`.env.local` に以下を設定します。

```bash
NEXT_PUBLIC_GOOGLE_CLIENT_ID=...
NEXT_PUBLIC_GOOGLE_API_KEY=...
```

`.env.local` はリポジトリ直下、`package.json` と同じ階層に作成します。設定後は `npm run dev` を再起動するか、公開用なら `npm run build` で作り直してください。

GitHub Pages版でDrive連携を有効にする場合は、公開用ビルドを作る環境にも同じ2つの値が必要です。APIキーやOAuthクライアントIDを公開ページへ埋め込む形になるため、Google Cloud Console側でHTTPリファラーとJavaScript生成元をこのサイトに限定してください。

スコープは `https://www.googleapis.com/auth/drive.file` と `https://www.googleapis.com/auth/drive.metadata.readonly` を使います。`drive.file` は原稿JSONの保存、`drive.metadata.readonly` は保存先フォルダ一覧の取得に使います。未設定の場合でも、ブラウザ保存とJSON書き出しは利用できます。

## 公開先

GitHub Pages:

```text
https://umbrellaparade.github.io/novel-drafting-tool/
```
