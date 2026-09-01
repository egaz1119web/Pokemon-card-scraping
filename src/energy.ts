/**
 * カードテキスト中のエネルギーアイコン <span> を日本語表記へ置換する。
 *
 * 旧 GAS 版は String.prototype.replace を使っていたため各アイコンの
 * 「最初の 1 個」しか置換されず、2 個目以降が生の HTML のまま Supabase に
 * 入っていた（実データで 70 件）。ここでは replaceAll を使って全置換する。
 */
const ENERGY_LABELS: [string, string][] = [
  ["dark", "悪"],
  ["water", "水"],
  ["fire", "炎"],
  ["steel", "鋼"],
  ["grass", "草"],
  ["fighting", "闘"],
  ["none", "無色"],
  ["dragon", "ドラゴン"],
  ["electric", "雷"],
  ["psychic", "超"],
  // フェアリーは XY〜SM のカードにしか出てこないため、スタンダードだけを
  // 見ていた間は必要なかった。エクストラを取り込むと 700 件ほど該当する。
  ["fairy", "フェアリー"],
];

/**
 * エネルギー以外の記号 <span>。
 *
 * カード名の側では公式が「メガレックウザEX」「◇（プリズムスター）」と
 * 書き下しているので、本文と収録名でも同じ読みに揃える。
 * 置換しないと `<span class="pcg pcg-megamark"></span>` が生のまま残る
 * （実データで 58 件、いずれもエクストラ）。
 */
const MARK_LABELS: [string, string][] = [
  ["megamark", "メガ"],
  // 本文では必ず直後に「（プリズムスター）」が続くので、記号だけを置く。
  ["prismstar", "◇"],
];

export function changeEneName(text: string): string {
  let out = text;
  for (const [key, label] of ENERGY_LABELS) {
    out = out.replaceAll(`<span class="icon-${key} icon"></span>`, label);
  }
  for (const [key, label] of MARK_LABELS) {
    out = out.replaceAll(`<span class="pcg pcg-${key}"></span>`, label);
  }
  // 「たね」などは <span> ではなく <img alt="たね" class="icon"> で表現されている。
  // 旧 GAS 版はこちらを見ておらず、ふしぎなアメの本文に img タグが生で残っていた。
  return out.replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/g, "$1");
}

/**
 * 本文の後始末。旧データに混入していた次の 2 点をここで潰す。
 *  - 行分割が \n 固定だったために残っていた末尾 \r（実データで 441 件）
 *  - 複数行テキストを連結した際にそのまま残る <br />（同 621 件）
 */
export function cleanText(text: string): string {
  return text
    // 「特別なルール」の本文は <p><p>...</p></p> と入れ子になっていることがあり、
    // 外側の開始タグだけ消費されて内側が残る。構造タグなので本文には要らない。
    .replaceAll("<p>", "")
    .replaceAll("</p>", "")
    .replaceAll("<br />", "\n")
    .replaceAll("<br/>", "\n")
    .replaceAll("<br>", "\n")
    .replaceAll("\r", "")
    .trim();
}

/** 名前付き実体参照のうち、公式サイトの HTML に実際に出てくるもの。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * HTML の実体参照を文字に戻す。
 *
 * 取得しているのは生の HTML と、その HTML をそのまま入れた JSON API なので、
 * 切り出した文字列には実体参照が残る。復号していなかったため
 * 「レシラム&amp;リザードンGX」のような名前がそのまま配信されていた
 * （名前 131 件・収録名 643 件）。
 *
 * 1 回の走査で全部置き換える。`&lt;` を先に戻してから `&amp;` を戻す、
 * のように多段にすると `&amp;lt;` が `<` まで戻ってしまう。
 * 知らない実体参照はそのまま残す ―― 勝手に消すと差分の原因が追えなくなる。
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * 表に出る文字列の後始末をまとめて行う。
 *
 * 以前は本文（ワザ・特性）にしか通しておらず、カード名と収録名は
 * 生の HTML のまま出ていた。
 *
 * 実体参照の復号は最後に行う。先に復号すると、カード本文に書かれた
 * `&lt;p&gt;` のような文字列が本物のタグと見分けられなくなり、
 * cleanText に消される。
 */
export function toText(value: string): string {
  return decodeEntities(cleanText(changeEneName(value)));
}
