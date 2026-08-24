/**
 * 全件更新後のデータを旧 Supabase のデータと突き合わせる。
 * validate.ts と違いネットワークを使わず、生成済みの data/cards.json を見る。
 */
import { readFileSync } from "node:fs";
import { changeEneName, cleanText } from "./energy.js";
import type { CardRecord } from "./types.js";
import { CARD_KEYS } from "./types.js";

const golden = JSON.parse(readFileSync("data/golden_allCard.json", "utf8")) as CardRecord[];
const current = JSON.parse(readFileSync("data/cards.json", "utf8")) as CardRecord[];
const byId = new Map(current.map((c) => [c.cardId, c]));

const exact: Record<string, number> = {};
const cleaned: Record<string, number> = {};
const diff: Record<string, { id: string; name: string; a: string; b: string }[]> = {};

for (const want of golden) {
  const got = byId.get(want.cardId);
  if (!got) {
    (diff["__missing__"] ??= []).push({ id: want.cardId, name: want.nameJp, a: "存在", b: "無し" });
    continue;
  }
  for (const key of CARD_KEYS) {
    if (key === "sortId") continue;
    const a = String(want[key] ?? "");
    const b = String(got[key] ?? "");
    if (a === b) exact[key] = (exact[key] ?? 0) + 1;
    else if (cleanText(changeEneName(a)) === b) cleaned[key] = (cleaned[key] ?? 0) + 1;
    else (diff[key] ??= []).push({ id: want.cardId, name: want.nameJp, a, b });
  }
}

console.log(`旧データ ${golden.length} 件 / 現データ ${current.length} 件`);
console.log(`完全一致: ${Object.values(exact).reduce((x, y) => x + y, 0)}`);
console.log(`既知バグ修正による差: ${Object.values(cleaned).reduce((x, y) => x + y, 0)}`, cleaned);
const total = Object.values(diff).reduce((x, y) => x + y.length, 0);
console.log(`その他の差: ${total}`);
for (const [field, rows] of Object.entries(diff).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n### ${field}: ${rows.length} 件`);
  for (const r of rows.slice(0, 4)) {
    console.log(`  ${r.id} ${r.name}`);
    console.log(`    旧: ${JSON.stringify(r.a).slice(0, 130)}`);
    console.log(`    新: ${JSON.stringify(r.b).slice(0, 130)}`);
  }
}
