/**
 * 移植の正しさを実データで確かめるためのスクリプト。
 *
 * 旧 Supabase から吸い出した既存 7,831 件（data/golden_allCard.json）のうち
 * 今も検索に出てくるカードを標本抽出して取得し直し、フィールド単位で突き合わせる。
 *
 * 旧データには GAS 由来の既知バグ（\r 残り・エネルギーアイコン未置換・<br /> 残り）が
 * 含まれているので、そこだけの差は "既知バグの修正" として分けて数える。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { changeEneName, cleanText } from "./energy.js";
import { fetchCard } from "./detail.js";
import { fetchAllListEntries, cardIdOf } from "./list.js";
import { sleep } from "./http.js";
import type { CardRecord, ListEntry } from "./types.js";
import { CARD_KEYS } from "./types.js";

const SAMPLE_SIZE = Number(process.env.SAMPLE_SIZE ?? 150);
const CACHE = "data/.cache/live.json";

/** 実行ごとに標本が変わると再現できないので、seed 固定の擬似乱数を使う */
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function loadLive(): Promise<ListEntry[]> {
  if (existsSync(CACHE)) return JSON.parse(readFileSync(CACHE, "utf8")) as ListEntry[];
  const entries = await fetchAllListEntries();
  mkdirSync("data/.cache", { recursive: true });
  writeFileSync(CACHE, JSON.stringify(entries));
  return entries;
}

function comparable(value: string): string {
  return cleanText(changeEneName(value));
}

async function main(): Promise<void> {
  const golden = JSON.parse(readFileSync("data/golden_allCard.json", "utf8")) as CardRecord[];
  const goldenById = new Map(golden.map((r) => [r.cardId, r]));
  const live = await loadLive();

  // 旧データにも存在するカードだけが比較対象になる
  const shared = live.filter((e) => goldenById.has(cardIdOf(e)));
  const rand = mulberry32(20260824);
  const shuffled = [...shared].sort(() => rand() - 0.5).slice(0, SAMPLE_SIZE);

  const exact: Record<string, number> = {};
  const knownBugFixed: Record<string, number> = {};
  const real: { cardId: string; name: string; field: string; golden: string; got: string }[] = [];

  for (const [n, entry] of shuffled.entries()) {
    const id = cardIdOf(entry);
    const want = goldenById.get(id)!;
    const got = await fetchCard(entry, want.sortId);

    for (const key of CARD_KEYS) {
      // sortId は並び順、standard / extra は一覧との突き合わせで決まる値。旧データには無い。
      if (key === "sortId" || key === "standard" || key === "extra") continue;
      const a = String(want[key] ?? "");
      const b = String(got[key] ?? "");
      if (a === b) {
        exact[key] = (exact[key] ?? 0) + 1;
      } else if (comparable(a) === b) {
        knownBugFixed[key] = (knownBugFixed[key] ?? 0) + 1;
      } else {
        real.push({ cardId: id, name: want.nameJp, field: key, golden: a, got: b });
      }
    }
    if ((n + 1) % 25 === 0) process.stderr.write(`  ${n + 1}/${shuffled.length}\n`);
    await sleep(400);
  }

  console.log(`\n標本 ${shuffled.length} 件 / 比較フィールド ${CARD_KEYS.length - 1}`);
  console.log(`完全一致: ${Object.values(exact).reduce((a, b) => a + b, 0)}`);
  console.log(`既知バグの修正による差: ${Object.values(knownBugFixed).reduce((a, b) => a + b, 0)}`, knownBugFixed);
  console.log(`未説明の差: ${real.length}`);

  const byField = new Map<string, typeof real>();
  for (const r of real) {
    if (!byField.has(r.field)) byField.set(r.field, []);
    byField.get(r.field)!.push(r);
  }
  for (const [field, rows] of [...byField.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n### ${field}: ${rows.length} 件`);
    for (const r of rows.slice(0, 3)) {
      console.log(`  ${r.cardId} ${r.name}`);
      console.log(`    旧: ${JSON.stringify(r.golden).slice(0, 160)}`);
      console.log(`    新: ${JSON.stringify(r.got).slice(0, 160)}`);
    }
  }
  writeFileSync("data/.cache/validate-report.json", JSON.stringify(real, null, 1));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
