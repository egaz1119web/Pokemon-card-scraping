/**
 * 公式のデッキ ID を PokeDeck の共有 URL に直す。
 *
 * 大会の入賞デッキを SNS に出すための道具。`public/events.json` には
 * 大会ごとの 1〜8 位のデッキ ID が入っているので、そこから 1 本選んで
 * この道具に渡せば、そのまま貼れるリンクになる。
 *
 *     npm run deck-url -- FFdFbb-eWiT5V-fkFkbv
 *     npm run deck-url -- <ID> --name "ドラパルトex（CL優勝）"
 *
 * **公式のデッキ ID とは別物を作っている。** 公式の ID は公式サイトでしか
 * 開けず、中身を見るのに公式のデッキ構築ツールへ行くことになる。こちらは
 * リンク自体に 60 枚を持っていて、アプリを入れていない人にもその場で見え、
 * 入れている人はそのまま取り込める。SNS に出すならこちらでないと意味がない。
 */

import { readFileSync } from "node:fs";
import { encode, ENERGY_NAMES } from "../public/d/share-code.js";
import { fetchText, ORIGIN } from "./http.js";

const SHARE_BASE = "https://pokedeck.op-sarada.workers.dev/d/?c=";

/**
 * 公式のデッキ頁が持っている入れ物。**この順がそのまま並び順になる。**
 *
 * アプリのデッキ表示（ポケモン → グッズ → どうぐ → サポート → スタジアム →
 * エネルギー）と同じ並びなので、公式の順のまま詰めれば送り手の画面と揃う。
 * v2 の共有コードは並べ替えずに順を保つ形なので、ここで整えてはいけない。
 *
 * `deck_tech`（テクニカルマシン）はグッズの一種なのでグッズの後ろに置く。
 * `deck_ajs` は手元で中身の入った例を見たことがない。落とすと 60 枚に足りなく
 * なるので、入っていたら黙って捨てずに知らせる。
 */
const DECK_FIELDS = [
  "deck_pke",
  "deck_gds",
  "deck_tech",
  "deck_tool",
  "deck_sup",
  "deck_sta",
  "deck_ene",
  "deck_ajs",
] as const;

/** 基本エネルギーの名前 → 共有コードのエネルギー綴り。 */
const ENERGY_BY_NAME: Record<string, string> = {
  基本草エネルギー: "reef",
  基本炎エネルギー: "fire",
  基本水エネルギー: "water",
  基本雷エネルギー: "thunder",
  基本超エネルギー: "esper",
  基本闘エネルギー: "fight",
  基本悪エネルギー: "dark",
  基本鋼エネルギー: "metal",
  基本フェアリーエネルギー: "fairy",
  基本ドラゴンエネルギー: "dragon",
};

type IndexEntry = [name: string, image: string, kind: string];
type CardIndex = Record<string, IndexEntry | undefined>;

function loadIndex(): CardIndex {
  const standard = JSON.parse(readFileSync("public/cards-min.json", "utf8")) as CardIndex;
  const extra = JSON.parse(readFileSync("public/cards-min-extra.json", "utf8")) as CardIndex;
  return { ...extra, ...standard };
}

type EventDeck = { title: string; date: string; rank: string; image: string };

/**
 * デッキ ID → その大会での順位と代表カード。
 *
 * 代表カードは公式が大会結果の一覧に出しているもの。これを主軸として扱えば、
 * 貼ったときに出る絵が公式の見せ方と揃う。
 */
function loadEventDecks(): Map<string, EventDeck> {
  const RANKS = [
    ["first", "1位"],
    ["second", "2位"],
    ["third", "3位"],
    ["fourth", "4位"],
    ["fifth", "5位"],
    ["sixth", "6位"],
    ["seventh", "7位"],
    ["eighth", "8位"],
  ] as const;
  const events = JSON.parse(readFileSync("public/events.json", "utf8")) as Record<string, string>[];
  const map = new Map<string, EventDeck>();
  for (const event of events) {
    for (const [key, rank] of RANKS) {
      const deckId = event[key];
      if (!deckId) continue;
      map.set(deckId, {
        title: event["title"] ?? "",
        date: event["date"] ?? "",
        rank,
        image: event[`${key}Image`] ?? "",
      });
    }
  }
  return map;
}

/** 貼り付けた URL でも素の ID でも受ける。 */
function toDeckId(input: string): string {
  const matched = /deckID\/([A-Za-z0-9-]+)/.exec(input);
  return (matched ? matched[1] : input.trim()) ?? "";
}

