# 構築手順

`docs/design.md` の設計を実際に動かすまでの手順。上から順に実行する。
所要時間は 60〜90分程度。**Step 7 の導入時検証まで終えて初めて「導入した」と言える。**

## 0. 前提

| 必要なもの | 用途 | 備考 |
|---|---|---|
| Android 端末 + [Tasker](https://tasker.joaoapps.com/) | ハートビートの発信 | 有料アプリ。日常的に使っている端末であること |
| [healthchecks.io](https://healthchecks.io/) アカウント | 無音検知・状態管理 | 無料プランで足りる |
| Cloudflare アカウント | 通知アダプタの配置先 | Workers の無料枠で足りる |
| Discord サーバ | 通知の受信 | 運用者用・一次受信者用の2チャンネルを使う |
| Node.js 20 以降 | アダプタのデプロイ | |

> **記録用のメモを1枚用意する。** UUID や Webhook URL をこの後いくつも扱う。
> それらは秘密情報なので、**リポジトリにも、チャットにも、スクリーンショットにも残さない。**
> パスワードマネージャのセキュアメモに置くのが望ましい。

---

## Step 1. Discord のチャンネルを2つ用意する

1. Discord サーバに `#heartbeat-ops`（運用者用）チャンネルを作る
2. 一次受信者が普段見ているサーバに `#安否通知` などの名前でチャンネルを作り、一次受信者を招待する
   - 運用者用と**別のチャンネル**にすること。宛先の取り違えは誤爆時の実害に直結する
3. それぞれで「チャンネルを編集 → 連携サービス → ウェブフック → 新しいウェブフック」を作り、URL を控える
   - 以降 `WEBHOOK_OPERATOR` / `WEBHOOK_PRIMARY` と呼ぶ
4. **一次受信者の端末で、そのチャンネルの通知設定を「すべてのメッセージ」にしてもらう**
   - アダプタはメンションを無効化して送る（外部由来の文字列を転送するため）。到達性はチャンネルの通知設定で担保する

## Step 2. healthchecks.io にチェックを3本作る

「Add Check」で以下の3本を作る。Schedule は Simple（Period / Grace）でよい。

| Name | Period | Grace |
|---|---|---|
| `alive-48` | 48 hours | 1 hour |
| `alive-60` | 60 hours | 1 hour |
| `alive-72` | 72 hours | 1 hour |

- **Name は正確にこの文字列にする。** 通知アダプタの対応表がこの名前をキーにしている
- 各チェックの ping URL（`https://hc-ping.com/<UUID>`）を控える
- 「Auto-resume（停止中でも ping を受けたら再開）」に相当する設定があれば有効にしておく。一時停止のまま放置されることが不発の原因になる

## Step 3. 48h / 60h の通知先を割り当てる

「Integrations」で通知先を作り、各チェックに割り当てる。

| チェック | 通知先 | 種別 |
|---|---|---|
| `alive-48` | 運用者の Discord（`#heartbeat-ops`） | Discord Integration |
| `alive-60` | 運用者のメールアドレス | Email |
| `alive-72` | 後述の Webhook | Webhook |

**48h と 60h を必ず別種にする。** 無音の原因が端末故障だった場合、同じ端末へのプッシュを
2回送っても届かない。60h 側は PC からでも受け取れる経路にする。

各チェックには**そのチェック用の通知先だけ**を割り当てる。3本すべてに全部の通知先を
割り当てると、48h の時点で一次受信者に飛んでしまう。

## Step 4. 通知アダプタをデプロイする

```bash
cd worker
npm install
npm test                    # 先にテストが通ることを確認する
npx wrangler login
npx wrangler deploy
```

デプロイ後、シークレットを投入する（値はリポジトリに書かない）。

```bash
# 共有シークレット。ランダムな長い文字列を生成して使う
openssl rand -base64 32     # 出力を控えて、次のコマンドで貼り付ける
npx wrangler secret put HOOK_SECRET

npx wrangler secret put DISCORD_WEBHOOK_PRIMARY     # Step 1 の WEBHOOK_PRIMARY
npx wrangler secret put DISCORD_WEBHOOK_OPERATOR    # Step 1 の WEBHOOK_OPERATOR
```

通知文面に出す呼称を変えたい場合は `worker/wrangler.toml` の `OPERATOR_NAME` を編集して
再デプロイする（例: `"山田"`、`"この端末の持ち主"`）。ここは公開される可能性のある設定なので、
フルネームを入れる必要はない。

デプロイされた URL（`https://human-heartbeat-notifier.<サブドメイン>.workers.dev`）を控える。

疎通確認:

```bash
# 401 が返れば、経路とシークレット検証が生きている
curl -i -X POST https://<デプロイ先>/hook \
  -H 'content-type: application/json' \
  -d '{"event":"alive-72","status":"down"}'
```

## Step 5. healthchecks.io の Webhook を設定する

`alive-72` に割り当てる Webhook Integration を作る。

| 項目 | 値 |
|---|---|
| Method | `POST` |
| URL | `https://<デプロイ先>/hook` |
| Request header | `X-Deadman-Secret: <Step 4 の HOOK_SECRET>` |
| Content type | `application/json` |
| Request body | 下記 |

```json
{"event": "$NAME", "status": "$STATUS", "check_id": "$CODE", "occurred_at": "$NOW"}
```

> **プレースホルダ名は管理画面の表示を正とする。** healthchecks.io の Webhook 設定画面には
> 利用可能な変数の一覧が表示されるので、`$NAME` `$STATUS` の綴りが違っていたらそちらに合わせる。
> アダプタ側は `event` が見つからなければ `name` / `check` / `check_name` も見るようにしてあるが、
> **`status` が空だと未知イベント扱いになり、一次受信者ではなく運用者へ転送される。**
> 発火経路が生きているかどうかは Step 7-③ の実弾テストでしか確認できない。

healthchecks 側に「復帰時にも通知する（up）」の設定があれば有効にする。誤爆を取り消したとき、
一次受信者に「先の通知は誤報だった」と届く。

## Step 6. Tasker を設定する

### プロファイル1: ロック解除の記録（通信しない）

1. Profiles → `+` → Event → Display → **Display Unlocked**
2. 新規タスク `heartbeat-mark` を作り、アクションを1つ追加
   - Variables → **Variable Set**
   - Name: `%LASTSEEN` / To: `%TIMES`
   - ※ `%LASTSEEN` は全て大文字にする。Tasker では大文字の変数がグローバルになる

### プロファイル2: 毎時の送信

1. Profiles → `+` → Time → From `00:00` To `23:59`、Repeat `1 hour`
2. 新規タスク `heartbeat-ping` を作る
3. アクション1: Variables → **Variable Set**
   - Name: `%ELAPSED` / To: `%TIMES - %LASTSEEN` / **Do Maths を有効にする**
4. アクション2〜4: Net → **HTTP Request**（Method: GET、URL に各 ping URL）を3つ
   - `https://hc-ping.com/<alive-48 の UUID>`
   - `https://hc-ping.com/<alive-60 の UUID>`
   - `https://hc-ping.com/<alive-72 の UUID>`
5. **アクション2〜4のそれぞれに If 条件を付ける: `%ELAPSED < 3600`**

```
heartbeat-ping
  A1. Variable Set   %ELAPSED = %TIMES - %LASTSEEN   [Do Maths]
  A2. HTTP Request   GET https://hc-ping.com/<alive-48>    If %ELAPSED < 3600
  A3. HTTP Request   GET https://hc-ping.com/<alive-60>    If %ELAPSED < 3600
  A4. HTTP Request   GET https://hc-ping.com/<alive-72>    If %ELAPSED < 3600
```

> ⚠️ **A2〜A4 の条件式を省いてはいけない。** 条件を付け忘れると、端末が机に放置されていても
> ping が飛び続け、永久に発火しない状態になる。この設計における唯一かつ最大の設定ミス。
> Step 7-② で必ず実測確認する。

### 省電力からの除外

Tasker が OS に殺されると不発になる。以下をすべて実施する。

- 設定 → アプリ → Tasker → バッテリー → **「制限しない」**
- メーカー独自の省電力（Samsung の「スリープ中のアプリ」、Xiaomi の「自動起動」、
  OPPO/vivo の「バックグラウンド保護」など）からも個別に除外する
- Tasker の Monitor 設定で、常駐通知を有効にしておく（OS に殺されにくくなる）

---

## Step 7. 導入時検証（ここまでやって導入完了）

### ① ping が通ることを確認する

端末のロックを解除し、`heartbeat-ping` を Tasker から手動実行する。
healthchecks.io の3本すべてが **UP** になり、Last Ping が更新されること。

### ② 条件式が効いていることを確認する ← 最重要

**これを飛ばすと、仕組み全体が「絶対に発火しない置物」になっていても気づけない。**

1. Tasker の Variables タブで `%LASTSEEN` を手動で古い値に書き換える
   （現在の値から 10000 くらい引いた数値にする）
2. `heartbeat-ping` を手動実行する
3. healthchecks.io の Last Ping が**更新されないこと**を確認する
4. 確認後、ロックを解除して `%LASTSEEN` を現在時刻に戻す（またはアクション1を手動実行）

Last Ping が更新されてしまった場合、A2〜A4 の If 条件が付いていないか、
`%ELAPSED` の計算で Do Maths が有効になっていない。Step 6 に戻る。

### ③ 発火が一次受信者に届くことを確認する（実弾テスト）

1. **事前に一次受信者へ「テストの通知が届く」と伝えておく**
2. `alive-72` の Period を一時的に `5 minutes` / Grace `1 minute` に縮める
3. `heartbeat-ping` を止めて（プロファイル2を無効化）放置する
4. 一次受信者の端末に日本語の通知が届くことを確認する。同時に運用者側にも届くこと
5. ping URL を叩いて復旧させ、「解除」の通知が届くことを確認する
6. **Period / Grace を 72 hours / 1 hour に戻す。プロファイル2を有効に戻す**

> 手順6の戻し忘れが一番危ない。戻したあと healthchecks.io の画面で
> 3本の Period が 48h / 60h / 72h になっていることを目視確認する。

### ④ 未知イベントの転送を確認する（任意）

```bash
curl -i -X POST https://<デプロイ先>/hook \
  -H 'content-type: application/json' \
  -H 'X-Deadman-Secret: <HOOK_SECRET>' \
  -d '{"event":"alive-99","status":"down"}'
```

運用者チャンネルに「対応表に無いイベントを受信しました」が届けば、
設定ミスが沈黙ではなく通知として見えることまで確認できたことになる。

---

## 付録A. ドライラン（導入直後2週間）

閾値の妥当性は実データを見てから決める。導入から2週間は次のようにする。

- `alive-72` の Webhook を**一時的に運用者チャンネル向けに差し替える**
  （`DISCORD_WEBHOOK_PRIMARY` に運用者用の URL を入れておく）
- 毎日 healthchecks.io の各チェックの Last Ping を眺め、**自分の最長無操作時間**を記録する
- 睡眠・出張・入院以外の理由で 24 時間を超える無操作があるかを見る
- 2週間分の分布を見て、48 / 60 / 72 の妥当性を確定する。分布の上端が 30 時間を超えるなら
  閾値を後ろへずらす。ただし「2〜3日以内に届く」という目的から 72h より後ろへは引っ張らない
- 確定したら `DISCORD_WEBHOOK_PRIMARY` を一次受信者用の URL に戻す

## 付録B. 四半期ごとの実弾テスト

**テストしていない通知経路は死んでいるものとみなす。** 3ヶ月に1回、Step 7-③ を丸ごと再実行する。
カレンダーに繰り返し予定として登録しておく。

チェック項目:

- [ ] 一次受信者の端末に、実際に通知が届いた（本人に口頭で確認する）
- [ ] 文面が日本語として読める。専門用語で意味が取れなくなっていない
- [ ] 運用者側の 48h / 60h の通知も届く（メールが迷惑メールフォルダへ行っていないか）
- [ ] ping URL を叩いて解除でき、解除通知も届いた
- [ ] テスト後、Period / Grace とプロファイル2の有効化を元に戻した

## 付録C. 年1回のインフラ棚卸し

課金が止まるとサービスごと止まり、不発に直結する。

- [ ] healthchecks.io のアカウントが生きている。月次サマリーメールが届いている
- [ ] Cloudflare アカウントの支払い方法（カードの有効期限）が生きている
- [ ] Discord Webhook が失効していない（チャンネル削除・サーバ移行で失効する）
- [ ] Tasker が省電力の対象外のまま維持されている（OS アップデートで戻ることがある）
- [ ] 端末を機種変更した場合、Tasker のプロファイル2つが移行できている
- [ ] 一次受信者が変わっていない。連絡先が生きている

## 付録D. 端末を機種変更したとき

1. 新端末に Tasker を入れ、プロファイル2つを再作成（または Tasker のバックアップから復元）
2. 省電力からの除外を再設定する
3. **Step 7-① と ② をもう一度実行する**（②を省かないこと）
4. 旧端末の Tasker プロファイルは無効化する。放置された旧端末が ping を送り続けると、
   運用者が動いていなくてもチェックが UP のままになり、不発になる
