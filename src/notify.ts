/**
 * カードプールが増えたときだけ、アプリへ通知を送る。
 *
 * **「版が上がったら送る」にしないこと。**
 * version はカードの文言を 1 文字直しただけでも上がる。それで毎回通知すると
 * 真っ先に切られる。ここが見るのは「カードが増えたかどうか」だけ。
 *
 * **送る前に、増えたカードの絵を先に R2 へ置く。**
 * 通知は全員に同時に届き、昼のモバイル通信で一斉に同じ一覧を開かれる。
 * そこで自前に絵が無いと、公式の 321KB を人数分ぶん引くことになる。
 * 「見に来て」と言った直後にいちばん重い状態を見せる理由がない。
 *
 * **一括の取り込み（mirror-images）に任せてはいけない。**
 * あちらはパスの並び順に進む。並びは弾の記号のアルファベット順で、新しい弾が
 * 最後に来るとは限らない。積み残しがあるうちは新カードまで永久に届かないので、
 * ここで名指しで取る（mirrorPaths）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { sendToTopic } from "./fcm.js";
import { mirrorPaths, describe } from "./images.js";
import { listKeys, r2ConfigFromEnv } from "./r2.js";
import { keyFor } from "./images.js";

/** 前回知らせた時点の「弾ごとの枚数」。差分の基準になる。 */
const NOTIFIED = "data/notified.json";

/** スタンダードだけを見る。理由は下の loadCards を参照。 */
const CARDS = "public/cards.json";

/** 1 にすると、差分と文面を表示するだけで送信も控えの更新もしない。 */
const DRY_RUN = process.env.DRY_RUN === "1";

/**
 * 指定すると、トピックではなく**その端末 1 台だけ**へ送る。
 *
 * 本番と同じ経路（JWT → access token → FCM → 端末）をそのまま通したまま、
 * 届く先だけを自分の端末に絞れる。送信部の確認はこれでやる。
 *
 * この指定があるときは、増えたカードが無くても**見本の 1 通**を作って送る
 * （何も送らないと経路の確認にならない）。控え（notified.json）も更新しない。
 */
const TEST_TOKEN = process.env.FCM_TEST_TOKEN?.trim() || undefined;

/**
 * 「確認用に送るつもりだった」ことを表す印。
 *
 * **これが無いと事故になる。** 確認用のつもりで回したのに FCM_TEST_TOKEN が
 * 空だと、宛先が既定のトピックへ落ちて**全員に飛ぶ**。取り消せない。
 * つもりと実際が食い違ったら、送らずに止める。
 */
const TEST_ONLY = process.env.NOTIFY_TEST_ONLY === "1";

/** 名前を出す弾の数。これを超えたぶんは「ほか N弾」にまとめる。 */
const NAMED_PACKS = 1;

interface Card {
  cardId: string;
  pack: string;
  imageUrl: string;
  rare?: string;
}

interface Notified {
  packs: Record<string, number>;
}

/** 確認用のときに取り込みを飛ばすための印。 */
class SkipMirror extends Error {}

/**
 * レア度アイコンのファイル名 → 表示名。
 *
 * 公式は `rare` を `/assets/images/card/rarity/ic_rare_sar.gif` の形で返す。
 * ここに無い記号は表示しないだけで、判定からも外れる。
 */
const RARITY_LABEL: Record<string, string> = {
  MUR: "MUR",
  hr: "HR",
  ur_c: "UR",
  ssr: "SSR",
  sar: "SAR",
  sr_c: "SR",
  ar: "AR",
};

/**
 * 見出しを変える判断に使う「高レア」。
 *
 * ポケモンカードは、新しい弾の収録カードが載ってから 1〜2 週間後に
 * 高レアリティのカードが同じ弾へ追加される。**弾の名前だけを出すと、
 * 同じような通知が 2 回届く。** 増えたカードに高レアが含まれるかどうかで
 * 見出しを変えれば、2 回目は別物として読める。
 * 実データでも、ストームエメラルダは高レア 0 枚（第 1 波）、
 * アビスアイ・ニンジャスピナー・ムニキスゼロは AR12 SR18 SAR6 MUR1 で揃っている。
 */
const HIGH_RARITY = new Set(Object.keys(RARITY_LABEL));

