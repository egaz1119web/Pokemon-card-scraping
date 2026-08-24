/**
 * 大会結果（シティリーグなど）を取得して配信用の JSON を書き出す。
 *
 * カードデータと違い、こちらは GitHub Actions では動かせない。
 * players.pokemon-card.com は TLS フィンガープリントとデータセンター IP の
 * 両方を見ており、実測では次のようになった（2026-08-24）:
 *
 *                        curl    実ブラウザ
 *   自宅回線              403      200
 *   Actions (Azure)       403      403
 *
 * そのため自宅のラズパイから実ブラウザで動かす。Playwright は ARM64 Linux 向けの
 * Chromium を配布しないので、OS の Chromium を executablePath で指定する。
 *
 * UA を明示しないと headless 既定の "HeadlessChrome" を含む UA が送られて
 * 弾かれる。ここは必ず設定すること。
 *
 * デッキの中身は www.pokemon-card.com 側にあり、こちらは素の fetch で取れる。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { sleep } from "./http.js";

const EVENTS = "data/events.json";
const STATE = "data/events-state.json";
const OUT = "public/events.json";

const CHROMIUM_PATH = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium";
const UA =
  process.env.EVENT_UA ??
  "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
/** 一覧を何ページ分さかのぼるか（1 ページ 20 件） */
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 3);
/** 保持する最大件数。旧 GAS も 1000 件で打ち切っていた。 */
const MAX_ROWS = Number(process.env.MAX_ROWS ?? 1000);
/**
 * 取得済みとして記録するだけで詳細は取りに行かない。
 * 「過去の欠損は追わず、今後の新規分だけ拾う」ための基準点づくりに使う。
 */
const BOOTSTRAP = process.env.BOOTSTRAP === "1";
/**
 * 取得済みリストを events.json の中身から作り直す。
 *
 * BOOTSTRAP は「いま見えているものを取得済みとして記録するだけ」なので、
 * 詳細を持っていないのに取得済みになった ID が残る。基準点を作った時点で
 * 一覧に並んでいたものは、そのままだと二度と取りに行かない。
 * 一覧が更新されない時期に基準点を作ると、その分がまるごと落ちる。
 * 取りこぼしに気づいたらこれで取得済みを実データに合わせ直す。
 */
const RESYNC = process.env.RESYNC === "1";

const LIST_QUERY =
  "offset=0&order=4&result_resist=1&event_type[]=3:1&event_type[]=3:2&event_type[]=3:7";

export interface EventRecord {
  eventId: number;
  date: string;
  title: string;
  shop: string;
  league: string;
  [deck: string]: string | number;
}

interface ListEntry {
  eventId: number;
  date: string;
  title: string;
  shop: string;
  league: string;
}

interface EventsState {
  knownEventIds: number[];
  updatedAt: string;
}

function readJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
}

/** "20260506" + "水" → "2026年05月06日(水)"（既存データと同じ表記） */
function formatDate(params: string, week: string): string {
  return `${params.slice(0, 4)}年${params.slice(4, 6)}月${params.slice(6, 8)}日(${week})`;
}

