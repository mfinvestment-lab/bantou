# デジタル番頭 v2（bantou）

HARU（清掃用）と SORA（管理用）の2つのLINE公式アカウントを、1つのCloudflare Workerで動かす。
設計の全体は 運営PJ の「LINEベース宿管理システム 構築計画」を参照。

## 構成

| ファイル | 役割 |
| --- | --- |
| `src/index.js` | 入口。URLで HARU / SORA / 管理用 に振り分け、定期実行を担当 |
| `src/line.js` | LINE送受信と署名検証（チャネルごとにトークンを持つ） |
| `src/beds24.js` | Beds24 API（予約取得） |
| `src/cleaning.js` | 毎朝8時の清掃通知（HARU → 清掃グループ） |
| `src/inventory.js` | 在庫・発注BOT（HARU ↔ GAS スプレッドシート） |
| `src/sora.js` | SORA側。今は受信ログのみ。ここに承認カードを足す |

GAS（スプレッドシートAPI）は旧番頭のものをそのまま使う。変更不要。

## URL

| パス | 用途 |
| --- | --- |
| `POST /haru/webhook` | HARU の Webhook URL（LINE Developers に設定） |
| `POST /sora/webhook` | SORA の Webhook URL |
| `POST /` | 旧番頭との互換。HARU扱い。切替後は使わない |
| `GET /health` | 稼働確認 |
| `GET /admin/cleaning-preview?key=…` | 清掃通知の内容を送らずに確認 |
| `GET /admin/cleaning-run?key=…` | 清掃通知を今すぐ送る（本番グループに届くので注意） |
| `GET /admin/delivery-run?key=…` | 納品反映を今すぐ実行 |
| `GET /admin/line-check?key=…` | HARU / SORA のトークンが有効か確認 |

## 設定（Cloudflare ダッシュボード → Worker → Settings → Variables and Secrets）

Secret（値は暗号化される。コードに書かない）

| 名前 | 内容 |
| --- | --- |
| `HARU_CHANNEL_SECRET` | HARU のチャネルシークレット |
| `HARU_CHANNEL_ACCESS_TOKEN` | HARU のチャネルアクセストークン（長期） |
| `SORA_CHANNEL_SECRET` | SORA のチャネルシークレット |
| `SORA_CHANNEL_ACCESS_TOKEN` | SORA のチャネルアクセストークン（長期） |
| `BEDS24_REFRESH_TOKEN` | 旧番頭と同じ値 |
| `ADMIN_KEY` | 管理用URLの合言葉。長いランダム文字列を自分で決める |

Variable（平文でよい）

| 名前 | 内容 |
| --- | --- |
| `GAS_URL` | 旧番頭と同じ値（script.google.com/macros/s/…/exec） |

グループIDと管理者IDは `wrangler.toml` の `[vars]` に入っている。

## デプロイ手順（初回）

1. GitHub に `mfinvestment-lab/bantou` リポジトリを作り、このフォルダを push する
2. Cloudflare → Workers & Pages → Create application → 「Import a repository」で bantou を選ぶ。
   ビルドコマンドなし、デプロイコマンド `npx wrangler deploy`
3. デプロイ後、Settings → Variables and Secrets に上の表を入れる
4. Settings → Trigger events に Cron が2つ（23:00 / 00:00 UTC）あることを確認（wrangler.toml から自動で入る）
5. `https://bantou.<account>.workers.dev/admin/line-check?key=<ADMIN_KEY>` で両トークンが ok になることを確認
6. LINE Developers → SORA → Messaging API設定 → Webhook URL に `https://bantou…workers.dev/sora/webhook` を入れて「検証」→ LINE Official Account Manager の応答設定で Webhook をオン
7. SORA を承認用グループに招待し、「ping」と送って「pong」が返れば完成
8. `https://…/admin/cleaning-preview?key=…` で翌朝の清掃通知の内容が旧番頭と同じか確認
9. 問題なければ LINE Developers → HARU → Webhook URL を `https://bantou…workers.dev/haru/webhook` に切り替え、旧Worker（snowy-wind-8046）の Cron を削除（二重送信防止）
10. 1週間動作を見て問題なければ旧Workerを削除

以降は GitHub の main に push すれば自動デプロイされる。

## 旧番頭からの変更点

- LINEのシークレットとトークンをコードから Secrets に移した（旧コードには直書きされていた。移行後に HARU のトークンを再発行すること）
- デバッグ用URL（/debug-line-token など、トークンが外から叩けた）を廃止し、ADMIN_KEY 付きの /admin/ に統一
- SORA 用の Webhook を追加（受信ログ、グループID確認、ping）
- 機能・文面・送信先は旧番頭と同じ