/** 表示の並び。珍しいものから先に出す。 */
const RARITY_ORDER = Object.keys(RARITY_LABEL);

function rarityOf(card: Card): string | null {
  const m = /ic_rare_([^.]+)\.gif/.exec(card.rare ?? "");
  return m?.[1] ?? null;
}

/**
 * スタンダードのカードだけを読む。
 *
 * **エクストラ（cards-extra.json）は見ない。** 1 万件超の初回取り込みが
 * 何日もかけて進むので、含めると通知が嵐になる。新しい弾は必ず
 * スタンダードに載るため、こちらだけで用は足りる。
 */
function loadCards(): Card[] {
  return JSON.parse(readFileSync(CARDS, "utf8")) as Card[];
}

function loadNotified(): Notified {
  if (!existsSync(NOTIFIED)) return { packs: {} };
  return JSON.parse(readFileSync(NOTIFIED, "utf8")) as Notified;
}

const newestId = (cards: Card[]): number => Math.max(...cards.map((c) => Number(c.cardId)));

function countByPack(cards: Card[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of cards) out[c.pack] = (out[c.pack] ?? 0) + 1;
  return out;
}

export interface Diff {
  /** 増えたカード。 */
  cards: Card[];
  /** 増えた弾を、増えた枚数の多い順に並べたもの。 */
  packs: { pack: string; added: number }[];
}

/**
 * 前回知らせた時点との差を出す。
 *
 * 弾ごとの枚数しか控えていないので、「どのカードが増えたか」は
 * 増えた弾の中から cardId の大きい順に必要数だけ拾って代用する。
 * **カード ID をすべて控える手もあるが、2 万件ぶんの控えを毎日コミットすることになる。**
 * 通知に要るのは「どの弾が何枚増えたか」と、その弾の新しいほうのカードだけなので、
 * 枚数の控えで足りる。
 */
export function diff(cards: Card[], notified: Notified): Diff {
  const now = countByPack(cards);
  const packs: { pack: string; added: number }[] = [];
  for (const [pack, count] of Object.entries(now)) {
    const before = notified.packs[pack] ?? 0;
    if (count > before) packs.push({ pack, added: count - before });
  }
  packs.sort((a, b) => b.added - a.added);

  const added: Card[] = [];
  for (const { pack, added: n } of packs) {
    const inPack = cards
      .filter((c) => c.pack === pack)
      .sort((a, b) => Number(b.cardId) - Number(a.cardId));
    added.push(...inPack.slice(0, n));
  }
  return { cards: added, packs };
}

export function compose(d: Diff): { title: string; body: string; pack: string } {
  const total = d.packs.reduce((n, p) => n + p.added, 0);
  const rarities = [...new Set(d.cards.map(rarityOf).filter((r): r is string => r !== null))]
    .filter((r) => HIGH_RARITY.has(r))
    .sort((a, b) => RARITY_ORDER.indexOf(a) - RARITY_ORDER.indexOf(b));

  const named = d.packs.slice(0, NAMED_PACKS);
  const rest = d.packs.slice(NAMED_PACKS);

  // 会場ごとのプロモのように小さい弾がいくつも動く日があるので、
  // 名前を出すのは先頭だけにして、残りは「ほか N弾」にまとめる。
  let body = named.map((p) => p.pack).join("・");
  if (rarities.length > 0) {
    body += ` ${rarities.slice(0, 3).map((r) => RARITY_LABEL[r]).join("・")} など`;
  }
  // 弾が 1 つなら「73枚」でよいが、複数のときは先頭の弾の枚数と読めてしまう。
  // 合計であることが分かる形にする。
  body += rest.length > 0 ? ` ほか ${rest.length}弾 計${total}枚` : ` ${total}枚`;

  return {
    // 第 1 波と第 2 波で見出しを変える。同じ弾でも別の知らせとして読める。
    title: rarities.length > 0 ? "高レアリティのカードが追加されました" : "新しいカードが追加されました",
    body,
    pack: d.packs[0]?.pack ?? "",
  };
}

