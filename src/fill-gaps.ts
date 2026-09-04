/**
 * カード検索に出てこないカードを、cardId の穴を突いて拾い直す。
 *
 * 公式のカード検索（resultAPI）は、詳細ページが存在するカードをすべて返すわけではない。
 * たとえば 049573「ポケパッド」（スタートデッキ100 バトルコレクション）は
 * 詳細ページも画像もあるのに、どのレギュレーションで検索しても出てこない。
 * 一方で**公式のデッキコードはそういうカードを平気で指す**。アプリは
 * デッキコードの取り込みで cardId をそのまま持つので、検索由来の
 * cards.json だけでは名前も絵も引けないカードがデッキに入り込む。
 * デッキ共有ページで「カード 49573」という灰色の枠が出るのがこれ。
 *
 * そこで、持っている cardId の並びに空いた番号を順に叩いて確かめる。
 * 存在しない番号は 302 で検索ページへ流されるので、カード画像が
 * 入っていない応答は「無い」と見なして [MISSES] に控え、次回から叩かない。
 *
 * 書き換えるのは data/cards.json だけ。配信ファイルと版の判定は
 * これまでどおり build.ts に任せるので、このあと `npm run build` を回すこと。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseDetail, detailUrl } from "./detail.js";
import { fetchText, sleep, BlockedError } from "./http.js";
import type { CardRecord, ListEntry, State } from "./types.js";
import { normalizeKeyOrder } from "./types.js";

const MASTER = "data/cards.json";
const MASTER_EXTRA = "data/cards-extra.json";
const STATE = "data/state.json";
/** 叩いてみて「カードが無い」と分かった番号。毎回叩き直さないために控える。 */
const MISSES = "data/gap-misses.json";

/**
 * ここから上の穴だけ埋める。
 *
 * 42000 番より下は 1 番から 29,000 件近く空いており、その大半は
 * そもそもカードが存在しない番号。全部叩くと公式サイトに 3 万リクエストを
 * 投げることになるうえ、得られるものはほとんど無い。データが詰まっている
 * のは 43000 番以降で、そこから上の穴は 270 件しかない。
 */
const FROM = Number(process.env.GAP_FROM ?? 43000);
const DELAY_MS = Number(process.env.DELAY_MS ?? 1000);
/** 1 回の実行で叩く上限。WAF に当たらないよう分割して回せるようにしておく。 */
const MAX_FETCH = Number(process.env.MAX_FETCH ?? 500);

function readJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
}

/** build.ts と同じ書き方。1 レコード 1 行にして git diff を読めるようにする。 */
function writeLineDelimitedArray(path: string, rows: CardRecord[]): void {
  const body = rows.map((r) => JSON.stringify(normalizeKeyOrder(r))).join(",\n");
  writeFileSync(path, rows.length === 0 ? "[]\n" : `[\n${body}\n]\n`);
}

const IMAGE = /\/assets\/images\/card_images\/large\/[^"?]+/;
const NAME = /<h1 class="Heading1[^"]*">([^<]*)<\/h1>/;

/**
 * 詳細ページから一覧項目の形を組み立てる。
 *
 * 通常は検索一覧が名前と画像を持ってくるが、ここで扱うカードは
 * その一覧に出てこない。詳細ページ自身から同じ 2 つを取り出す。
 * カード画像が無ければ、その番号にカードは無い。
 */
function entryFromDetail(html: string): ListEntry | null {
  const image = html.match(IMAGE)?.[0];
  if (!image) return null;
  const name = html.match(NAME)?.[1]?.trim() ?? "";
  return {
    cardID: "",
    cardThumbFile: image,
    cardNameAltText: name,
    cardNameViewText: name,
  };
}

async function main(): Promise<void> {
  const master = readJson<CardRecord[]>(MASTER, []);
  const extraMaster = readJson<CardRecord[]>(MASTER_EXTRA, []);
  if (master.length === 0) throw new Error(`${MASTER} が無い。先に npm run build を回すこと。`);

  const held = new Set([...master, ...extraMaster].map((c) => Number(c.cardId)));
  const misses = new Set(readJson<string[]>(MISSES, []));
  const top = Math.max(...held);

  const gaps: number[] = [];
  for (let id = FROM; id <= top; id++) {
    const padded = String(id).padStart(6, "0");
    if (!held.has(id) && !misses.has(padded)) gaps.push(id);
  }
  console.log(`${FROM}〜${top} の穴 ${gaps.length} 件（確認済みで無かった番号 ${misses.size} 件は除く）`);
  if (gaps.length === 0) return;

  const batch = gaps.slice(0, MAX_FETCH);
  if (batch.length < gaps.length) {
    console.log(`  今回はこのうち ${batch.length} 件を叩く（MAX_FETCH=${MAX_FETCH}）`);
  }

  const found: CardRecord[] = [];
  const absent: string[] = [];
  let blocked = false;
  for (const [i, id] of batch.entries()) {
    const padded = String(id).padStart(6, "0");
    try {
      const html = await fetchText(detailUrl(padded));
      const entry = entryFromDetail(html);
      if (entry) {
        // sortId は build.ts の compose() が付け直す。ここでは末尾に寄せておく。
        const card = parseDetail(html, entry, 0);
        found.push(card);
        console.log(`  ${padded} ${card.nameJp}（${card.pack}）`);
      } else {
        absent.push(padded);
      }
    } catch (err) {
      if (err instanceof BlockedError) {
        console.warn(`アクセスを拒否されたため ${i} 件で中断した。取れた分は保存する。`);
        blocked = true;
        break;
      }
      throw err;
    }
    await sleep(DELAY_MS);
  }

  if (absent.length > 0) {
    writeFileSync(MISSES, `${JSON.stringify([...misses, ...absent].sort(), null, 2)}\n`);
    console.log(`カードが無い番号 ${absent.length} 件を ${MISSES} に控えた`);
  }
  if (found.length > 0) {
    let sortId = Math.max(...master.map((c) => c.sortId));
    for (const card of found) card.sortId = ++sortId;
    writeLineDelimitedArray(MASTER, [...master, ...found]);

    // 版を上げる印を立てておく。
    // build.ts は「読み込んだ data/cards.json」と「組み直した結果」を比べて
    // 変化を見る。ここで先に data/cards.json を書いてしまうと、build から見れば
    // 両方とも同じで「更新なし」になり、version が据え置かれてしまう。
    // アプリはその version でしか再取得を判断しないので、足したカードが届かない。
    const state = readJson<State>(STATE, null as unknown as State);
    if (state) {
      state.pendingBump = true;
      writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
    }
    console.log(`${found.length} 件を ${MASTER} に足した。続けて npm run build を回すこと。`);
  } else {
    console.log("足すカードは無かった。");
  }
  const rest = gaps.length - (found.length + absent.length);
  if (rest > 0) {
    console.log(
      blocked
        ? `残り ${rest} 件。しばらく置いてから、もう一度このコマンドを回すこと。`
        : `残り ${rest} 件は次回の実行で続きから叩く。`,
    );
  }
}

await main();
