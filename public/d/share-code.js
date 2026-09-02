// デッキ共有コードの読み書き。
//
// アプリ側（Kotlin）の DeckShareCode.kt と**同じ並び**を扱う。
// 片方だけ直すと共有リンクが読めなくなるので、必ず両方を揃えること。
// 並びの説明は Kotlin 側の説明を参照。

export const VERSION = 1;

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
      const cardId = previous + cursor.varint();
      const count = cursor.varint();
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
