/**
 * カードの絵を公式から取り、縮めて R2 に置く。
 *
 * **なぜ要るか。**
 * 公式の絵は 868x1212 で 1 枚 321KB（平均）ある。一方アプリが実際に出すのは
 * 大きいところでも 520〜756px で、端末側で縮めてから描いている。
 * つまり回線には使わない画素まで流れていて、デッキを 1 つ開くだけで 7〜10MB になる。
 * 外出先で遅いのはこれが理由。540w の webp にすると 1 枚 77KB、4.2 倍軽くなる。
 *
 * **なぜ 540 か。**
 * iOS が自分で指定している最大が 520（LocalDeckView の CardThumb）。
 * Android は RankingDeckScreen が画面幅の 0.7 でカードを出し、Coil に
 * 明示の size を渡していないのでレイアウト実寸（1080p 端末で 756px）を要求する。
 * つまり 540 でもすでに引き伸ばしで、これ以上落とすとルビが潰れる。
 * 容量は 2 万枚でも 1.6GB で、R2 の無料枠 10GB の 16% にしかならない。
 * 削って得るものが無いので、実用上いちばん大きいところに合わせてある。
 *
 * **なぜ webp で avif ではないか。**
 * avif なら同じ見た目で半分になるが、復号は Android 12（API 31）から。
 * このアプリの minSdk は 28 なので、9〜11 の端末で絵が出なくなる。
 *
 * 拡大表示だけは公式の原本をそのまま使う（1 度に 1 枚しか出ないので 321KB でも困らない）。
 * だからここで作るのは 1 サイズだけでよい。
 */
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { BlockedError, ORIGIN, fetchBinary, sleep } from "./http.js";
import { listKeys, putObject, r2ConfigFromEnv } from "./r2.js";

/** 配信する幅。上の「なぜ 540 か」を読んでから変えること。 */
const WIDTH = 540;
const QUALITY = 80;

/** 1 回の実行で取りに行く上限。既定はジョブの上限（330 分）に収まる量。 */
const MAX_IMAGES = Number(process.env.MAX_IMAGES ?? 2000);
/** 公式サイトへの間隔。build.ts と同じ 1 秒。 */
const DELAY_MS = Number(process.env.DELAY_MS ?? 1000);
/** 1 にすると、R2 に既にあるものも取り直して置き直す。 */
const REFRESH = process.env.REFRESH === "1";

/**
 * 1 年。カードの絵は同じ URL で中身が変わらない前提。
 *
 * 万一公式が同じパスの絵を差し替えたときは、ここが効いて古いままになる。
 * そのときは R2 の該当オブジェクトを消すか、REFRESH=1 で置き直すこと。
 * 「絵が変わるかもしれない」を理由に短くすると、毎日 2 万件の再検証が
 * 端末から飛ぶことになり、軽くするためにやっている作業と相殺する。
 */
const CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * 公式の相対パスから R2 の鍵にする。
 *
 * **公式のパスをそのまま鍵にしているのは意図的。**
 * 弾の記号だけを切り出す（MEM/xxx.webp）ほうが短いが、そうするとアプリ側に
 * 「前を削って組み立て直す」処理が要る。パスを保てば、アプリは配信元を
 * 差し替えて拡張子を webp にするだけで済み、公式への取りこぼし用の
 * フォールバックとも同じ文字列で扱える。鍵の長さに料金は掛からない。
 *
 * /assets/images/card_images/large/MEM/050452_P_SHIEIMI.jpg
 *   → assets/images/card_images/large/MEM/050452_P_SHIEIMI.webp
 *
 * **スラッシュの重なりを潰しているのは実データのため。**
 * 公式の一覧が返す cardThumbFile には弾の記号が空のものが 80 件あり、
 * /assets/images/card_images/large//036903_P_MYUU.jpg のようになっている。
 * 公式の Apache は重なりを畳んで返すので今は絵が出ているが、鍵に // を
 * そのまま持たせると、経路のどこかで畳まれた瞬間に 404 になる。
 * ここで潰し、アプリ側も同じ処理を通すこと（両方揃わないと当たらない）。
 */