export function parseDeckPage(html: string): { cards: { cardId: number; count: number }[]; leftover: string } {
  const values = new Map<string, string>();
  for (const tag of html.match(/<input[^>]*name="deck_[a-z]+"[^>]*>/g) ?? []) {
    const name = /name="(deck_[a-z]+)"/.exec(tag)?.[1];
    const value = /value="([^"]*)"/.exec(tag)?.[1] ?? "";
    if (name) values.set(name, value);
  }

  const cards: { cardId: number; count: number }[] = [];
  for (const field of DECK_FIELDS) {
    for (const part of (values.get(field) ?? "").split("-").filter(Boolean)) {
      // 「カードID_枚数_なにか」。3 つ目は用途が分からないので触らない。
      const [id, count] = part.split("_");
      const cardId = Number(id);
      const n = Number(count);
      if (!Number.isInteger(cardId) || cardId <= 0 || !Number.isInteger(n) || n <= 0) {
        throw new Error(`読めない並び: ${field}=${part}`);
      }
      cards.push({ cardId, count: n });
    }
  }
  return { cards, leftover: values.get("deck_ajs") ?? "" };
}

/** 一番多く入っている基本エネルギーの色。基本が 1 枚も無ければ null。 */
function pickEnergy(cards: { cardId: number; count: number }[], index: CardIndex): string | null {
  const tally = new Map<string, number>();
  for (const card of cards) {
    const name = index[String(card.cardId)]?.[0];
    const energy = name ? ENERGY_BY_NAME[name] : undefined;
    if (energy) tally.set(energy, (tally.get(energy) ?? 0) + card.count);
  }
  let best: string | null = null;
  let most = 0;
  for (const [energy, count] of tally) {
    if (count > most) {
      best = energy;
      most = count;
    }
  }
  return best;
}

/** 代表カードの画像の道筋から cardId を引く。大会結果の絵と主軸を揃えるため。 */
function cardIdOfImage(image: string, cards: { cardId: number }[], index: CardIndex): number | null {
  if (!image) return null;
  const tail = image.replace(/^.*\/card_images\/large\//, "");
  for (const card of cards) {
    if (index[String(card.cardId)]?.[1] === tail) return card.cardId;
  }
  return null;
}

async function build(
  deckId: string,
  index: CardIndex,
  events: Map<string, EventDeck>,
  override: { name?: string; main?: number },
) {
  const html = await fetchText(`${ORIGIN}/deck/confirm.html/deckID/${deckId}`);
  const { cards, leftover } = parseDeckPage(html);
  if (cards.length === 0) throw new Error(`デッキが空か、ID が違う: ${deckId}`);

  const event = events.get(deckId);
  const main =
    override.main ??
    cardIdOfImage(event?.image ?? "", cards, index) ??
    // 大会結果に無いデッキは代表カードが分からない。先頭のポケモンで代える。
    cards.find((c) => index[String(c.cardId)]?.[2] === "ポケモン")?.cardId ??
    cards[0]?.cardId ??
    null;

  const name = override.name ?? (main ? (index[String(main)]?.[0] ?? "") : "") ?? "";
  const code = encode({
    name,
    cards,
    energyName: pickEnergy(cards, index),
    mainCardId: main,
    subCardId: null,
  });

  const total = cards.reduce((sum, c) => sum + c.count, 0);
  const missing = cards.filter((c) => !index[String(c.cardId)]).map((c) => c.cardId);
  return { deckId, code, url: SHARE_BASE + code, name, total, kinds: cards.length, missing, leftover, event };
}

async function main() {
  const args = process.argv.slice(2);
  const ids: string[] = [];
  const override: { name?: string; main?: number } = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--name") override.name = args[++i];
    else if (arg === "--main") override.main = Number(args[++i]);
    else if (arg.startsWith("--")) throw new Error(`知らない指定: ${arg}`);
    else ids.push(toDeckId(arg));
  }
  if (ids.length === 0) {
    console.error("使い方: npm run deck-url -- <デッキID または公式URL> [--name 名前] [--main カードID]");
    process.exitCode = 1;
    return;
  }
  if (ids.length > 1 && (override.name || override.main)) {
    throw new Error("--name と --main はデッキ 1 本のときだけ使える");
  }

  const index = loadIndex();
  const events = loadEventDecks();

  for (const id of ids) {
    const deck = await build(id, index, events, override);
    if (deck.event) console.log(`${deck.event.date} ${deck.event.rank} ${deck.event.title}`);
    console.log(`${deck.name}  ${deck.total} 枚 ・ ${deck.kinds} 種類`);
    // 60 枚でないデッキは公式にも存在しうる（未完成のまま公開されたもの）。
    // 止める理由は無いが、そのまま貼ると恥ずかしいので知らせる。
    if (deck.total !== 60) console.log(`  ⚠ 60 枚ではない`);
    // 索引に無いカードは、ページで灰色の枠になる。貼る前に気づきたい。
    if (deck.missing.length) console.log(`  ⚠ 索引に無いカード: ${deck.missing.join(", ")}`);
    if (deck.leftover) console.log(`  ⚠ deck_ajs に中身がある（落としている）: ${deck.leftover}`);
    console.log(deck.url);
    console.log(`  ${deck.url.length} 字`);
    console.log("");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
