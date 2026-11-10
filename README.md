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
| `src/sora.js` | SORA側。承認カードのボタン処理と FAQ・ルール・学習例の登録コマンド |
| `src/approval.js` | 承認カード本体：5分ごとに Beds24 の未読を取得 → AI返信案 → SORAへカード → 承認で OTA へ返信 |
| `src/claude.js` | Claude API（Haiku既定、自信なしのとき Sonnet）。プロンプトキャッシュ利用 |
| `src/store.js` | KV：物件ごとの返信ルール・FAQ・学習例、カード状態、既読管理 |

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
| `GET /admin/messages-raw?key=…` | Beds24 の未読ゲストメッセージを生で表示（動作確認用） |
| `GET /admin/messages-poll?key=…` | 新着確認を今すぐ実行（カードが SORA に届く） |
| `GET /admin/linen-preview?key=…&text=1` | リネン発注案を送らずに計算（`today=` `nominal=` で日付指定可） |
| `GET /admin/linen-run?key=…&force=1` | リネン発注案を今すぐ SORA に出す |
| `GET /admin/linen-shed?key=…` | 物置小屋（富士宮・発注済み未補充）の記録 |
| `GET /linen/share?id=…` | 発注案の［ゆーかさんに送る］。発注を記録して LINE の共有画面へ |

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
| `ANTHROPIC_API_KEY` | Claude Console で作成した API キー |

Variable（平文でよい）

| 名前 | 内容 |
| --- | --- |
| `GAS_URL` | 旧番頭と同じ値（script.google.com/macros/s/…/exec） |

| `SORA_TARGET_ID`（任意） | 承認カードの送り先（グループID）。未設定なら OWNER_USER_ID（1対1） |

グループIDと管理者IDは `wrangler.toml` の `[vars]` に入っている。KV namespace の ID も `wrangler.toml` の `[[kv_namespaces]]` に入れる。

## 承認カードの使い方（SORA）

5分ごとに Beds24 の未読ゲストメッセージを確認し、返信案付きのカードが届く。
- ［このまま送信］… AI案を OTA へ送信
- ［修正して送信］… 次に入力した文面を送信し、学習例として保存
- ［自分で書く］… 同上（AI案なしで入力）
- 返金・鍵・法令に関わるものはボタンが［自分で書く］［対応しない］だけになる

登録コマンド（SORA に送る）
```
FAQ追加 サクヤ
Q: 駐車場はありますか？
A: 敷地内に1台無料でご利用いただけます。

FAQ一覧 サクヤ　／　FAQ削除 サクヤ 3
ルール設定 サクヤ（改行してルール本文）　／　ルール表示 サクヤ
学習一覧 サクヤ　／　学習削除 サクヤ 5
新着確認　／　ヘルプ
```

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

## リネン発注案（`src/linen.js`）

火・金 9:00（祝日なら前の平日）に SORA へ発注案を出す。`LINEN_ORDER = "on"` で有効。
- 富士宮（サクヤ＋桜ハウス）は翌日（水・土）納品、静岡（nel.）は木・月納品。nel. が納品日に連泊中なら「納品＆回収なし」。次回がスキップ見込みなら今回でその次まで賄う
- 発注数 ＝ 常備数 −（在庫シート ＋ 小屋 ＋ 入荷待ち − 納品日までの清掃で使う数）を納品単位で四捨五入。桜ハウスは切り捨て（リネン庫が小さい）
- 使用数：ベッドまわりは1清掃の最大数、タオルは人数×泊数、バスマット1（nel. は2〜3泊2・4泊以上3）。次の予約が遠いときは清掃通知と同じく定員で見る
- ［ゆーかさんに送る］で記録：富士宮は「小屋」に加算（HARU の「補充」で減る）、静岡は在庫シートに納品翌日付けで登録（9:00の納品反映で加算）
- ［数量を直す］→「サクヤ（改行）バスタオル 40」の形で送ると案を作り直す。9:20までに送っていなければ1回再通知
- SORAコマンド：`リネン発注案`（今すぐ作る）／`小屋`／`小屋クリア`
- 常備数・納品単位・使用数は `src/linen.js` 冒頭の `FAC` と `UNIT`
