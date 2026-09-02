/**
 * カードデータを更新して配信用の JSON を書き出す。
 *
 * 方針として「積み上げ式」を採る。スタンダード（XY）の検索結果は
 * レギュレーション落ちで減っていくが、ユーザーの保存デッキは落ちたカードも
 * 参照しているため、一度取り込んだカードは消さない。
 * 実際、移行時点の 7,831 件のうち 2,991 件は今の検索結果には出てこない。
 *
 * 配信はスタンダードとエクストラの 2 本立て。cards.json は今までどおり
 * スタンダードの積み上げのままにして、エクストラ（BW）にしか無いカードは
 * cards-extra.json へ分ける。1 ファイルにまとめると 14MB になり、
 * エクストラを使わない人と旧バージョンのアプリまで巻き込むため。
 *
 * 公式サイトには WAF が入っており、速く叩きすぎると IP 単位で 403 になる。
 * そのため 1 回の実行量に上限を設け、途中で拒否されても取れた分は保存して
 * 次回の実行で続きから再開する作りにしてある。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { fetchCard } from "./detail.js";
import { fetchAllListEntries, cardIdOf, uniqueByCardId } from "./list.js";
import { sleep, BlockedError } from "./http.js";
import type { CardRecord, ListEntry, State } from "./types.js";
import { normalizeKeyOrder } from "./types.js";

const MASTER = "data/cards.json";
/** エクストラにしか無いカード。cards.json とは重複させない。 */
const MASTER_EXTRA = "data/cards-extra.json";
const STATE = "data/state.json";
const SEED = "data/golden_allCard.json";
const EVENTS = "data/events.json";
/** 全件更新の進捗。取得し終えた cardId を貯めておき、複数回の実行に分割する。 */
const REFRESH_PROGRESS = "data/refresh-progress.json";
const OUT_DIR = "public";

// 実測では 200ms 間隔・並列 2 で約 1,150 件めにブロックされた。
// 旧 GAS 版が長年動いていた「逐次・1 秒間隔」に合わせる。
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 1);
const DELAY_MS = Number(process.env.DELAY_MS ?? 1000);
/** 1 回の実行で取得する上限。全件更新を複数回に分散させるための安全弁。 */
const MAX_FETCH = Number(process.env.MAX_FETCH ?? 1000);
/** 既存カードもすべて取得し直す。パース修正を全件へ反映したいときに使う。 */
const REFRESH_ALL = process.env.REFRESH_ALL === "1";
/**
 * 旧 GAS 由来の取りこぼしが残っているカードだけを取得し直す。
 * 全件更新は 8,500 件あって時間もアクセスもかかるため、
 * 移行時の後始末はこちらで足りる。
 */
const REFRESH_DIRTY = process.env.REFRESH_DIRTY === "1";
/** 指定した cardId だけ取り直す。カンマ区切り。パース修正の効果を狭く確かめたいときに使う。 */
const REFRESH_IDS = (process.env.REFRESH_IDS ?? "")
  .split(",")
  .map((v) => v.trim())
  .filter((v) => v !== "");
/** エクストラを触らない安全弁。スタンダードだけ回したいときに EXTRA=0。 */
const WITH_EXTRA = process.env.EXTRA !== "0";

/**
 * 表に出る文字列に HTML の残骸がある＝古いパーサで取ったレコード。
 *
 * 見るのは本文だけでは足りない。実体参照を復号していなかった時期のものは
 * カード名（「レシラム&amp;リザードンGX」）と収録名に残っており、
 * メガシンカ・プリズムスターの記号 <span> も同じく生のまま入っている。
 */
function hasLegacyArtifacts(card: CardRecord): boolean {
  const fields = [
    card.nameJp,
    card.pack,
    card.illust,
    card.abilityName,
    card.ability,
    card.tech1Name,
    card.tech1Ability,
    card.tech2Name,
    card.tech2Ability,
    card.trainerAbility,
    card.evoList,
    card.evoType,
  ];
  return fields.some(
    (v) =>
      v != null &&
      (v.includes("<") || v.includes("\r") || /&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/.test(v)),
  );
}

interface RefreshProgress {
  startedAt: string;
  done: string[];
}

function readJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
}

/** 1 レコード 1 行で書く。git diff で「どのカードが変わったか」がそのまま読める。 */
function writeLineDelimitedArray(path: string, rows: CardRecord[]): void {
  if (rows.length === 0) {
    writeFileSync(path, "[]\n");
    return;
  }
  const body = rows.map((r) => JSON.stringify(normalizeKeyOrder(r))).join(",\n");
  writeFileSync(path, `[\n${body}\n]\n`);
}

/**
 * レギュレーション落ちしたカードは一覧に出てこないが、詳細ページ自体は生きている。
 * 全件更新のときはこちらも対象に含めたいので、保持中のレコードから疑似的な一覧項目を作る。
 */
function pseudoEntry(card: CardRecord): ListEntry {
  return {
    cardID: card.cardId,
    cardThumbFile: card.imageUrl,
    cardNameAltText: card.nameJp,
    cardNameViewText: card.nameJp,
  };
}

/**
 * 並び順どおりにレコードを組み直し、sortId と standard / extra を付け直す。
 *
 * 印を毎回ここで付け直すので、ローテーションが来ても手で管理する一覧は要らない。
 * 一覧を取れなかったレギュレーションについては前回の値を据え置く。
 */
function compose(
  ids: string[],
  byId: Map<string, CardRecord>,
  liveIds: Set<string>,
  extraIds: Set<string> | null,
): CardRecord[] {
  const out: CardRecord[] = [];
  for (const id of ids) {
    const card = byId.get(id);
    if (!card) continue;
    out.push({
      ...card,
      sortId: out.length + 1,
      standard: liveIds.has(id),
      extra: extraIds ? extraIds.has(id) : (card.extra ?? false),
    });
  }
  return out;
}

/** カード画像の URL に必ず付く頭。索引では落として、読む側で付け直す。 */
const IMAGE_PREFIX = "/assets/images/card_images/large/";

/**
 * デッキ共有ページ用の索引。`{ "48466": ["名前", "M1S/048466_….jpg", "ポケモン"] }`。
 *
 * cardId は**ゼロ詰めを外した数字**にする。共有コードが数値で持っているため。
 * 画像は [IMAGE_PREFIX] を落とす（8,000 件ぶんで 250KB 以上効く）。
 * これで 5MB が 500KB、配信時の gzip 後で 130KB ほどになる。
 */
function serializeCardIndex(cards: CardRecord[]): string {
  const index: Record<string, [string, string, string]> = {};
  for (const card of cards) {
    const id = String(Number(card.cardId));
    const image = String(card.imageUrl ?? "");
    index[id] = [
      String(card.nameJp ?? ""),
      image.startsWith(IMAGE_PREFIX) ? image.slice(IMAGE_PREFIX.length) : image,
      String(card.type ?? ""),
    ];
  }
  return JSON.stringify(index);
}

function serialize(rows: CardRecord[]): string {
  return JSON.stringify(rows.map(normalizeKeyOrder));
}

/**
 * 詳細ページをまとめて取得する。
 * 途中でブロックされてもそれまでに取れた分は捨てずに返す。
 */
async function fetchMany(
  items: ListEntry[],
  onProgress: (done: number, total: number) => void,
): Promise<{ cards: CardRecord[]; blocked: boolean }> {
  const cards: CardRecord[] = [];
  let cursor = 0;
  let done = 0;
  let blocked = false;

  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    for (;;) {
      if (blocked) return;
      const index = cursor++;
      if (index >= items.length) return;
      try {
        cards.push(await fetchCard(items[index]!, 0));
      } catch (err) {
        if (err instanceof BlockedError) {
          blocked = true;
          return;
        }
        throw err;
      }
      done += 1;
      onProgress(done, items.length);
      await sleep(DELAY_MS);
    }
  });
  await Promise.all(runners);
  return { cards, blocked };
}

