# Umbrella Parade 原稿制作ツール

Kindle向け原稿と、しまうまマルシェ等の印刷用PDF原稿を、ページ設定に合わせて編集するためのビジュアル原稿制作ツールです。

## 現在の実装

- Next.js + TypeScript + Tailwind CSS
- TipTapベースの見たまま本文エディタ
- 章の追加、削除、並び替え、タイトル編集
- Kindle / しまうまA6 / しまうまA5 / カスタムのページプリセット
- 余白、本文サイズ、ルビサイズ、行間、段落間隔の調整
- ルビ、画像、QRカード、改ページの挿入
- QRリンクライブラリ
- ブラウザ内の自動保存
- JSONインポート / エクスポート
- ブラウザ印刷によるPDF出力
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

スコープは `https://www.googleapis.com/auth/drive.file` を使います。未設定の場合でも、ブラウザ保存とJSON書き出しは利用できます。

## 公開先

GitHub Pages:

```text
https://umbrellaparade.github.io/novel-drafting-tool/
```
