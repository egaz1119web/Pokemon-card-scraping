// カードの絵の URL を組み立てる。共有ページと OGP の Worker が同じものを使う。
//
// **索引（cards-min.json）の image は 2 通りの形をとる。**
// 大半は `large/` を剥がした相対パス（`ENE/000001_E_KUSAENERUGI.jpg`）だが、
// 43 枚だけ `card_images/legend/` 配下にあり、剥がせないので絶対パスのまま入る
// （`/assets/images/card_images/legend/XY8-Bb/031346_P_ZOROAKUBREAK.jpg`）。
//
// 頭に決め打ちの前置きを足すだけだと、その 43 枚で
// `.../large//assets/images/card_images/legend/...` という URL ができて 404 になる。
// **実際そうなっていた**ので、ここで両方の形を受けるようにしてある。

const OFFICIAL = 'https://www.pokemon-card.com';

/** `large/` を剥がした相対パスに戻すための前置き。build.ts の IMAGE_PREFIX と同じ。 */
const LARGE = '/assets/images/card_images/large/';

// 自前の配信元。
//
// アプリは version.json の imageBase を読むが、この頁は配信物と一緒に出ていくので
// 焼き込みで構わない（ストアの審査を挟まないため、変えたら次のデプロイで揃う）。
// 変えるときは配信側（src/images.ts が置く先）と一緒に。
const MIRROR = 'https://img.egaz.uk';

/** 索引の image を、公式サイトからの絶対パスに戻す。 */
function toPath(image) {
  const raw = String(image || '');
  if (!raw) return '';
  // **頭の `/` だけで見分けないこと。** 弾の記号が空のカードは索引で
  // `/036903_P_MYUU.jpg` になり（`large/` を剥がすと空の区間が残るため）、
  // 絶対パスと見分けが付かない。`/assets/` で始まるものだけを絶対パスとして扱う。
  const full = raw.startsWith('/assets/') ? raw : LARGE + raw;
  // 弾の記号が空のカードが 80 枚あり `large//036903_...` のように重なる。
  // 公式の Apache は畳んで返すが、配信側の鍵は畳んだ形で作ってあるので揃える。
  return full.replace(/\/{2,}/g, '/');
}

/**
 * 一覧に並べる絵。自前の配信の 540w webp を指す。
 *
 * 公式の原本は 1 枚 321KB（平均）ある。デッキは 20〜30 種類あるので、
 * そのままだと 1 ページで 7〜10MB になる。共有リンクは LINE や X から
 * 携帯で開かれるので、ここが効く。1 枚 77KB、4.2 倍軽い。
 */
export function thumbUrl(image) {
  const path = toPath(image);
  if (!path) return '';
  return MIRROR + path.replace(/\.[a-zA-Z0-9]+$/, '') + '.webp';
}

/**
 * 公式の原本。
 *
 * 使うのは 2 か所だけ。
 *  - 拡大して見せるとき（540w では絵柄も細かい文字も読めない）
 *  - まだ取り込めていないカードの逃げ道（onerror）
 *
 * OGP の og:image もこちら。**webp にしないこと。** クローラ側の webp 対応は
 * まちまちで、共有先で絵が出なくなると配布経路そのものが痩せる。
 * 取りに来るのはクローラが 1 回だけなので、軽くする利点も無い。
 */
export function originalUrl(image) {
  const path = toPath(image);
  return path ? OFFICIAL + path : '';
}
