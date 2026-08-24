import { changeEneName, cleanText } from "./energy.js";
import { fetchText, ORIGIN } from "./http.js";
import type { CardRecord, ListEntry } from "./types.js";
import { cardIdOf } from "./list.js";

/** GAS 版で使っていた Parser.data(x).from(a).to(b).build() 相当。見つからなければ空文字。 */
function between(source: string, from: string, to: string): string {
  const s = source.indexOf(from);
  if (s === -1) return "";
  const start = s + from.length;
  const e = source.indexOf(to, start);
  if (e === -1) return "";
  return source.slice(start, e);
}

/** from と to に挟まれた箇所をすべて拾う（Parser の iterate 相当）。 */
function betweenAll(source: string, from: string, to: string): string[] {
  const out: string[] = [];
  let cursor = 0;
  for (;;) {
    const s = source.indexOf(from, cursor);
    if (s === -1) break;
    const start = s + from.length;
    const e = source.indexOf(to, start);
    if (e === -1) break;
    out.push(source.slice(start, e));
    cursor = e + to.length;
  }
  return out;
}

/**
 * トレーナーズ系の本文は 1 行に収まらず <br /> で次行へ続くことがある。
 * 続く限り連結してから <p>...</p> を取り出す。
 */
function joinWrappedText(lines: string[], startIndex: number): string {
  // プリズムエネルギーのように、種別の見出しの直後にさらに「特別なルール」の
  // 見出しが続き、本文がその先にあるカードがある。見出しと空行は読み飛ばす。
  let i = startIndex;
  for (let skipped = 0; skipped < 3; skipped++) {
    const line = lines[i] ?? "";
    if (line.includes("<p>")) break;
    if (line.trim() === "" || line.includes("<h2")) i += 1;
    else break;
  }
  let buf = lines[i] ?? "";
  while (buf.trimEnd().endsWith("<br />") && i + 1 < lines.length) {
    i += 1;
    buf += lines[i];
  }
  return between(buf, "<p>", "</p>");
}

/** GAS 版の evoList / attribute は "[a,b,c]" という独自の文字列表現。Room と検索がこの形に依存している。 */
function toBracketList(items: string[]): string {
  const cleaned = items.filter((el) => !el.includes("=") && !el.includes("</div>") && !el.includes(" "));
  return `[${cleaned.join(",")}]`;
}

/**
 * 進化ラインに出てくるポケモン名を集める。
 *
 * 進化セクションのリンクは <div> を挟んで 1 行ずつ並ぶため、GAS 版のように
 * 「空振りが 3 行続いたら終わり」という行単位の走査だと途中で打ち切られる
 * （イーブイは 25 件あるうち 2 件しか取れていなかった）。
 * 見出しから <div class="clear"> までをまとめて切り出してから拾う。
 */
function collectEvolutions(html: string): string[] {
  const start = html.indexOf('"mt20">進化');
  if (start === -1) return [];
  const end = html.indexOf('class="clear"', start);
  const section = end === -1 ? html.slice(start) : html.slice(start, end);
  return betweenAll(section, "&pokemon=", '">').map((el) =>
    decodeURIComponent(el.split("&")[0] ?? ""),
  );
}

export function detailUrl(cardId: string, regulation = "XY"): string {
  return `${ORIGIN}/card-search/details.php/card/${cardId}/regu/${regulation}`;
}

export function parseDetail(html: string, entry: ListEntry, sortId: number): CardRecord {
  const lines = html.split(/\r?\n/);

  let illust = between(html, "XY&illust=", '">');
  // 収録商品へのリンク。基本エネルギーなど商品リンクを持たないカードもあるので "その他" に寄せる
  let pack = between(html, '"Link Link-arrow">', "</a></li>");
  if (pack === "" || pack.includes("html")) pack = "その他";

  let type = "";
  let pokemonType = "";
  let abilityName = "";
  let ability = "";
  let tech1Name = "";
  let tech1Ability = "";
  let tech2Name = "";
  let tech2Ability = "";
  let trainerAbility = "";
  let rare = "";
  let evoType = "";
  const evoList: string[] = collectEvolutions(html);
  const attribute: string[] = [];

  // ワザ名は h4 にエネルギーアイコンとダメージ表記が混ざるため、かな・カナのみを拾う
  const kanaOnly = /[ぁ-んァ-ヶー]+/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (line.includes('"mt20">ワザ')) {
      if (type === "") type = "ポケモン";
      tech1Name = between(lines[i + 1] ?? "", "<h4>", "</h4>").match(kanaOnly)?.[0] ?? "";
      tech1Ability = between(lines[i + 2] ?? "", "<p>", "</p>");
      tech2Name = between(lines[i + 3] ?? "", "<h4>", "</h4>").match(kanaOnly)?.[0] ?? "";
      tech2Ability = between(lines[i + 4] ?? "", "<p>", "</p>");
    }

    if (line.includes('"mt20">特性')) {
      if (type === "") type = "ポケモン";
      abilityName = between(lines[i + 1] ?? "", "<h4>", "</h4>");
      ability = between(lines[i + 2] ?? "", "<p>", "</p>");
    }

    if (line.includes('<span class="hp-type">タイプ</span>')) {
      if (type === "") type = "ポケモン";
      pokemonType = changeEneName(lines[i + 1] ?? "").replace(/ /g, "").trim();
    }

    for (const [marker, label] of [
      ['"mt20">グッズ', "グッズ"],
      ['"mt20">サポート', "サポート"],
      ['"mt20">スタジアム', "スタジアム"],
      ['"mt20">ポケモンのどうぐ', "どうぐ"],
      ['"mt20">特殊エネルギー', "特殊エネルギー"],
    ] as const) {
      if (line.includes(marker)) {
        if (type === "") type = label;
        trainerAbility = joinWrappedText(lines, i + 1);
        if (label === "特殊エネルギー") illust = "";
      }
    }

    if (line.includes('"mt20">基本エネルギー')) {
      if (type === "") type = "基本エネルギー";
      illust = "";
    }

    if (line.includes('/assets/images/card/rarity/')) {
      rare = between(line, '<img src="', '" width="24" />');
    }

    if (line.includes('<span class="type">')) {
      evoType = between(line, '<span class="type">', "</span>").replaceAll("&nbsp;", "");
    }

    if (line.includes('"mt20">特別なルール')) {
      const body = lines[i + 1] ?? "";
      if (body.includes("メガシンカ")) attribute.push("メガシンカ");
      if (body.includes("ex")) attribute.push("ポケモンex");
    }

    if (line.includes("このポケモンは、ベンチにいるかぎり、ワザのダメージを受けない。")) {
      attribute.push("テラスタル");
    }

  }

  return {
    nameJp: entry.cardNameAltText,
    imageUrl: entry.cardThumbFile,
    type,
    pack,
    abilityName,
    ability: cleanText(changeEneName(ability)),
    tech1Name,
    tech1Ability: cleanText(changeEneName(tech1Ability)),
    tech2Name,
    tech2Ability: cleanText(changeEneName(tech2Ability)),
    trainerAbility: cleanText(changeEneName(trainerAbility)),
    evoList: toBracketList(evoList),
    illust,
    cardId: cardIdOf(entry),
    sortId,
    pokemonType,
    rare,
    evoType,
    attribute: toBracketList([...new Set(attribute)]),
  };
}

export async function fetchCard(entry: ListEntry, sortId: number): Promise<CardRecord> {
  const html = await fetchText(detailUrl(cardIdOf(entry)));
  return parseDetail(html, entry, sortId);
}