async function main(): Promise<void> {
  let master = readJson<CardRecord[]>(MASTER, []);
  if (master.length === 0) {
    // 初回は旧 Supabase から吸い出した既存データを土台にする
    master = readJson<CardRecord[]>(SEED, []);
    console.log(`初期化: 既存データ ${master.length} 件を取り込み`);
  }
  const extraMaster = readJson<CardRecord[]>(MASTER_EXTRA, []);
  // 1 枚のカードはどちらか一方にしか入らない。索引は両方を合わせて 1 つ持つ。
  const byId = new Map([...master, ...extraMaster].map((c) => [c.cardId, c]));

  console.log("カード一覧を取得中...");
  const live = uniqueByCardId(await fetchAllListEntries("XY"));
  console.log(`スタンダード ${live.length} 件`);

  // エクストラの一覧。ここで落とすとスタンダードの配信まで止まってしまうので、
  // 取れなければ extra は前回の値のまま据え置き、エクストラ側の更新だけ見送る。
  let extraLive: ListEntry[] | null = null;
  if (WITH_EXTRA) {
    try {
      extraLive = uniqueByCardId(await fetchAllListEntries("BW"));
      console.log(`エクストラ ${extraLive.length} 件`);
    } catch (err) {
      console.warn(`エクストラの一覧を取得できなかったので今回は据え置く: ${err}`);
    }
  }

  const liveIds = new Set(live.map(cardIdOf));
  const extraIds = extraLive ? new Set(extraLive.map(cardIdOf)) : null;

  // cards.json が受け持つ範囲。いま一覧にあるものと、過去に取り込んだものすべて。
  const standardIds = new Set([...liveIds, ...master.map((c) => c.cardId)]);
  // エクストラにしか無いカード。ここが cards-extra.json の中身になる。
  const extraOnly = (extraLive ?? []).filter((e) => !standardIds.has(cardIdOf(e)));

  const progress = readJson<RefreshProgress>(REFRESH_PROGRESS, { startedAt: "", done: [] });
  const alreadyRefreshed = new Set(progress.done);
  // 全件更新は複数回に分けて走らせる。途中で REFRESH_ALL を落とすと進捗が
  // 読まれず、取り直しが半端なまま残り続ける。気づけるように言っておく。
  if (alreadyRefreshed.size > 0 && !REFRESH_ALL && !REFRESH_DIRTY) {
    console.warn(
      `全件更新が ${alreadyRefreshed.size} 件で途中のまま残っている。` +
        "続きを進めるには REFRESH_ALL=1 を付けて実行すること。",
    );
  }

  // 全件更新で回す対象。いま一覧から拾えているものに、一覧から落ちたカードを足す。
  //
  // 落ちたかどうかは「一覧の項目として拾えたか」で見る。スタンダードから落ちて
  // エクストラには残っているカード（2,324 件）は BW 一覧には出てくるが、
  // cards.json 側が受け持つので extraOnly には入らない。両方から漏れるので
  // ここで拾い直さないと、全件更新の対象からまるごと抜け落ちる。
  const covered = new Set([...liveIds, ...extraOnly.map(cardIdOf)]);
  const retainedStandardEntries = master.filter((c) => !covered.has(c.cardId)).map(pseudoEntry);
  const retainedExtraEntries = extraMaster.filter((c) => !covered.has(c.cardId)).map(pseudoEntry);
  // 並び順が効く。スタンダード側を先に片づけないと、エクストラ 12,893 件を
  // 取り終わるまで「未完了」が解けず、version が上がらないままになる。
  const everything = [...live, ...retainedStandardEntries, ...extraOnly, ...retainedExtraEntries];

  let targets: ListEntry[];
  if (REFRESH_ALL) {
    targets = everything.filter((e) => !alreadyRefreshed.has(cardIdOf(e)));
    console.log(
      `全件更新: 対象 ${everything.length} 件中 ${alreadyRefreshed.size} 件が取得済み、残り ${targets.length} 件`,
    );
  } else if (REFRESH_IDS.length > 0) {
    const wanted = new Set(REFRESH_IDS);
    targets = everything.filter((e) => wanted.has(cardIdOf(e)));
    console.log(`指定更新: ${targets.length} 件（指定 ${REFRESH_IDS.length} 件）`);
  } else if (REFRESH_DIRTY) {
    const dirty = new Set([...master, ...extraMaster].filter(hasLegacyArtifacts).map((c) => c.cardId));
    targets = everything.filter((e) => dirty.has(cardIdOf(e)) && !alreadyRefreshed.has(cardIdOf(e)));
    console.log(
      `取りこぼし修復: 該当 ${dirty.size} 件中 ${alreadyRefreshed.size} 件が取得済み、残り ${targets.length} 件`,
    );
  } else {
    // スタンダードの新着を先に取る。エクストラの積み残しに埋もれさせない。
    const newStandard = live.filter((e) => !byId.has(cardIdOf(e)));
    const newExtra = extraOnly.filter((e) => !byId.has(cardIdOf(e)));
    targets = [...newStandard, ...newExtra];
    console.log(`新規カード: スタンダード ${newStandard.length} 件 / エクストラ ${newExtra.length} 件`);
  }
  const trackProgress = REFRESH_ALL || REFRESH_DIRTY;

  const batch = targets.slice(0, MAX_FETCH);
  if (batch.length < targets.length) {
    console.log(`  今回はこのうち ${batch.length} 件を取得する（MAX_FETCH=${MAX_FETCH}）`);
  }

  let blocked = false;
  const fetchedIds = new Set<string>();
  if (batch.length > 0) {
    const result = await fetchMany(batch, (done, total) => {
      if (done % 50 === 0 || done === total) console.log(`  ${done}/${total}`);
    });
    for (const card of result.cards) {
      byId.set(card.cardId, card);
      fetchedIds.add(card.cardId);
    }
    blocked = result.blocked;

    if (trackProgress) {
      progress.startedAt ||= new Date().toISOString();
      progress.done = [...alreadyRefreshed, ...result.cards.map((c) => c.cardId)];
      writeFileSync(REFRESH_PROGRESS, `${JSON.stringify(progress)}\n`);
    }
    if (blocked) {
      console.warn(
        `アクセスを拒否されたため ${result.cards.length} 件で中断した。` +
          "取得済みの分は保存する。残りは次回の実行で再開される。",
      );
    }
  }

  // 取り切れなかった対象を、どちらの配信のものか分けて数える。
  // ここを分けているのが肝で、エクストラの初回取り込み（1 万件以上）が
  // 走っている間もスタンダードの版は今までどおり上がる。
  const leftover = targets.filter((e) => !fetchedIds.has(cardIdOf(e)));
  const standardIncomplete = leftover.some((e) => standardIds.has(cardIdOf(e)));
  const extraIncomplete = leftover.some((e) => !standardIds.has(cardIdOf(e)));

  // 並び順は「今の検索結果の順（新しい弾が先頭）」→「検索から落ちたカードを従来の相対順で後ろに」
  const retainedStandard = master
    .filter((c) => !liveIds.has(c.cardId))
    .sort((a, b) => a.sortId - b.sortId)
    .map((c) => c.cardId);
  const ordered = compose([...live.map(cardIdOf), ...retainedStandard], byId, liveIds, extraIds);

  // エクストラ側も同じ考え方。sortId はこのファイルの中で 1 から数え直す
  // （アプリはどちらも使っておらず、通し番号にすると毎日全行が変わってしまう）。
  const orderedIds = new Set(ordered.map((c) => c.cardId));
  const extraOnlyIds = new Set(extraOnly.map(cardIdOf));
  const retainedExtra = extraMaster
    .filter((c) => !orderedIds.has(c.cardId) && !extraOnlyIds.has(c.cardId))
    .sort((a, b) => a.sortId - b.sortId)
    .map((c) => c.cardId);
  const orderedExtra = compose([...extraOnly.map(cardIdOf), ...retainedExtra], byId, liveIds, extraIds);

  const changed = serialize(master) !== serialize(ordered);
  const extraChanged = serialize(extraMaster) !== serialize(orderedExtra);

  const state = readJson<State>(STATE, { version: 47, updatedAt: "", pendingBump: false });
  // updatedAt 以外の中身を控えておく。下で「この回に何か動いたか」を見るのに使う。
  const stateBefore = JSON.stringify({ ...state, updatedAt: "" });

  // 中途半端な状態でバージョンを上げると、アプリが不完全なデータを全件ダウンロードしてしまう。
  // 取り切るまでは master に書き足すだけにして、完走した回にまとめて 1 つ上げる。
  if (standardIncomplete) {
    if (changed) state.pendingBump = true;
  } else if (changed || state.pendingBump) {
    state.version += 1;
    state.pendingBump = false;
  }

  // エクストラの一覧を取れなかった回は、版の判断材料が無いので何もしない。
  if (extraLive) {
    if (extraIncomplete) {
      if (extraChanged) state.extraPendingBump = true;
    } else if (extraChanged || state.extraPendingBump) {
      state.extraVersion = (state.extraVersion ?? 0) + 1;
      state.extraPendingBump = false;
    }
  }
  if (trackProgress && !standardIncomplete && !extraIncomplete) {
    rmSync(REFRESH_PROGRESS, { force: true });
  }
  // 何か動いた回だけ updatedAt を進める。無条件に書くと、カードに変化が無い日も
  // data/state.json だけ差分が出る。ワークフローの変更判定は data と public の差分を
  // 見ているので、空のコミットが毎晩積まれ、Discord にも中身の伴わない
  // 「カードデータを更新しました」が飛ぶ。実際 v52・v53 でそうなっていた。
  // events.ts では同じ理由で既にこうしてある。
  if (changed || extraChanged || JSON.stringify({ ...state, updatedAt: "" }) !== stateBefore) {
    state.updatedAt = new Date().toISOString();
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeLineDelimitedArray(MASTER, ordered);
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
  // 旧 Supabase の PostgREST と同じ「配列」で返す。アプリ側のレスポンス型を変えずに済む。
  writeFileSync(`${OUT_DIR}/cards.json`, serialize(ordered));
  if (orderedExtra.length > 0 || existsSync(MASTER_EXTRA)) {
    writeLineDelimitedArray(MASTER_EXTRA, orderedExtra);
    writeFileSync(`${OUT_DIR}/cards-extra.json`, serialize(orderedExtra));
  }
  // デッキ共有ページ（public/d/）が名前と絵を引くための索引。
  // 5MB の cards.json をブラウザに読ませるわけにはいかないので、
  // 必要な 3 項目だけに削ったものを別に出す。
  writeFileSync(`${OUT_DIR}/cards-min.json`, serializeCardIndex(ordered));
  if (orderedExtra.length > 0 || existsSync(MASTER_EXTRA)) {
    writeFileSync(`${OUT_DIR}/cards-min-extra.json`, serializeCardIndex(orderedExtra));
  }
  // 旧 Supabase が返していた形（[{"id":1,"version":N}]）に合わせる。
  // iOS 側の Version 型は id を必須にしているため、省くとデコードに失敗する。
  // extraVersion は増やすだけなので、知らないアプリは今までどおり version だけ読む。
  // 0 は「エクストラはまだ揃っていない」＝取りに行かなくてよい、の意。
  writeFileSync(
    `${OUT_DIR}/version.json`,
    JSON.stringify([{ id: 1, version: state.version, extraVersion: state.extraVersion ?? 0 }]),
  );

  // 大会結果は別管理（data/events.json）。カード巡回とは無関係にそのまま配信へ流す。
  if (existsSync(EVENTS)) {
    writeFileSync(`${OUT_DIR}/events.json`, JSON.stringify(readJson<unknown[]>(EVENTS, [])));
  }

  const extraNote =
    orderedExtra.length > 0 || existsSync(MASTER_EXTRA)
      ? ` / エクストラ ${orderedExtra.length} 件, extraVersion=${state.extraVersion ?? 0}${extraIncomplete ? "（未完了）" : ""}`
      : "";

  if (standardIncomplete) {
    console.log(
      `未完了: スタンダード ${ordered.length} 件を保存、version は ${state.version} のまま据え置き${extraNote}`,
    );
    if (blocked) process.exitCode = 75; // EX_TEMPFAIL: 再実行すれば進むことを CI に伝える
    return;
  }

  const added = ordered.length - master.length;
  console.log(
    changed || state.pendingBump
      ? `更新あり: スタンダード ${ordered.length} 件（${added >= 0 ? "+" : ""}${added}）, version=${state.version}${extraNote}`
      : `更新なし: スタンダード ${ordered.length} 件, version=${state.version}${extraNote}`,
  );
  if (blocked) process.exitCode = 75;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
