// public/d/share-code.js が、アプリ側（Kotlin の DeckShareCode.kt）と
// 同じ並びを読めることを確かめる。
//
// 下の goldens はアプリ側で実際に作らせたコードをそのまま貼ったもの。
// Kotlin 側にも同じ文字列を置いた試験がある（DeckShareCodeTest）。
// **どちらか片方だけ通る状態は、共有リンクが読めなくなっているということ。**
// 形を変えるなら版（VERSION）を上げること。
//
// v2 から、カードは**送り手のアプリに並んでいた順のまま**入っている。
// 下の goldens も昇順ではない並びをわざと選んでいる。並べ替えて比べないこと。

import test from 'node:test';
import assert from 'node:assert/strict';
import { decode, encode, extractCode, ENERGY_NAMES, VERSION } from '../public/d/share-code.js';

const goldens = [
  {
    label: '60 枚・20 種類のデッキ',
    code: 'AgUACBTjg6Hjgqzjgqzjg6vjg7zjg6lleBSOoAUE0gECzwEDtA8EAQHGAQQCAoYOAwIEAgHODwQBAtAPAwIBzg8EAgLODwQCA84PAYoICLmg',
    expect: {
      name: 'メガガルーラex',
      energyName: 'fight',
      mainCardId: 43015,
      subCardId: 45001,
      // 昇順ではない。アプリで並べ替えたデッキのつもり。
      cards: [
        [43015, 4], [43120, 2], [43016, 3], [44002, 4], [44001, 1],
        [44100, 4], [44101, 2], [45000, 3], [45001, 4], [45002, 1],
        [46001, 4], [46000, 2], [47000, 3], [47001, 1], [48000, 4],
        [48001, 2], [49000, 4], [49001, 3], [50000, 1], [50517, 8],
      ],
    },
  },
  {
    label: 'カードが 1 枚も入っていないデッキ',
    code: 'Av___wPnqboAUTM',
    expect: { name: '空', energyName: null, mainCardId: null, subCardId: null, cards: [] },
  },
  {
    label: '絵文字と記号を含むデッキ名',
    code: 'AgEA_xnwn5Sl54KO44OH44OD44KtIHYyICjmlLkpApADO8cBAdd1',
    expect: {
      name: '🔥炎デッキ v2 (改)',
      energyName: 'fire',
      mainCardId: 200,
      subCardId: null,
      // 後ろのカードほど番号が小さい。差が負に振れる場合。
      cards: [[200, 59], [100, 1]],
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

for (const { label, code, expect } of goldens) {
  test(`開いて詰め直すと元のコードに戻る — ${label}`, () => {
    // **ここが合わないと、こちらが作ったリンクだけアプリと形が違うことになる。**
    // 大会の入賞デッキを共有 URL にする道具（src/deck-url.ts）が encode を使う。
    // 読めるだけでは足りず、アプリが出すものと 1 byte まで同じでないといけない。
    assert.equal(encode(decode(code)), code, label);
  });
}

test('詰めて開くと元の中身に戻る', () => {
  const deck = {
    name: 'ドラパルトex（CL優勝）',
    energyName: 'esper',
    mainCardId: 48656,
    subCardId: 45771,
    // 昇順ではない並び。差が負に振れる箇所を含める。
    cards: [
      { cardId: 48656, count: 3 },
      { cardId: 45771, count: 4 },
      { cardId: 45770, count: 4 },
      { cardId: 49026, count: 1 },
      { cardId: 1, count: 8 },
    ],
  };
  const back = decode(encode(deck));
  assert.equal(back.name, deck.name);
  assert.equal(back.energyName, deck.energyName);
  assert.equal(back.mainCardId, deck.mainCardId);
  assert.equal(back.subCardId, deck.subCardId);
  assert.deepEqual(back.cards, deck.cards);
});

test('主軸とエネルギーが分からないときは「無し」で詰める', () => {
  // 主軸に持っていないカードを指しても、綴りの違うエネルギーを渡しても、
  // 落ちずに「無し」になること。大会デッキは名前もエネルギーも公式には無く、
  // こちらで推し量って入れるので、外したときに壊れては困る。
  const back = decode(
    encode({ name: '', energyName: 'みず', mainCardId: 99999, subCardId: null, cards: [{ cardId: 5, count: 1 }] }),
  );
  assert.equal(back.name, '');
  assert.equal(back.energyName, null);
  assert.equal(back.mainCardId, null);
  assert.equal(back.subCardId, null);
});

test('カードが 1 枚も無くても詰められる', () => {
  const back = decode(encode({ name: '空', energyName: null, mainCardId: null, subCardId: null, cards: [] }));
  assert.deepEqual(back.cards, []);
  assert.equal(back.name, '空');
});

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

test('版が上がったら goldens も作り直す', () => {
  assert.equal(VERSION, 2);
});

test('cardId 昇順に並べ替えていた v1 のコードは読まない', () => {
  // 同じデッキを v1 で詰めたもの。読み方が違うので、読めてしまうと中身が化ける。
  assert.equal(
    decode('AQUACBTjg6Hjgqzjgqzjg6vjg7zjg6lleBSH0AIEAQNoAvEGAQEEYgQBAoMHAwEEAQHmBwIBBOcHAwEB5wcEAQLnBwQBA-cHAYUECKsM'),
    null,
  );
});

test('エネルギーの綴りの並びは固定', () => {
  // 添字をそのまま書き出しているので、並べ替えると過去のリンクが別の色になる。
  assert.deepEqual(ENERGY_NAMES, [
    'reef', 'fire', 'water', 'thunder', 'esper',
    'fight', 'dark', 'metal', 'fairy', 'dragon', 'common',
  ]);
});
