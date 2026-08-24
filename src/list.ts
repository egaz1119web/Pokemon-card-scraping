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
