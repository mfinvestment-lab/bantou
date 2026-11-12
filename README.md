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
| `GET /admin/linen-usage?key=…&days=30` | リネン使用数の報告と計算値の比較 |
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
- 使用数：次のゲスト用にセットする人数・泊数で計算（清掃通知と同じ。当日・翌日到着ならその予約、先なら定員×1泊と比べて大きい方、予約なしは定員×1泊）。ベッドは人数＋1人分。シングルから使う場合とダブルから使う場合の両方を計算し、品目ごとに多い方を取る（ゲスト次第のため）、タオルは人数×泊数、バスマット1（nel. は2〜3泊2・4泊以上3）
- スタッフの「リネン使用数」報告は KV に記録し、`/admin/linen-usage?key=…&days=30` で計算値と並べて見られる（式の調整用）
- 送り先：`LINE_GROUP_LINEN`（ゆーかさんとのグループ）があれば［ゆーかさんのグループに送る］で HARU が直接投稿。なければ LINE の共有画面
- ［ゆーかさんに送る］で記録：富士宮は「小屋」に加算（HARU の「補充」で減る）、静岡は在庫シートに納品翌日付けで登録（9:00の納品反映で加算）
- ［数量を直す］→「サクヤ（改行）バスタオル 40」の形で送ると案を作り直す。9:20までに送っていなければ1回再通知
- SORAコマンド：`リネン発注案`（今すぐ作る）／`小屋`／`小屋クリア`／`小屋登録`（改行して手で送った発注文を貼る）
- 常備数・納品単位・使用数は `src/linen.js` 冒頭の `FAC` と `UNIT`

## リネン入力画面（`/liff/linen`、HARU のリッチメニュー）
- 使った枚数：清掃のあと。次のゲストの人数・泊数（間があくときは定員×1泊）を表示。枚数は空欄から入力。今日すでに入力済みなら警告
- 物件の取り違え防止：清掃カードの［② リネン］から開くとその物件に固定。メニューから開くと最初に物件を選ぶ（初期選択なし）。物件ごとに色を変え、送信前に物件名を確認
- 補充：富士宮のみ。小屋から運んだ枚数。初期値は未補充の枚数。静岡は納品翌日に自動加算なので入力不要
- 棚卸：今ある枚数で上書き。富士宮は「小屋は空」にチェックすると未補充を0にする
- グループのボタンから開くと、そのグループの物件だけ表示（富士宮＝サクヤ・桜ハウス、静岡＝nel.）。グループのメンバーなら担当登録なしで使える
- 清掃開始の返信にリネン入力ボタン。入力するとトークに「📝 リネン入力（…）」が送られ、返信で清掃終了ボタンが出る（どちらも返信なので通数を使わない）
- `LINEN_PROMPT_PUSH = "on"` で、清掃開始から1時間後にもリネン入力ボタンをグループへ送る（未入力・未終了のときだけ。グループ宛ては人数分の通数）
- グループでのテキスト報告（使用数・補充・棚卸 物件名）は今までどおり使える

## 消耗品の「足りない物」（`src/supplies.js`）
- HARU のリッチメニュー「足りない物」（グループでは「足りない物」と送る、またはキーボード上の🧴）→ 担当エリア（富士宮／静岡）の品目ボタン。押した物が発注リスト（KV `sup:pending:<エリア>`）に入る。✓は入っている物
- 富士宮はサクヤ・桜ハウスで1つの在庫（桜ハウス置き配）。ブルーレットは富士宮（サクヤ）だけ
- 毎日18:00、前回から増えた品目があれば SORA にエリアごとのまとめを1通。SORA で「発注まとめ」と送ればいつでも表示（返信なので通数を使わない）
- まとめの［Amazonカートに入れる］で Amazon 品をまとめてカートへ（各1個。数量はカートで直す）。注文の確定は Amazon で本人が行う。品目のURLは必ず amazon.co.jp/dp/<商品ID> の形で書く（短縮リンク amzn.asia は使わない）
- 個別手配（シャンプー・コンディショナー・ボディソープ・ハンドソープ）は通知のみ、リンクなし
- ［発注済みにする］でカードに載っていた品目をリストから外す（後から入った分は残る）
- 品目の正本は運営PJの消耗品リスト（Claude Sheet）。品目を増減したら `ITEMS` を直す
- 確認用：`/admin/supplies`（発注リスト）、`/admin/supplies-cart`（全Amazon品の商品ID解決テスト）、`/admin/supplies-digest`（18時のまとめを今すぐ）
