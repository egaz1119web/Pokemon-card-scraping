// デッキ共有コードの読み書き。
//
// アプリ側（Kotlin）の DeckShareCode.kt と**同じ並び**を扱う。
// 片方だけ直すと共有リンクが読めなくなるので、必ず両方を揃えること。
// 並びの説明は Kotlin 側の説明を参照。

// v2 でカードの並びを送り手のアプリの表示順そのままに変えた。
// v1 は cardId 昇順に並べ替えていたので、読み方が違う。混ぜられないので受け付けない。
export const VERSION = 2;

// 添字をそのまま書き出しているので並べ替えてはいけない。
export const ENERGY_NAMES = [
  'reef', 'fire', 'water', 'thunder', 'esper',
  'fight', 'dark', 'metal', 'fairy', 'dragon', 'common',
];

const NONE = 0xff;

/** Base64URL（詰め物なし）を byte 列へ。読めなければ null。 */
function fromBase64Url(code) {
  const normalized = code.trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*$/.test(normalized)) return null;
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Kotlin 側と同じ Fletcher-16。 */
function fletcher16(bytes) {
  let a = 0;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 255;
    b = (b + a) % 255;
  }
  return (b << 8) | a;
}

class Cursor {
  constructor(bytes, at) {
    this.bytes = bytes;
    this.at = at;
  }
  atEnd() {
    return this.at >= this.bytes.length;
  }
  byte() {
    if (this.at >= this.bytes.length) throw new RangeError('末尾を越えた');
    return this.bytes[this.at++];
  }
  take(length) {
    if (length < 0 || this.at + length > this.bytes.length) throw new RangeError('末尾を越えた');
    const slice = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return slice;
  }
  varint() {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      result |= (b & 0x7f) << shift;
      if (b < 0x80) return result >>> 0;
      shift += 7;
      if (shift > 28) throw new RangeError('桁が多すぎる');
    }
  }
}

/** ジグザグ詰めを解く。0,1,2,3,4… を 0,-1,1,-2,2… と読む。 */
function unzigzag(value) {
  return (value >>> 1) ^ -(value & 1);
}

/**
 * 共有コードを開く。
 * 戻り値は `{ name, cards: [{cardId, count}], energyName, mainCardId, subCardId }`。
 * 読めなければ null。
 */
export function decode(code) {
  const bytes = fromBase64Url(code || '');
  if (!bytes || bytes.length < 8) return null;

  const body = bytes.subarray(0, bytes.length - 2);
  const expected = (bytes[bytes.length - 1] << 8) | bytes[bytes.length - 2];
  if (fletcher16(body) !== expected) return null;
  if (body[0] !== VERSION) return null;

  const cursor = new Cursor(body, 1);
  try {
    const energy = cursor.byte();
    const mainIndex = cursor.byte();
    const subIndex = cursor.byte();

    const nameLength = cursor.varint();
    const name = new TextDecoder('utf-8', { fatal: true }).decode(cursor.take(nameLength));

    const size = cursor.varint();
    const cards = [];
    let previous = 0;
    for (let i = 0; i < size; i++) {
      // 並べ替えていないので差は前にも後ろにも動く。負を跨げる詰め方（ジグザグ）で読む。
      const cardId = previous + unzigzag(cursor.varint());
      const count = cursor.varint();
      if (cardId <= 0) return null;
      cards.push({ cardId, count });
      previous = cardId;
    }
    if (!cursor.atEnd()) return null;

    return {
      name,
      cards,
      energyName: energy < ENERGY_NAMES.length ? ENERGY_NAMES[energy] : null,
      mainCardId: mainIndex < cards.length ? cards[mainIndex].cardId : null,
      subCardId: subIndex < cards.length ? cards[subIndex].cardId : null,
    };
  } catch {
    return null;
  }
}

/** 数を varint で詰める。読む側の Cursor.varint と対。 */
function pushVarint(out, value) {
  let v = value >>> 0;
  for (;;) {
    if (v < 0x80) {
      out.push(v);
      return;
    }
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
}

/** ジグザグ詰め。0,-1,1,-2,2… を 0,1,2,3,4… に寄せる。unzigzag と対。 */
function zigzag(value) {
  return ((value << 1) ^ (value >> 31)) >>> 0;
}

/** byte 列を Base64URL（詰め物なし）へ。fromBase64Url と対。 */
function toBase64Url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 共有コードを作る。`decode` が返すものをそのまま渡せる。
 *
 * アプリが作ったコードと**同じ並びで**出す。試験（share-code.test.mjs）が
 * goldens を decode → encode して元に戻ることを見ているので、ずれれば落ちる。
 *
 * **カードは渡された順のまま入れる。並べ替えないこと。** v2 の要点は
 * 「送り手の画面に並んでいた順を保つ」ことで、ここで整えると意味が無くなる。
 *
 * 主軸・副軸は cardId で渡す。`cards` の何番目かに直して 1 byte で持つので、
 * 見つからなければ「無し」（0xFF）になる。エネルギーも綴りが合わなければ無し。
 */
export function encode(deck) {
  const cards = deck.cards ?? [];
  const out = [VERSION];

  const energy = ENERGY_NAMES.indexOf(deck.energyName ?? '');
  out.push(energy === -1 ? NONE : energy);

  const indexOf = (cardId) => {
    if (cardId == null) return NONE;
    const at = cards.findIndex((c) => c.cardId === cardId);
    // 添字は 1 byte しかない。0xFF は「無し」なので、そこに届く並びは持てない。
    return at === -1 || at >= NONE ? NONE : at;
  };
  out.push(indexOf(deck.mainCardId));
  out.push(indexOf(deck.subCardId));

  const name = new TextEncoder().encode(deck.name ?? '');
  pushVarint(out, name.length);
  for (const b of name) out.push(b);

  pushVarint(out, cards.length);
  let previous = 0;
  for (const card of cards) {
    if (!(card.cardId > 0)) throw new RangeError(`cardId が正でない: ${card.cardId}`);
    // 並べ替えていないので差は前にも後ろにも動く。負を跨げる詰め方で書く。
    pushVarint(out, zigzag(card.cardId - previous));
    pushVarint(out, card.count);
    previous = card.cardId;
  }

  const sum = fletcher16(out);
  // 検査の 2 byte は下位から。読む側が (末尾 << 8) | 末尾の 1 つ前 で組み直す。
  out.push(sum & 0xff, (sum >> 8) & 0xff);
  return toBase64Url(out);
}

/** URL や貼り付けた文字列からコードを取り出す。Kotlin の DeckShareLink と同じ扱い。 */
export function extractCode(input) {
  const text = (input || '').trim();
  if (!text) return null;
  const matched = /[?&]c=([A-Za-z0-9_-]+)/.exec(text);
  if (matched) return matched[1];
  const single = text.split(/[\s\n]/)[0];
  if (single.length >= 8 && /^[A-Za-z0-9_-]+$/.test(single)) return single;
  return null;
}