export function keyFor(imagePath: string): string {
  return imagePath.replace(/\/{2,}/g, "/").replace(/^\//, "").replace(/\.[a-zA-Z0-9]+$/, "") + ".webp";
}

function collectImagePaths(): string[] {
  const paths = new Set<string>();
  for (const file of ["public/cards.json", "public/cards-extra.json"]) {
    if (!existsSync(file)) continue;
    const cards = JSON.parse(readFileSync(file, "utf8")) as { imageUrl?: string }[];
    for (const c of cards) {
      // 公式サイトの相対パスだけを対象にする。ローカル保存の絵や空はここに来ない。
      if (c.imageUrl?.startsWith("/assets/")) paths.add(c.imageUrl);
    }
  }
  return [...paths].sort();
}

async function main(): Promise<void> {
  const cfg = r2ConfigFromEnv();
  const paths = collectImagePaths();
  console.log(`対象のカード画像 ${paths.length} 件`);

  console.log("R2 にあるものを数えている…");
  const existing = REFRESH ? new Set<string>() : await listKeys(cfg);
  console.log(`  R2 に ${existing.size} 件`);

  const todo = paths.filter((p) => !existing.has(keyFor(p)));
  console.log(`  未取得 ${todo.length} 件`);
  if (todo.length === 0) {
    console.log("すべて揃っている。");
    return;
  }

  const batch = todo.slice(0, MAX_IMAGES);
  if (batch.length < todo.length) {
    console.log(`  今回はこのうち ${batch.length} 件（MAX_IMAGES=${MAX_IMAGES}）`);
  }

  let done = 0;
  let failed = 0;
  let bytesIn = 0;
  let bytesOut = 0;
  let blocked = false;

  for (const [i, path] of batch.entries()) {
    if (i > 0) await sleep(DELAY_MS);
    try {
      const { body, contentType } = await fetchBinary(`${ORIGIN}${path}`);
      // ブロック時に HTML のエラーページが 200 で返ることがある。
      // 型を見ずに sharp へ渡すと、そこで初めて落ちて理由が分かりにくい。
      if (!contentType.startsWith("image/")) {
        throw new Error(`画像ではない応答 (${contentType || "型なし"})`);
      }
      const out = await sharp(body).resize({ width: WIDTH }).webp({ quality: QUALITY }).toBuffer();
      const meta = await sharp(out).metadata();
      if (!meta.width || meta.width < WIDTH / 2) {
        throw new Error(`変換結果が不正 (width=${meta.width})`);
      }
      await putObject(cfg, keyFor(path), out, {
        contentType: "image/webp",
        cacheControl: CACHE_CONTROL,
      });
      done++;
      bytesIn += body.length;
      bytesOut += out.length;
      if (done % 100 === 0) {
        console.log(`  ${done}/${batch.length} 件`);
      }
    } catch (err) {
      if (err instanceof BlockedError) {
        // 403 は IP 単位のブロック。続けると状況が悪くなるだけなので即座に手を引く。
        console.error(`アクセスを拒否された。ここで中断する: ${path}`);
        blocked = true;
        break;
      }
      failed++;
      console.error(`  失敗 ${path}: ${err instanceof Error ? err.message : String(err)}`);
      // 個別の失敗は飛ばす。R2 に置かれないので、次回の未取得として自然に拾い直される。
    }
  }

  const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)}MB`;
  console.log(
    `置いた ${done} 件 / 失敗 ${failed} 件` +
      (done > 0 ? ` / ${mb(bytesIn)} → ${mb(bytesOut)}（${(bytesIn / bytesOut).toFixed(1)} 倍軽い）` : ""),
  );

  const remaining = todo.length - done;
  if (remaining > 0) {
    console.log(`残り ${remaining} 件。次の実行で続きから取る。`);
    // EX_TEMPFAIL: 再実行すれば進むことを CI に伝える（build.ts と同じ作法）。
    process.exitCode = 75;
  }
  if (blocked) process.exitCode = 75;
}

// keyFor は他から読める形にしてある（アプリ側と綴りを合わせる必要があるため）。
// 読み込んだだけで取り込みが始まらないよう、直接実行されたときだけ走らせる。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
