// 共有ページと OGP の Worker が組み立てる画像 URL の確かめ。
//
// **索引（cards-min.json）は image を欠けた形で持っている。**
// 大半は `large/` を剥がした相対パスだが、剥がせないもの（card_images/legend/ 配下の
// 43 枚）は絶対パスのまま入る。頭に決め打ちの前置きを足すだけだと、その 43 枚で
// `.../large//assets/images/card_images/legend/...` ができて **404 になっていた**。
//
// なので「索引から組み立てた URL が、元の imageUrl から作る鍵と一致するか」を
// 全件で突き合わせる。配信側（src/images.ts の keyFor）と食い違うと、
// そのカードだけ絵が出ない。しかも公式へ逃げるので「なんとなく重い」ようにしか
// 見えず気づけない。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { thumbUrl, originalUrl } from '../public/d/card-image.js';

const MIRROR = 'https://img.egaz.uk';
const OFFICIAL = 'https://www.pokemon-card.com';

/** src/images.ts の keyFor と同じ規則。ここが崩れたら配信と食い違う。 */
const keyFor = (imagePath) =>
  imagePath.replace(/\/{2,}/g, '/').replace(/^\//, '').replace(/\.[a-zA-Z0-9]+$/, '') + '.webp';

test('ふつうのカードは自前の webp を指す', () => {
  assert.equal(
    thumbUrl('MEM/050452_P_SHIEIMI.jpg'),
    `${MIRROR}/assets/images/card_images/large/MEM/050452_P_SHIEIMI.webp`,
  );
});

test('legend 配下は絶対パスのまま入るので、前置きを足さない', () => {
  const image = '/assets/images/card_images/legend/XY8-Bb/031346_P_ZOROAKUBREAK.jpg';
  assert.equal(thumbUrl(image), `${MIRROR}/assets/images/card_images/legend/XY8-Bb/031346_P_ZOROAKUBREAK.webp`);
  assert.equal(originalUrl(image), `${OFFICIAL}${image}`);
});

test('スラッシュの重なりを畳む', () => {
  assert.equal(
    thumbUrl('/036903_P_MYUU.jpg'),
    `${MIRROR}/assets/images/card_images/large/036903_P_MYUU.webp`,
  );
});

test('gif のカードも webp を指す', () => {
  assert.equal(
    thumbUrl('LP/025285_E_HONOOENERUGI.gif'),
    `${MIRROR}/assets/images/card_images/large/LP/025285_E_HONOOENERUGI.webp`,
  );
});

test('原本は拡張子を変えない', () => {
  assert.equal(
    originalUrl('LP/025285_E_HONOOENERUGI.gif'),
    `${OFFICIAL}/assets/images/card_images/large/LP/025285_E_HONOOENERUGI.gif`,
  );
});

test('空は空を返す', () => {
  assert.equal(thumbUrl(''), '');
  assert.equal(thumbUrl(undefined), '');
  assert.equal(originalUrl(''), '');
});

for (const [index, cards] of [
  ['public/cards-min.json', 'public/cards.json'],
  ['public/cards-min-extra.json', 'public/cards-extra.json'],
]) {
  test(`${index} の全件が配信側の鍵と一致する`, () => {
    const idx = JSON.parse(readFileSync(index, 'utf8'));
    const all = JSON.parse(readFileSync(cards, 'utf8'));
    const wrong = [];
    for (const card of all) {
      const entry = idx[String(Number(card.cardId))];
      if (!entry || !card.imageUrl) continue;
      const want = `${MIRROR}/${keyFor(card.imageUrl)}`;
      if (thumbUrl(entry[1]) !== want) wrong.push(`${card.cardId}: ${thumbUrl(entry[1])} ≠ ${want}`);
    }
    assert.deepEqual(wrong, [], `食い違ったカード:\n${wrong.slice(0, 5).join('\n')}`);
  });

  test(`${index} の全件が公式の URL に戻せる`, () => {
    const idx = JSON.parse(readFileSync(index, 'utf8'));
    const all = JSON.parse(readFileSync(cards, 'utf8'));
    const wrong = [];
    for (const card of all) {
      const entry = idx[String(Number(card.cardId))];
      if (!entry || !card.imageUrl) continue;
      const want = OFFICIAL + card.imageUrl.replace(/\/{2,}/g, '/');
      if (originalUrl(entry[1]) !== want) wrong.push(`${card.cardId}: ${originalUrl(entry[1])} ≠ ${want}`);
    }
    assert.deepEqual(wrong, [], `食い違ったカード:\n${wrong.slice(0, 5).join('\n')}`);
  });
}