async function openBrowser(): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = await browser.newPage({ locale: "ja-JP", userAgent: UA });
  const res = await page.goto("https://players.pokemon-card.com/event/result/list", {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  if (res?.status() !== 200) {
    await browser.close();
    throw new Error(`一覧ページに到達できない (HTTP ${res?.status()})。ボット対策に当たっている可能性が高い。`);
  }
  return { browser, page };
}

/** 一覧 API はページ内 fetch で叩く。ブラウザの文脈から出ると弾かれるため。 */
async function fetchListPage(page: Page, offset: number): Promise<ListEntry[]> {
  const query = LIST_QUERY.replace("offset=0", `offset=${offset}`);
  const rows = await page.evaluate(async (q) => {
    const r = await fetch(`/event_search?${q}`);
    if (r.status !== 200) return { error: r.status, events: [] as unknown[] };
    const j = (await r.json()) as { event?: unknown[] };
    return { error: 0, events: j.event ?? [] };
  }, query);

  if (rows.error) throw new Error(`event_search が HTTP ${rows.error} を返した`);

  return (rows.events as Record<string, unknown>[]).map((e) => ({
    eventId: Number(e["event_holding_id"]),
    date: formatDate(String(e["event_date_params"]), String(e["event_date_week"])),
    title: String(e["event_title"]),
    // 公式主催のイベントは shop_name が空になる
    shop: (e["shop_name"] as string) || "株式会社ポケモン",
    league: String(e["leagueName"] ?? ""),
  }));
}

/** 詳細ページから上位 8 名のデッキ ID を取る。CSS セレクタなので DOM の小変更に強い。 */
async function fetchDeckIds(page: Page, eventId: number): Promise<string[]> {
  const res = await page.goto(`https://players.pokemon-card.com/event/detail/${eventId}/result`, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  if (res?.status() !== 200) return [];
  return page.evaluate(() => {
    const anchors = Array.prototype.slice.call(
      document.querySelectorAll('a[href*="deck/confirm.html/deckID/"]'),
    ) as HTMLAnchorElement[];
    const ids = anchors.map((a) => a.href.split("deckID/")[1]!.replace(/\/$/, ""));
    return Array.from(new Set(ids));
  });
}

/**
 * デッキの代表カード画像を取る。こちら（www 側）はボット対策が無く素の fetch で通る。
 * ページ内に PCGDECK.searchItemCardPict[...] という形で埋まっている。
 */
async function fetchDeckImage(deckId: string): Promise<string> {
  const res = await fetch(`https://www.pokemon-card.com/deck/confirm.html/deckID/${deckId}`, {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) return "";
  const lines = (await res.text()).split(/\r?\n/);
  const index = lines.findIndex((l) => l.includes("searchItemNameAlt"));
  if (index === -1) return "";
  const next = lines[index + 1] ?? "";
  const start = next.indexOf("='");
  const end = next.indexOf("';", start);
  return start >= 0 && end >= 0 ? next.slice(start + 2, end) : "";
}

const DECK_KEYS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];

async function main(): Promise<void> {
  const existing = readJson<EventRecord[]>(EVENTS, []);
  const state = readJson<EventsState>(STATE, { knownEventIds: [], updatedAt: "" });

  // 初回は既存データの ID を取得済みとして取り込む
  const known = RESYNC
    ? new Set<number>(existing.map((r) => Number(r.eventId)))
    : new Set<number>([...state.knownEventIds, ...existing.map((r) => Number(r.eventId))]);
  if (RESYNC) {
    const dropped = state.knownEventIds.filter((id) => !known.has(id)).length;
    console.log(`取得済みリストを作り直す: ${dropped} 件を未取得に戻す`);
  }
  console.log(`既存 ${existing.length} 件 / 取得済み ID ${known.size} 件`);

  const { browser, page } = await openBrowser();
  const added: EventRecord[] = [];

  try {
    const candidates: ListEntry[] = [];
    for (let p = 0; p < MAX_PAGES; p++) {
      const rows = await fetchListPage(page, p * 20);
      if (rows.length === 0) break;
      const fresh = rows.filter((r) => !known.has(r.eventId));
      candidates.push(...fresh);
      console.log(`  一覧 ${p + 1} ページ目: ${rows.length} 件中 ${fresh.length} 件が未取得`);
      // 日付降順なので、1 ページまるごと既知になったらそれ以上は遡らない
      if (fresh.length === 0) break;
      await sleep(2000);
    }

    if (BOOTSTRAP) {
      // 詳細は取らず、いま見えているものを「取得済み」として記録するだけ。
      // これ以降に登録された分から拾い始める。
      for (const c of candidates) known.add(c.eventId);
      console.log(`基準点を設定: ${candidates.length} 件を取得済みとして記録（詳細は取得しない）`);
    } else {
      console.log(`詳細を取得する対象: ${candidates.length} 件`);
      for (const [i, entry] of candidates.entries()) {
        await sleep(3000);
        const deckIds = await fetchDeckIds(page, entry.eventId);
        known.add(entry.eventId);

        // 旧仕様に合わせ、上位 8 名分がそろっていないイベントは取り込まない
        if (deckIds.length < 8) {
          console.log(`  [${i + 1}/${candidates.length}] ${entry.title}: デッキ ${deckIds.length} 件のため見送り`);
          continue;
        }

        const record: EventRecord = { ...entry };
        for (const [n, key] of DECK_KEYS.entries()) {
          const deckId = deckIds[n]!;
          record[`${key}Image`] = await fetchDeckImage(deckId);
          record[key] = deckId;
          await sleep(1000);
        }
        added.push(record);
        console.log(`  [${i + 1}/${candidates.length}] ${entry.date} ${entry.title} (${entry.shop})`);
      }
    }
  } finally {
    await browser.close();
  }

  // 既存とマージし、日付の降順（同日は eventId 降順）で並べて上限で切る
  const merged = [...added, ...existing]
    .sort((a, b) => (a.date === b.date ? Number(b.eventId) - Number(a.eventId) : a.date < b.date ? 1 : -1))
    .slice(0, MAX_ROWS);

  mkdirSync("public", { recursive: true });
  writeFileSync(EVENTS, `${JSON.stringify(merged, null, 1)}\n`);
  writeFileSync(OUT, JSON.stringify(merged));
  // 取得済み ID が増えたときだけ書く。
  // 毎回 updatedAt を更新すると、中身が変わっていない日も差分が出て
  // 空のコミットが毎日積まれてしまう。
  const nextKnown = [...known].sort((a, b) => b - a).slice(0, 5000);
  if (JSON.stringify(nextKnown) !== JSON.stringify(state.knownEventIds)) {
    writeFileSync(
      STATE,
      `${JSON.stringify({ knownEventIds: nextKnown, updatedAt: new Date().toISOString() }, null, 1)}\n`,
    );
  }

  console.log(added.length > 0 ? `追加 ${added.length} 件 / 全 ${merged.length} 件` : `追加なし / 全 ${merged.length} 件`);
  // 呼び出し側（scripts/pi-events.sh）が「実際に増えたのか」を判別するために出す。
  // 取得済みリストだけが変わった回を「更新」と呼ぶと通知が嘘になる。
  console.log(`__ADDED__ ${added.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
