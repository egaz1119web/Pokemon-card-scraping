// 共有リンクの「外向きの顔」を作る Worker。
//
// /d?c=... は中身をリンクそのものに持っているので、これまで静的な HTML を
// そのまま配っていた。それだと OGP が全部同じ文言になり、X や LINE に貼っても
// デッキ名も絵も出ない。タイムラインでは絵の無いリンクは見られないので、
// せっかく共有された 1 本 1 本が黙って流れていた。
//
// c= を解けばデッキ名も主軸カードも分かる（どちらもリンクの中にある）。
// ここで head を書き換えて、貼られた場所にデッキ名とカードの絵が出るようにする。
//
// **走らせるのは /d だけ。** wrangler.jsonc の run_worker_first で絞ってある。
// カードデータ（cards.json など）は今まで通り静的配信のままで、
// そちらは無料かつ帯域課金も無い。ここを広げると全部が Worker 課金になる。

// 復号はページと同じものを使う。書式が変わったときに片方だけ古くなると、
// 人には正しく見えているのに SNS には古い読み方の結果が出る、という
// いちばん気づけない壊れ方をする。写さずに読み込むこと。
import { decode } from "../public/d/share-code.js";

const IMAGE_BASE = "https://www.pokemon-card.com/assets/images/card_images/large/";

// ページ側と同じ順で引く。スタンダードに無ければエクストラを見る。
const INDEX_PATHS = ["/cards-min.json", "/cards-min-extra.json"];

// 索引を isolate に抱えておく持ち時間。_headers の max-age と揃えてある。
// 長くすると、カードを足した直後に共有されたデッキの絵が出ないままになる。
const INDEX_TTL_MS = 5 * 60 * 1000;

/** path -> { at, text }。isolate が生きているあいだだけ残る。 */
const heldIndex = new Map();

async function indexText(env, origin, path) {
  const held = heldIndex.get(path);
  if (held && Date.now() - held.at < INDEX_TTL_MS) return held.text;
  const res = await env.ASSETS.fetch(new Request(new URL(path, origin)));
  // 取れなければ、期限切れでも手元のもので済ませる。絵が出ないより古い方がまし。
  if (!res.ok) return held ? held.text : null;
  const text = await res.text();
  heldIndex.set(path, { at: Date.now(), text });
  return text;
}

/**
 * 索引から 1 件だけ切り出す。
 *
 * **JSON.parse を使わないこと。** cards-min.json は 680KB あり、丸ごと解くと
 * 8,800 件ぶんの配列をその場で作ることになる。無料枠の CPU 時間は
 * 1 リクエスト 10ms しかないので、欲しいのが 1 件でも落ちかねない。
 *
 * 探す鍵は `"49573":` の形。先頭の引用符まで含めて探すので `"149573":` には
 * 当たらない。値の中身（カード名・画像の名前）は配列の要素なので、
 * うしろに続くのは `,` であって `:` ではない。取り違えは起きない。
 *
 * **閉じ括弧は素朴に探さないこと。** カード名に括弧が入っているものがある
 * （「ナッシー[Exeggutor]」など）。最初の `]` で切ると名前の途中で切れて、
 * そのカードだけ静かに絵が出なくなる。文字列の中は跨がないように数える。
 */
export function pickEntry(text, cardId) {
  const at = text.indexOf(`"${cardId}":`);
  if (at === -1) return null;
  const open = text.indexOf("[", at);
  if (open === -1) return null;

  let inString = false;
  let close = -1;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "]") {
      close = i;
      break;
    }
  }
  if (close === -1) return null;

  try {
    const entry = JSON.parse(text.slice(open, close + 1));
    return { name: entry[0], image: entry[1] };
  } catch {
    return null;
  }
}

async function findCard(env, origin, cardId) {
  if (!cardId) return null;
  for (const path of INDEX_PATHS) {
    const text = await indexText(env, origin, path);
    if (!text) continue;
    const found = pickEntry(text, cardId);
    if (found) return found;
  }
  return null;
}

