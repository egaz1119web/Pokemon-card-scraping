# Pokemon-card-scraping

PokemonCardTools アプリへ配信するカードデータを生成するリポジトリ。

旧構成（GAS → スプレッドシート → Supabase → アプリ）を置き換えるもの。
アプリはカード全件を 1 本の JSON として受け取り、あとはローカルの Room で
検索・絞り込みをしている。つまり DB は不要で、静的ファイル配信で足りる。

```
GitHub Actions (毎日 03:10 JST)
  └ src/build.ts … pokemon-card.com を巡回して data/cards.json を更新
      └ public/{cards.json, version.json} を生成しコミット
          └ Cloudflare Pages が public/ を配信
              └ アプリが取得
```

## データの取得元

| 用途 | エンドポイント | 形式 |
|---|---|---|
| カード一覧 | `/card-search/resultAPI.php` | JSON。認証不要 |
| カード詳細 | `/card-search/details.php/card/{id}/regu/XY` | サーバーサイド HTML |

一覧ページの HTML は Vue で描画されるため素の取得では中身が空になるが、
その Vue が叩いている `resultAPI.php` を直接呼べば JSON が返る。
旧構成が使っていた PhantomJsCloud（有料）もヘッドレスブラウザも要らない。

## 積み上げ式である理由

スタンダード（XY）の検索結果はレギュレーション落ちで減る。
一方でユーザーの保存デッキは落ちたカードも参照している。
そのため一度取り込んだカードは削除せず、`data/cards.json` に積み上げる。

移行時点の内訳:

- 検索結果に出るカード: 5,548 件
- 旧 DB にあって検索結果には出ないカード: 2,991 件（保持する）
- 検索結果にあって旧 DB に無いカード: 708 件（凍結中に増えた分）

`sortId` は毎回振り直す。先頭が「今の検索結果の順（新しい弾が先）」、
そのうしろに検索から落ちたカードを従来の相対順で並べる。

## 出力

- `public/version.json` … `[{"version":48}]`
- `public/cards.json` … カード全件の配列

いずれも旧 Supabase（PostgREST）と同じ配列形式にしてあるので、
アプリ側の `VersionResponse` / `CardDetailResponse` は変更不要。

`data/cards.json` は 1 レコード 1 行で書き出している。
どのカードが増えたか・変わったかが `git diff` でそのまま読める。

## コマンド

```bash
npm ci
npm run build      # 差分更新（新規カードのみ詳細を取得）
npm run validate   # 旧データと突き合わせて移植の正しさを確認
npm run typecheck
```

環境変数:

| 変数 | 既定 | 意味 |
|---|---|---|
| `CONCURRENCY` | 1 | 詳細ページの同時取得数 |
| `DELAY_MS` | 1000 | リクエスト間隔（ミリ秒） |
| `MAX_FETCH` | 1000 | 1 回の実行で取得する上限 |
| `REFRESH_ALL` | - | `1` で全カードを取得し直す |
| `REFRESH_DIRTY` | - | `1` で旧パーサの取りこぼしが残るカードだけ取得し直す |
| `SAMPLE_SIZE` | 150 | validate の標本数 |

## アクセス制限について

公式サイトには WAF が入っており、速く叩きすぎると **IP 単位で 403** を返してくる。
実測では 200ms 間隔・並列 2 で約 1,150 件めにブロックされ、
一覧 API を含むすべてのエンドポイントが数十分にわたって 403 になった。
再試行はブロックを深めるだけなので効果がない。

このため既定値は「逐次・1 秒間隔」にしてある。旧 GAS 版が
`Utilities.sleep(1000)` で長年動いていたのと同じ水準。**上げないこと。**

スクリプト側の対応:

- 403 は再試行せず即座に中断する（`BlockedError`）
- 中断しても取得済みの分は `data/cards.json` に保存する
- `MAX_FETCH` で 1 回の実行量を区切る
- 取り切るまで `version` は上げない。中途半端なデータでアプリの
  全件再ダウンロードを走らせないため、完走した回にまとめて 1 つ上げる
- 中断時の終了コードは 75（`EX_TEMPFAIL`）。CI はこれを失敗扱いにせず、
  取得済みの分をコミットして次回の実行に続きを任せる

全カードを取り直したい場合は `REFRESH_ALL=1` を複数回実行する。
どこまで終わったかは `data/refresh-progress.json` に記録され、自動で再開される。

## 旧 GAS から直した点

移植にあたり、旧データに残っていた不具合を 3 つ修正した。
`npm run validate` はこれらを「既知バグの修正」として通常の差分と分けて数える。

| 内容 | 旧データでの件数 | 原因 |
|---|---|---|
| エネルギーアイコンの `<span>` が本文に残る | 70 件 | `replace` を使っており 1 個目しか置換していなかった |
| 末尾に `\r` が混入 | 441 件 | 改行が CRLF なのに `\n` だけで分割していた |
| `<br />` が本文に残る | 621 件 | 複数行テキストを連結したまま出力していた |

進化ラインの抽出も作り直した。旧版は「空振りが 3 行続いたら終わり」という
行単位の走査で、`</div>` を挟んで並ぶリンクを途中で打ち切っていた
（イーブイは 25 件あるうち 2 件しか取れていなかった）。

## セットアップ

### Cloudflare

Cloudflare のダッシュボードから **Workers & Pages → Create → Connect to Git** で
このリポジトリを接続する。ビルドは不要なので設定はこれだけ:

| 項目 | 値 |
|---|---|
| Build command | 空欄 |
| Deploy command | `npx wrangler deploy`（既定のまま） |

デプロイの内容は `wrangler.jsonc` が持っている。`public/` を静的アセットとして
アップロードするだけで、Worker スクリプト（`main`）は無い。

```jsonc
{
  "name": "pokemon-card-scraping",
  "compatibility_date": "2026-08-24",
  "assets": { "directory": "./public" }
}
```

**`name` はダッシュボードの Worker 名に合わせること。**
Workers Builds ではダッシュボード側の名前が優先されるが、ローカルから
`wrangler deploy` したときに別の Worker を作ってしまうため揃えておく。

配信先: `https://pokemon-card-scraping.op-sarada.workers.dev/`

静的アセットへのリクエストは無料かつ無制限で、帯域の課金も無い。
`public/_headers` のキャッシュ指定もそのまま効く。

> Workers Builds は `npx wrangler deploy` を実行する。`wrangler.jsonc` が
> 無いとエントリポイントを見つけられず
> `error occurred while running deploy command` で落ちる。

### GitHub Actions

Secrets に `DISCORD_WEBHOOK_URL` を登録すると、更新と失敗を通知する（任意）。
それ以外の設定は不要で、`main` への push が Cloudflare のデプロイを兼ねる。

```
Actions (毎日 03:10 JST) → main に commit/push → Cloudflare が自動デプロイ
```
