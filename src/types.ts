/**
 * 1 枚のカードを表すレコード。
 *
 * キーの並びは旧 Supabase `allCard` テーブルの列順とそろえてある。
 * JSON.stringify がこの順で出力するため、git diff が読みやすくなる。
 * Android 側の CardDetailResponse と 1:1 で対応する（sortId のみアプリ未使用）。
 */
export interface CardRecord {
  nameJp: string;
  imageUrl: string;
  type: string;
  pack: string;
  abilityName: string;
  ability: string;
  tech1Name: string;
  tech1Ability: string;
  tech2Name: string;
  tech2Ability: string;
  trainerAbility: string;
  evoList: string;
  illust: string;
  cardId: string;
  sortId: number;
  pokemonType: string;
  rare: string;
  evoType: string;
  attribute: string;
  /**
   * いま公式のスタンダード検索（regulation_sidebar_form=XY）に出てくるか。
   *
   * 積み上げ式なのでレギュレーション落ちしたカードも配信に残り続ける。
   * ユーザーの保存デッキが参照しているため消せないが、そのままだとアプリの
   * カード検索にも出てしまう。実際に 8,539 件のうち 2,991 件が該当していた。
   * どのカードを検索に出すかはアプリ側の判断なので、データとしては
   * 「一覧に載っているか」だけを渡す。build.ts が毎回付け直す。
   */
  standard: boolean;
}

/** resultAPI.php の cardList 要素 */
export interface ListEntry {
  cardID: string;
  cardThumbFile: string;
  cardNameAltText: string;
  cardNameViewText: string;
}

/** data/state.json */
export interface State {
  version: number;
  updatedAt: string;
  /** 分割実行の途中で変更が入ったことを覚えておき、完走した回にまとめてバージョンを上げる */
  pendingBump?: boolean;
}

export const CARD_KEYS: (keyof CardRecord)[] = [
  "nameJp", "imageUrl", "type", "pack", "abilityName", "ability",
  "tech1Name", "tech1Ability", "tech2Name", "tech2Ability", "trainerAbility",
  "evoList", "illust", "cardId", "sortId", "pokemonType", "rare", "evoType", "attribute",
  "standard",
];

/** キー順を固定したうえでレコードを作り直す */
export function normalizeKeyOrder(card: CardRecord): CardRecord {
  const out: Record<string, unknown> = {};
  for (const k of CARD_KEYS) out[k] = card[k];
  return out as unknown as CardRecord;
}