const escapeAttr = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function describe(deck, card) {
  const name = deck.name.trim() || "名前のないデッキ";
  const total = deck.cards.reduce((sum, c) => sum + c.count, 0);
  const kinds = `${total} 枚 ・ ${deck.cards.length} 種類`;
  const head = card ? `${kinds}（主軸は${card.name}）` : kinds;
  return {
    name,
    title: `${name} ― PokeDeck`,
    description: `${head}。アプリで開くと、そのまま自分のデッキになります。`,
  };
}

function metaHtml(deck, card, shareUrl) {
  const { title, description } = describe(deck, card);
  const tags = [
    ["og:type", "website"],
    ["og:site_name", "PokeDeck"],
    ["og:url", shareUrl],
    ["og:title", title],
    ["og:description", description],
  ];
  if (card) {
    // 公式サイトの画像をそのまま指す。X や LINE のクローラは公式から直に取りに行く。
    // 手元に写して配ると、公式の絵を自分の配信に載せることになるので、こちらを選ぶ。
    tags.push(["og:image", IMAGE_BASE + card.image]);
    tags.push(["og:image:alt", card.name]);
    // カードは縦長（868x1212）なので、大きい方の型では上下が切られて
    // 絵の真ん中あたりが出る。名前まで見せたいなら、いずれ 1200x630 を
    // こちらで組んで返すしかない（日本語の字を積む必要があり、今は見送り）。
    tags.push(["twitter:card", "summary_large_image"]);
  } else {
    tags.push(["twitter:card", "summary"]);
  }
  tags.push(["twitter:title", title]);
  tags.push(["twitter:description", description]);

  return tags
    .map(([key, value]) => {
      // twitter: は name、og: は property。取り違えると X が読まない。
      const attr = key.startsWith("twitter:") ? "name" : "property";
      return `<meta ${attr}="${key}" content="${escapeAttr(value)}">`;
    })
    .join("\n");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // **/d は /d/ へ送ること。** 静的配信は元々こう振る舞っていて、
    // ページの <script src="./share-code.js"> はその前提で書いてある。
    // ここで /d のまま 200 を返すと ./ が / になり、share-code.js が 404 になって
    // デッキが一枚も出なくなる（OGP だけ正しくて中身が空、という壊れ方をする）。
    if (url.pathname === "/d") {
      url.pathname = "/d/";
      return Response.redirect(url.toString(), 307);
    }
    if (url.pathname !== "/d/") return env.ASSETS.fetch(request);

    const code = url.searchParams.get("c");
    const deck = code ? decode(code) : null;

    // 条件付きの見出しは外して取りに行く。付けたまま渡すと 304 が返ることがあり、
    // 中身の無い返事は書き換えようがない。
    const page = await env.ASSETS.fetch(new Request(new URL(url.pathname, url), { method: "GET" }));
    if (!deck || !page.ok) return page;

    const card = await findCard(env, url.origin, deck.mainCardId);
    const { name, title, description } = describe(deck, card);
    const shareUrl = `${url.origin}/d/?c=${code}`;

    const rewritten = new HTMLRewriter()
      .on("title", { element: (el) => el.setInnerContent(title) })
      .on("meta[name='description']", { element: (el) => el.setAttribute("content", description) })
      // 既にある固定文言の og は消してから、デッキごとのものを入れ直す。
      .on("meta[property^='og:']", { element: (el) => el.remove() })
      .on("meta[name^='twitter:']", { element: (el) => el.remove() })
      .on("head", { element: (el) => el.append("\n" + metaHtml(deck, card, shareUrl) + "\n", { html: true }) })
      // 見出しにもデッキ名を入れる。JS を動かさないクローラに読ませるためだが、
      // 人にとっても「デッキを読み込んでいます…」が一瞬出るのが消える。
      .on("h1#title", { element: (el) => el.setInnerContent(name) })
      .transform(page);

    const headers = new Headers(rewritten.headers);
    // **ETag と Last-Modified は消すこと。** 元は同じ 1 枚の HTML なので、
    // 残すとデッキが違っても同じ印になる。ブラウザが別のデッキの中身を
    // 使い回してしまう。URL（c=）はデッキごとに違うので、素直に時間で持たせる。
    headers.delete("etag");
    headers.delete("last-modified");
    headers.set("cache-control", "public, max-age=60");
    return new Response(rewritten.body, { status: rewritten.status, headers });
  },
};
