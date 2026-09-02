// public/d/share-code.js が、アプリ側（Kotlin の DeckShareCode.kt）と
// 同じ並びを読めることを確かめる。
//
// 下の goldens はアプリ側で実際に作らせたコードをそのまま貼ったもの。
// Kotlin 側にも同じ文字列を置いた試験がある（DeckShareCodeTest）。
// **どちらか片方だけ通る状態は、共有リンクが読めなくなっているということ。**
// 形を変えるなら版（VERSION）を上げて、古い版も読めるようにすること。

import test from 'node:test';
import assert from 'node:assert/strict';
import { decode, extractCode, ENERGY_NAMES } from '../public/d/share-code.js';

const goldens = [
  {
    label: '60 枚・20 種類のデッキ',
    code: 'AQUACBTjg6Hjgqzjgqzjg6vjg7zjg6lleBSH0AIEAQNoAvEGAQEEYgQBAoMHAwEEAQHmBwIBBOcHAwEB5wcEAQLnBwQBA-cHAYUECKsM',
    expect: {
      name: 'メガガルーラex',
      energyName: 'fight',
      mainCardId: 43015,
      subCardId: 45001,
      cards: [
        [43015, 4], [43016, 3], [43120, 2], [44001, 1], [44002, 4],
        [44100, 4], [44101, 2], [45000, 3], [45001, 4], [45002, 1],
        [46000, 2], [46001, 4], [47000, 3], [47001, 1], [48000, 4],
        [48001, 2], [49000, 4], [49001, 3], [50000, 1], [50517, 8],
      ],
    },
  },
  {
    label: 'カードが 1 枚も入っていないデッキ',
    code: 'Af___wPnqboAUCo',
    expect: { name: '空', energyName: null, mainCardId: null, subCardId: null, cards: [] },
  },
  {
    label: '絵文字と記号を含むデッキ名',
    code: 'AQEB_xnwn5Sl54KO44OH44OD44KtIHYyICjmlLkpAmQBZDtE0w',
    expect: {
      name: '🔥炎デッキ v2 (改)',
      energyName: 'fire',
      mainCardId: 200,
      subCardId: null,
      cards: [[100, 1], [200, 59]],
    },
  },
];

for (const { label, code, expect } of goldens) {
  test(`アプリが作ったコードを開ける — ${label}`, () => {
    const deck = decode(code);
    assert.ok(deck, '読めなかった');
    assert.equal(deck.name, expect.name);
    assert.equal(deck.energyName, expect.energyName);
    assert.equal(deck.mainCardId, expect.mainCardId);
    assert.equal(deck.subCardId, expect.subCardId);
    assert.deepEqual(deck.cards.map((c) => [c.cardId, c.count]), expect.cards);
  });
}

test('60 枚のデッキでも URL が QR に収まる長さ', () => {
  const url = `https://pokedeck.op-sarada.workers.dev/d?c=${goldens[0].code}`;
  // QR の版 10（バイトモード・誤り訂正 M）で 213 バイト。余裕を見て 200 で切る。
  assert.ok(url.length < 200, `長すぎる: ${url.length}`);
});

test('途中で切れたコードは読まない', () => {
  const code = goldens[0].code;
  for (let i = 1; i < code.length; i++) {
    assert.equal(decode(code.slice(0, i)), null, `切れているのに読めた: ${i}`);
  }
});

test('1 文字書き換えたコードは読まない', () => {
  const code = goldens[0].code;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let read = 0;
  for (let i = 0; i < code.length; i++) {
    for (const c of alphabet) {
      if (c === code[i]) continue;
      if (decode(code.slice(0, i) + c + code.slice(i + 1))) read++;
    }
  }
  assert.equal(read, 0, `書き換えたのに読めた: ${read} 件`);
});

test('でたらめな文字列を渡しても落ちない', () => {
  for (const s of ['', 'a', '!!!', 'AAAAAAAA', '____', '12345678901234567890', null, undefined]) {
    assert.equal(decode(s), null, String(s));
  }
});

test('文中や貼り付けからコードを取り出す', () => {
  const code = goldens[0].code;
  assert.equal(extractCode(`「メガガルーラex」のデッキ\nhttps://example.com/d?c=${code}`), code);
  assert.equal(extractCode(`https://example.com/d?x=1&c=${code}`), code);
  assert.equal(extractCode(code), code);
  assert.equal(extractCode('ただの文'), null);
  assert.equal(extractCode(''), null);
});

test('エネルギーの綴りの並びは固定', () => {
  // 添字をそのまま書き出しているので、並べ替えると過去のリンクが別の色になる。
  assert.deepEqual(ENERGY_NAMES, [
    'reef', 'fire', 'water', 'thunder', 'esper',
    'fight', 'dark', 'metal', 'fairy', 'dragon', 'common',
  ]);
});
