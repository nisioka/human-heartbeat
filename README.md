# human-heartbeat

日常の端末操作を生存シグナルとして扱い、無音が続いたときに家族へ通知を届けるデッドマンスイッチ。

> **English**: A dead man's switch built from off-the-shelf parts. Phone screen unlocks act as a
> liveness signal; [healthchecks.io](https://healthchecks.io/) watches for silence and escalates at
> 48h / 60h / 72h. The only custom code is one Tasker task and a small stateless Cloudflare Worker
> that formats the 72h alert and posts it to Discord. Documentation is in Japanese.

## 何のためのものか

事故や急病で意識不明になった場合に、**2〜3日以内**に必要な情報が家族へ届くようにする。
「毎日ボタンを押す」ような明示的なチェックイン操作は続かないため、**画面ロック解除**という
普段の行動をそのまま生存シグナルとして使う。

設計上の背骨は一つだけ。

> **不発は許容しない。誤爆は許容する。**

誤爆のコストは「無用な通知が1回飛ぶ」だけだが、不発のコストは仕組みの存在意義そのもの。
判断に迷う箇所はすべてこの非対称性で倒している。閾値を保守的にして誤爆を減らすのではなく、
**リセットを簡単にして誤爆を無害化する**方向で作ってある。

## 仕組み

```
[Android / Tasker]
      |  ロック解除イベント → %LASTSEEN を更新（通信なし）
      |  毎時 → 直近1時間以内に解除があれば ping
      v
[healthchecks.io]  ... 無音検知・状態管理・エスカレーション
      |
      +-- alive-48 --> 運用者（Discord）
      +-- alive-60 --> 運用者（メール）
      +-- alive-72 --> Webhook --> [通知アダプタ] --> Discord（一次受信者 + 運用者）
```

自作するのは **Tasker のタスク1個と通知アダプタ1個だけ**。無音判定・タイマー・リセット処理は
healthchecks.io に任せる。ping が1回届けば3本のチェックが同時に復帰するため、
誤爆の取り消しは「任意の端末で URL を1つ開く」だけで済む。

## ドキュメント

| ファイル | 内容 |
|---|---|
| [`docs/design.md`](docs/design.md) | 要件・設計方針。何を採用し、何を捨てたか |
| [`docs/setup.md`](docs/setup.md) | 構築手順。導入時検証と定期テストまで |
| [`worker/`](worker/) | 通知アダプタ（Cloudflare Workers） |

## 通知アダプタ

healthchecks.io の Webhook を受けて Discord へ流すだけの、状態を持たないエンドポイント。

```bash
cd worker
npm install
npm test
npx wrangler deploy
```

シークレット（共有シークレット・Discord Webhook URL）は `wrangler secret put` で投入する。
**リポジトリには一切含まれていないし、含めてはいけない。**

設計上、アダプタは次のように振る舞う。いずれも「不発を許容しない」から直接出てくる。

- **未知のイベントを捨てない。** 対応表に無いイベントは運用者へ生のペイロードごと転送する。
  設定ミスやサービス側の仕様変更を、沈黙ではなく通知として観測できるようにするため
- **受け口を緩くする。** ペイロードのキー名が食い違っていても拾えるだけ拾う
- **72h の発火は一次受信者と運用者の両方へ送る。** 運用者が無事なら誤爆に即座に気づける
- **配信に失敗したらフォールバック先へ通知し、エラーを返す。** 失敗が記録として残る

発火時のアクションを差し替えるときの変更範囲は [`worker/src/routes.ts`](worker/src/routes.ts)
の対応表だけに閉じている。

## 現在の状態

ハートビートの仕組みを確立するところまで。以下は次フェーズ。

- 二次受信者（一次受信者が同時に被災するケースへの備え）
- 発火時に配信する内容の具体化
- 保管場所とアクセス手段の受け渡し方法

## 注意

- これは**緊急通報（119番等）の代替ではない**。医学的な意味での生存確認でもない
- 資産や契約の自動処理は対象外。法的に無効になり得るため、情報の引き渡しに限定している
- **導入しただけでは動作を保証しない。** `docs/setup.md` の導入時検証と、
  四半期ごとの実弾テストまでを含めて仕組みとして成立する

## ライセンス

MIT License. [`LICENSE`](LICENSE) を参照。