async function main(): Promise<void> {
  if (TEST_ONLY && !TEST_TOKEN) {
    throw new Error(
      "確認用（自分の端末だけ）を指定されたが FCM_TEST_TOKEN が空。" +
        "このまま進めるとトピックへ流れて全員に届くので中断する。" +
        "Secrets に FCM_TEST_TOKEN を入れること。",
    );
  }
  const cards = loadCards();

  // **初回は控えが無いので、全部が「増えた」に見える。**
  // そのまま走らせると 2 万枚の通知を送り、2 万枚を取り込みにいく。
  // 最初の 1 回は今の状態を控えるだけにして、次の実行から差を見る。
  if (!existsSync(NOTIFIED)) {
    writeFileSync(NOTIFIED, `${JSON.stringify({ packs: countByPack(cards) }, null, 2)}\n`);
    console.log(`${NOTIFIED} が無かったので、今の状態を控えた。通知はしない。`);
    return;
  }

  const notified = loadNotified();
  let d = diff(cards, notified);

  if (d.packs.length === 0) {
    if (!TEST_TOKEN) {
      console.log("増えたカードは無い。通知しない。");
      return;
    }
    // 端末 1 台への確認用。実際の通知に近い見本を 1 通作る。
    //
    // いちばん新しいカードの弾をそのまま使うと、3 枚のプロモが選ばれて
    // 本番の見え方と違ってしまう。**10 枚以上ある弾のうち最新**を選ぶ。
    console.log("増えたカードは無いが、確認用なので見本を作る。");
    const byPack = new Map<string, Card[]>();
    for (const c of cards) byPack.set(c.pack, [...(byPack.get(c.pack) ?? []), c]);
    const sample = [...byPack.entries()]
      .filter(([, xs]) => xs.length >= 10)
      .sort((a, b) => newestId(b[1]) - newestId(a[1]))[0] ?? [...byPack.entries()][0];
    if (!sample) return;
    d = { cards: sample[1], packs: [{ pack: sample[0], added: sample[1].length }] };
  }

  const total = d.packs.reduce((n, p) => n + p.added, 0);
  console.log(`増えた ${total} 枚 / ${d.packs.length} 弾`);
  for (const p of d.packs.slice(0, 8)) console.log(`  +${p.added} ${p.pack}`);

  const push = compose(d);

  // 通知より先に、増えたカードの絵を自前の配信へ置く。
  // 確認用（端末 1 台）のときは、送信部を試すのが目的なので省く。
  // ここが失敗しても通知は止めない（公式へのフォールバックが効くので、
  // 「通知が来ない」より「少し重い」ほうがまし）。
  try {
    if (TEST_TOKEN) throw new SkipMirror();
    const cfg = r2ConfigFromEnv();
    const existing = await listKeys(cfg);
    const missing = d.cards
      .map((c) => c.imageUrl)
      .filter((p) => p?.startsWith("/assets/") && !existing.has(keyFor(p)));
    if (missing.length > 0) {
      console.log(`通知の前に ${missing.length} 枚を取り込む…`);
      if (DRY_RUN) console.log("（下書きなので取り込みも省く）");
      else console.log(describe(await mirrorPaths(cfg, missing)));
    } else {
      console.log("増えたカードの絵はすべて揃っている。");
    }
  } catch (err) {
    if (err instanceof SkipMirror) {
      console.log("確認用なので取り込みは省く。");
    } else {
      console.error(`絵の取り込みに失敗したが通知は続ける: ${err instanceof Error ? err.message : err}`);
    }
  }

  await sendToTopic(
    { title: push.title, body: push.body, ...(push.pack ? { data: { pack: push.pack } } : {}) },
    { dryRun: DRY_RUN, token: TEST_TOKEN },
  );

  if (DRY_RUN) {
    console.log(`（下書きなので ${NOTIFIED} は更新しない）`);
    return;
  }
  if (TEST_TOKEN) {
    // **控えを進めないこと。** 進めると、本番の 15:00 の回が
    // 「もう知らせた」と判断して、みんなへの通知が飛ばなくなる。
    console.log(`（確認用なので ${NOTIFIED} は更新しない）`);
    return;
  }
  writeFileSync(NOTIFIED, `${JSON.stringify({ packs: countByPack(cards) }, null, 2)}\n`);
  console.log(`${NOTIFIED} を更新した。`);
}

// diff / compose は試験から読めるようにしてある。
// 読み込んだだけで通知が飛ばないよう、直接実行されたときだけ走らせる。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
