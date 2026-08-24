/**
 * カードデータを更新して配信用の JSON を書き出す。
 *
 * 方針として「積み上げ式」を採る。スタンダード（XY）の検索結果は
 * レギュレーション落ちで減っていくが、ユーザーの保存デッキは落ちたカードも
 * 参照しているため、一度取り込んだカードは消さない。
 * 実際、移行時点の 7,831 件のうち 2,991 件は今の検索結果には出てこない。
 *
 * 公式サイトには WAF が入っており、速く叩きすぎると IP 単位で 403 になる。
 * そのため 1 回の実行量に上限を設け、途中で拒否されても取れた分は保存して
 * 次回の実行で続きから再開する作りにしてある。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { fetchCard } from "./detail.js";
import { fetchAllListEntries, cardIdOf } from "./list.js";
import { sleep, BlockedError } from "./http.js";
import type { CardRecord, ListEntry, State } from "./types.js";
import { normalizeKeyOrder } from "./types.js";

const MASTER = "data/cards.json";
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

/** 本文に HTML タグや \r が残っている＝旧パーサの取りこぼし */
function hasLegacyArtifacts(card: CardRecord): boolean {
  const fields = [card.ability, card.tech1Ability, card.tech2Ability, card.trainerAbility];
  return fields.some((v) => v != null && (v.includes("<") || v.includes("\r")));
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
  const body = rows.map((r) => JSON.stringify(normalizeKeyOrder(r))).join(",\n");
  writeFileSync(path, `[\n${body}\n]\n`);
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
  const byId = new Map(master.map((c) => [c.cardId, c]));

  console.log("カード一覧を取得中...");
  const liveRaw = await fetchAllListEntries();

  // 基本闘 / 基本悪エネルギーのように複数 cardID が同一画像を指すことがあるため、先頭を採用して重複を落とす
  const live: ListEntry[] = [];
  const seen = new Set<string>();
  for (const entry of liveRaw) {
    const id = cardIdOf(entry);
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    live.push(entry);
  }
  console.log(`一覧 ${liveRaw.length} 件 → 重複除去後 ${live.length} 件`);

  // レギュレーション落ちしたカードは一覧に出てこないが、詳細ページ自体は生きている。
  // 全件更新のときはこちらも対象に含めたいので、保持中のレコードから疑似的な一覧項目を作る。
  const retainedEntries: ListEntry[] = master
    .filter((c) => !seen.has(c.cardId))
    .map((c) => ({
      cardID: c.cardId,
      cardThumbFile: c.imageUrl,
      cardNameAltText: c.nameJp,
      cardNameViewText: c.nameJp,
    }));

  const progress = readJson<RefreshProgress>(REFRESH_PROGRESS, { startedAt: "", done: [] });
  const alreadyRefreshed = new Set(progress.done);

  const everything = [...live, ...retainedEntries];
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
    const dirty = new Set(master.filter(hasLegacyArtifacts).map((c) => c.cardId));
    targets = everything.filter((e) => dirty.has(cardIdOf(e)) && !alreadyRefreshed.has(cardIdOf(e)));
    console.log(
      `取りこぼし修復: 該当 ${dirty.size} 件中 ${alreadyRefreshed.size} 件が取得済み、残り ${targets.length} 件`,
    );
  } else {
    targets = live.filter((e) => !byId.has(cardIdOf(e)));
    console.log(`新規カード: ${targets.length} 件`);
  }
  const trackProgress = REFRESH_ALL || REFRESH_DIRTY;

  const batch = targets.slice(0, MAX_FETCH);
  if (batch.length < targets.length) {
    console.log(`  今回はこのうち ${batch.length} 件を取得する（MAX_FETCH=${MAX_FETCH}）`);
  }

  let blocked = false;
  if (batch.length > 0) {
    const result = await fetchMany(batch, (done, total) => {
      if (done % 50 === 0 || done === total) console.log(`  ${done}/${total}`);
    });
    for (const card of result.cards) byId.set(card.cardId, card);
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

  // まだ取り切れていない対象が残っているか
  const incomplete = blocked || batch.length < targets.length;

  // 並び順は「今の検索結果の順（新しい弾が先頭）」→「検索から落ちたカードを従来の相対順で後ろに」
  const liveIds = live.map(cardIdOf);
  const liveIdSet = new Set(liveIds);
  const retained = master
    .filter((c) => !liveIdSet.has(c.cardId))
    .sort((a, b) => a.sortId - b.sortId)
    .map((c) => c.cardId);

  const ordered: CardRecord[] = [];
  for (const id of [...liveIds, ...retained]) {
    const card = byId.get(id);
    if (card) ordered.push({ ...card, sortId: ordered.length + 1 });
  }

  const changed =
    JSON.stringify(master.map(normalizeKeyOrder)) !== JSON.stringify(ordered.map(normalizeKeyOrder));

  const state = readJson<State>(STATE, { version: 47, updatedAt: "", pendingBump: false });

  // 中途半端な状態でバージョンを上げると、アプリが不完全なデータを全件ダウンロードしてしまう。
  // 取り切るまでは master に書き足すだけにして、完走した回にまとめて 1 つ上げる。
  if (incomplete) {
    if (changed) state.pendingBump = true;
  } else if (changed || state.pendingBump) {
    state.version += 1;
    state.pendingBump = false;
    if (trackProgress) rmSync(REFRESH_PROGRESS, { force: true });
  }
  state.updatedAt = new Date().toISOString();

  mkdirSync(OUT_DIR, { recursive: true });
  writeLineDelimitedArray(MASTER, ordered);
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
  // 旧 Supabase の PostgREST と同じ「配列」で返す。アプリ側のレスポンス型を変えずに済む。
  writeFileSync(`${OUT_DIR}/cards.json`, JSON.stringify(ordered.map(normalizeKeyOrder)));
  writeFileSync(`${OUT_DIR}/version.json`, JSON.stringify([{ version: state.version }]));

  // 大会結果は別管理（data/events.json）。カード巡回とは無関係にそのまま配信へ流す。
  if (existsSync(EVENTS)) {
    writeFileSync(`${OUT_DIR}/events.json`, JSON.stringify(readJson<unknown[]>(EVENTS, [])));
  }

  if (incomplete) {
    console.log(`未完了: 全 ${ordered.length} 件を保存、version は ${state.version} のまま据え置き`);
    if (blocked) process.exitCode = 75; // EX_TEMPFAIL: 再実行すれば進むことを CI に伝える
    return;
  }

  const added = ordered.length - master.length;
  console.log(
    changed || state.pendingBump
      ? `更新あり: 全 ${ordered.length} 件（${added >= 0 ? "+" : ""}${added}）, version=${state.version}`
      : `更新なし: 全 ${ordered.length} 件, version=${state.version}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
