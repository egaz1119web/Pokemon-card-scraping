import type { ListCounts } from "./list.js";
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
  /**
   * いま公式のエクストラ検索（regulation_sidebar_form=BW）に出てくるか。
   *
   * standard と同じく毎回付け直す。エクストラは落ちない建前だが、
   * 公式が一覧から下げるカードは実際にある（現配信の 667 件がそれで、
   * どのレギュレーションの検索にも出てこない）。判断はアプリ側に渡す。
   */
  extra: boolean;
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
  /**
   * 前回の実行で見た一覧 4 本の総件数。
   *
   * 次の実行はまず 1 ページ目だけを見て、ここと同じなら**全ページの走査を省く**。
   * 走査は 4 本合計で 9 分半かかり、新しいカードが無い日でも毎回払っていた。
   * この項目が無い（初回）ときは省かずに全部走る。
   */
  listCounts?: ListCounts;
  /** 分割実行の途中で変更が入ったことを覚えておき、完走した回にまとめてバージョンを上げる */
  pendingBump?: boolean;
  /**
   * cards-extra.json の版。スタンダードとは独立して数える。
   *
   * 分けているのは、エクストラの初回取り込みに 1 万件以上かかるため。
   * 版を共有していると、その間ずっと「未完了」になってスタンダードの
   * 新しいカードもアプリに届かなくなる。
   * 0 は「まだ揃っていない」＝アプリは取りに行かなくてよい、の意。
   */
  extraVersion?: number;
  extraPendingBump?: boolean;
}

export const CARD_KEYS: (keyof CardRecord)[] = [
  "nameJp", "imageUrl", "type", "pack", "abilityName", "ability",
  "tech1Name", "tech1Ability", "tech2Name", "tech2Ability", "trainerAbility",
  "evoList", "illust", "cardId", "sortId", "pokemonType", "rare", "evoType", "attribute",
  "standard", "extra",
];

/** キー順を固定したうえでレコードを作り直す */
export function normalizeKeyOrder(card: CardRecord): CardRecord {
  const out: Record<string, unknown> = {};
  for (const k of CARD_KEYS) out[k] = card[k];
  return out as unknown as CardRecord;
}
