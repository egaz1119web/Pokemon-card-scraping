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
 * 途中で改行された本文をつなぐ。
 *
 * 公式サイトは `<br />` と `<br/>` を混在させている（トレーナーズの本文は前者、
 * 「特別なルール」は後者）。どちらでも次の行へ続いているとみなす。
 */
const CONTINUES = /<br\s*\/?>$/;

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
  return between(joinContinued(lines, i), "<p>", "</p>");
}

/** startIndex の行から、続きを示す <br> で終わらなくなるまで連結する。 */
function joinContinued(lines: string[], startIndex: number): string {
  let buf = lines[startIndex] ?? "";
  let i = startIndex;
  while (CONTINUES.test(buf.trimEnd()) && i + 1 < lines.length) {
    i += 1;
    buf += lines[i];
  }
  return buf;
}

/**
 * 「特別なルール」の本文から、カードの種別を割り出す。
 *
 * 判定はカードに書かれているルール文そのままを見る。名前の末尾（GX / V など）で
 * 決めないのは、「ゾロアークGX」のように名前だけ似ていて種別が違うカードや、
 * 名前に印が出ないカード（かがやくポケモン・ACE SPEC）があるため。
 *
 * スタンダードには ex・メガシンカ・テラスタルしか無いので長らくこれで足りていたが、
 * エクストラには BW〜SM 期の種別がまるごと入ってくる。
 */
const SPECIAL_RULES: [RegExp, string[]][] = [
  // 旧「M進化」と、SV の「メガシンカex」。表記が違うだけで同じもの。
  [/M進化ポケモン|メガシンカ/, ["メガシンカ"]],
  [/exがきぜつ/, ["ポケモンex"]],
  // 大文字の EX は BW〜XY の別物。小文字の ex とは分けて持つ。
  [/ポケモンEXがきぜつ/, ["ポケモンEX"]],
  [/ポケモンGXがきぜつ/, ["ポケモンGX"]],
  // TAG TEAM のルール文は GX に触れないが、カードとしてはどれも GX なので両方付ける。
  [/TAG TEAMがきぜつ/, ["TAG TEAM", "ポケモンGX"]],
  [/ポケモンVがきぜつ/, ["ポケモンV"]],
  [/ポケモンVMAXがきぜつ/, ["ポケモンVMAX"]],
  [/ポケモンVSTARがきぜつ/, ["ポケモンVSTAR"]],
  [/ポケモンV-UNIONがきぜつ/, ["ポケモンV-UNION"]],
  [/BREAK進化する前の/, ["ポケモンBREAK"]],
  [/（プリズムスター）のカード/, ["プリズムスター"]],
  [/かがやくポケモンは、デッキに1枚しか/, ["かがやくポケモン"]],
  [/ACE SPECのカードは、デッキに1枚しか/, ["ACE SPEC"]],
];

/** GAS 版の evoList / attribute は "[a,b,c]" という独自の文字列表現。Room と検索がこの形に依存している。 */
function toBracketList(items: string[]): string {
  return `[${items.join(",")}]`;
}

/**
 * 進化リンクの切り出しに混ざる HTML の残骸を落とす。
 *
 * 空白を含むものを捨てているのはタグの属性を弾くため。attribute 側は
 * こちらを通さない ―― 「TAG TEAM」「ACE SPEC」が空白ごと消えてしまう。
 */
function dropHtmlNoise(items: string[]): string[] {
  return items.filter((el) => !el.includes("=") && !el.includes("</div>") && !el.includes(" "));
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
      // メガシンカや V-UNION はルールが 2 文あり、<br/> で次の行へ続く。
      // 1 行目しか見ないと「M進化ポケモンになったとき」だけを読んで
      // ポケモンEX の判定を落とす。
      const body = joinContinued(lines, i + 1);
      for (const [pattern, labels] of SPECIAL_RULES) {
        if (pattern.test(body)) attribute.push(...labels);
      }
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
    evoList: toBracketList(dropHtmlNoise(evoList)),
    illust,
    cardId: cardIdOf(entry),
    sortId,
    pokemonType,
    rare,
    evoType,
    attribute: toBracketList([...new Set(attribute)]),
    // 詳細ページからは分からない。build.ts が一覧と突き合わせて付け直す。
    standard: false,
    extra: false,
  };
}

export async function fetchCard(entry: ListEntry, sortId: number): Promise<CardRecord> {
  const html = await fetchText(detailUrl(cardIdOf(entry)));
  return parseDetail(html, entry, sortId);
}
