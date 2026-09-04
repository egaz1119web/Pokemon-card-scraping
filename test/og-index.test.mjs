// OGP 用に索引から 1 件だけ切り出す pickEntry の確かめ。
//
// 共有ページの Worker は cards-min.json を JSON.parse していない。
// 680KB を丸ごと解くと、欲しいのが 1 件でも無料枠の CPU 時間（1 リクエスト
// 10ms）に触れかねないため、文字列のまま切り出している。
//
// **その代わり、切り出しを間違えるとそのカードだけ静かに絵が出なくなる。**
// 気づける場所がここしか無いので、配信している索引の全件を JSON.parse の
// 結果と突き合わせる。カード名に括弧が入るもの（ナッシー[Exeggutor]）で
// 実際に踏んだ。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickEntry } from '../worker/index.js';

for (const path of ['public/cards-min.json', 'public/cards-min-extra.json']) {
  test(`${path} の全件が JSON.parse と一致する`, () => {
    const text = readFileSync(path, 'utf8');
    const parsed = JSON.parse(text);
    const wrong = [];
    for (const [cardId, entry] of Object.entries(parsed)) {
      const got = pickEntry(text, cardId);
      if (!got || got.name !== entry[0] || got.image !== entry[1]) wrong.push(cardId);
    }
    assert.deepEqual(wrong, [], `切り出せなかったカード: ${wrong.slice(0, 10).join(', ')}`);
  });
}

test('索引に無い cardId は null', () => {
  const text = readFileSync('public/cards-min.json', 'utf8');
  assert.equal(pickEntry(text, 999999), null);
});

test('前に数字が付く cardId に取り違えない', () => {
  // "149573" の中の "49573" に当たってはいけない。
  const text = '{"149573":["わな","X/1.jpg","グッズ"],"49573":["ポケパッド","MC/2.jpg","グッズ"]}';
  assert.deepEqual(pickEntry(text, 49573), { name: 'ポケパッド', image: 'MC/2.jpg' });
});

test('名前に括弧が入っていても最後まで取れる', () => {
  const text = '{"32294":["ナッシー[Exeggutor]","CP6/032294_P_NASSHI.jpg","ポケモン"]}';
  assert.deepEqual(pickEntry(text, 32294), {
    name: 'ナッシー[Exeggutor]',
    image: 'CP6/032294_P_NASSHI.jpg',
  });
});
