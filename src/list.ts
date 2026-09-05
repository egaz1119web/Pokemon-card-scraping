import { fetchJson, ORIGIN, sleep } from "./http.js";
import type { ListEntry } from "./types.js";

interface ResultApiResponse {
  result: number;
  errMsg: string;
  thisPage: number;
  maxPage: number;
  hitCnt: number;
  cardList: ListEntry[];
}

/**
 * カード検索の裏 API。Vue アプリが叩いているものと同じで、認証も Cookie も要らない。
 * 旧 GAS 版はレンダリング済み HTML を PhantomJsCloud 経由で取得して
 * 文字列を切り出していたが、その必要はまったくなかった。
 */
function pageUrl(page: number, regulation: string): string {
  const q = new URLSearchParams({
    keyword: "",
    se_ta: "",
    regulation_sidebar_form: regulation,
    pg: "",
    illust: "",
    sm_and_keyword: "true",
    page: String(page),
  });
  return `${ORIGIN}/card-search/resultAPI.php?${q}`;
}

/**
 * サムネイルのファイル名から 6 桁ゼロ埋めのカード ID を取り出す。
 *
 * cardID フィールドをそのまま使わないのは既存データとの互換のため。
 * 基本闘 / 基本悪エネルギーは異なる cardID が同一画像を共有しており、
 * ファイル名由来の ID だと 1 件に統合される。アプリの Room とユーザーの
 * 保存デッキがこの統合済み ID で動いているので、挙動を変えない。
 */
export function cardIdOf(entry: ListEntry): string {
  const file = entry.cardThumbFile.split("/").pop() ?? "";
  return file.split("_")[0] ?? "";
}

/**
 * cardId で重複を落とし、取り込めない項目を捨てる。
 *
 * 落とすものは 2 種類ある。
 *  - 基本闘 / 基本悪エネルギーのように複数 cardID が同じ画像を指すもの（意図した統合）
 *  - 画像がまだ用意されていないカード。サムネイルが noimage を指すので
 *    cardIdOf() が "poke" を返し、そのままだと全部 1 件に潰れて
 *    カード裏面の画像を持つゴミが 1 件できる。エクストラに 5 件ある。
 */
export function uniqueByCardId(entries: ListEntry[]): ListEntry[] {
  const out: ListEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const id = cardIdOf(entry);
    if (!/^\d{6}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(entry);
  }
  return out;
}

export async function fetchAllListEntries(
  regulation = "XY",
  delayMs = 250,
): Promise<ListEntry[]> {
  const first = await fetchJson<ResultApiResponse>(pageUrl(1, regulation));
  if (first.result !== 1) throw new Error(`resultAPI error: ${first.errMsg}`);

  const entries = [...first.cardList];
  for (let page = 2; page <= first.maxPage; page++) {
    await sleep(delayMs);
    const res = await fetchJson<ResultApiResponse>(pageUrl(page, regulation));
    if (res.result !== 1) throw new Error(`resultAPI error on page ${page}: ${res.errMsg}`);
    entries.push(...res.cardList);
  }

  if (entries.length !== first.hitCnt) {
    throw new Error(`件数不一致: hitCnt=${first.hitCnt} だが ${entries.length} 件しか取得できていない`);
  }
  return entries;
}

/**
 * デッキ構築ツールのカード検索。
 *
 * 公式は**カード検索を 2 つ持っている**。上の `resultAPI.php` は
 * カード検索ページのもので、こちらはデッキを組む画面のもの。
 * 後者のほうが広い（XY で 5,581 件 対 6,198 件、BW で 20,798 件 対 21,742 件）。
 *
 * 公式のデータベースには同じカードのレコードが 2 つあることがある。
 * 048622 と 049800（どちらも「ロケット団のゴルバット」）は詳細ページが
 * ID 以外まったく同じで、カード検索は片方に畳んで見せ、こちらは畳まない。
 * **デッキ ID はどちらの ID でも指せる。**アプリのデッキコード取り込みは
 * cardId をそのまま持つので、カード検索だけを見ていると
 * 「アプリは知っているが、デッキ共有ページは名前も絵も引けない」
 * カードが生まれる（049573「ポケパッド」で実際に起きた）。
 *
 * そのため取得の網はこちらで張る。ただし `standard` / `extra` の印は
 * 引き続き `resultAPI.php` の結果で付ける。アプリのカード検索はその印で
 * 絞っているので、こちらを印に使うと畳まれていた重複が検索結果に出てしまう。
 */
function deckPageUrl(page: number, regulation: string): string {
  const q = new URLSearchParams({
    keyword: "",
    regulation_deck_itm: regulation,
    sm_and_keyword: "true",
    page: String(page),
  });
  return `${ORIGIN}/deck/deckCardSearch.php?${q}`;
}

export async function fetchAllDeckEntries(
  regulation = "XY",
  delayMs = 250,
): Promise<ListEntry[]> {
  const first = await fetchJson<ResultApiResponse>(deckPageUrl(1, regulation));
  if (first.result !== 1) throw new Error(`deckCardSearch error: ${first.errMsg}`);

  const entries = [...first.cardList];
  for (let page = 2; page <= first.maxPage; page++) {
    await sleep(delayMs);
    const res = await fetchJson<ResultApiResponse>(deckPageUrl(page, regulation));
    if (res.result !== 1) throw new Error(`deckCardSearch error on page ${page}: ${res.errMsg}`);
    entries.push(...res.cardList);
  }

  if (entries.length !== first.hitCnt) {
    throw new Error(`件数不一致: hitCnt=${first.hitCnt} だが ${entries.length} 件しか取得できていない`);
  }
  return entries;
}

/** 一覧 4 本の総件数。全ページ走査を省けるかの判断に使う。 */
export interface ListCounts {
  searchStandard: number;
  searchExtra: number;
  deckStandard: number;
  deckExtra: number;
}

/**
 * 4 本の一覧の **1 ページ目だけ**を取って、総件数（hitCnt）を集める。
 *
 * **全ページ走査は 4 本合計で 9 分半かかる。** 1 ページ 39 件しか返らず、
 * エクストラのカード検索が 534 ページ、デッキ構築が 558 ページあるため。
 * 新しいカードが 1 枚も無い日でも毎回これを払っていた。
 *
 * 総件数が前回と同じなら中身も同じとみなして走査を省く。
 * 「同数のまま入れ替わる」ことは起こりうるが、その場合も次に件数が動いた回で
 * 拾い直せるうえ、カードの詳細は元々 cardId で差分取得しているので取り違えない。
 */
export async function fetchListCounts(): Promise<ListCounts> {
  const hit = async (url: string): Promise<number> => {
    const res = await fetchJson<ResultApiResponse>(url);
    if (res.result !== 1) throw new Error(`件数の取得に失敗: ${res.errMsg}`);
    return res.hitCnt;
  };
  return {
    searchStandard: await hit(pageUrl(1, "XY")),
    searchExtra: await hit(pageUrl(1, "BW")),
    deckStandard: await hit(deckPageUrl(1, "XY")),
    deckExtra: await hit(deckPageUrl(1, "BW")),
  };
}
