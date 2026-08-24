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
];

export function changeEneName(text: string): string {
  let out = text;
  for (const [key, label] of ENERGY_LABELS) {
    out = out.replaceAll(`<span class="icon-${key} icon"></span>`, label);
  }
  return out;
}

/**
 * 本文の後始末。旧データに混入していた次の 2 点をここで潰す。
 *  - 行分割が \n 固定だったために残っていた末尾 \r（実データで 441 件）
 *  - 複数行テキストを連結した際にそのまま残る <br />（同 621 件）
 */
export function cleanText(text: string): string {
  return text
    .replaceAll("<br />", "\n")
    .replaceAll("<br/>", "\n")
    .replaceAll("<br>", "\n")
    .replaceAll("\r", "")
    .trim();
}
