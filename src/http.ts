const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const ORIGIN = "https://www.pokemon-card.com";

/**
 * アクセス制限に当たったことを表す。
 * 403 は一時的な失敗ではなく IP 単位のブロックなので、
 * 再試行すると状況を悪くするだけ。呼び出し側で即座に手を引くために型で区別する。
 */
export class BlockedError extends Error {
  constructor(url: string) {
    super(`アクセスを拒否された (403): ${url}`);
    this.name = "BlockedError";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 取得失敗時に指数バックオフで再試行する fetch。
 * 相手は個人サイトではないとはいえ公式サイトなので、既定値は控えめにしてある。
 */
export async function fetchText(
  url: string,
  { retries = 4, timeoutMs = 30_000 }: { retries?: number; timeoutMs?: number } = {},
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: {
          "User-Agent": UA,
          "Accept-Language": "ja,en;q=0.9",
          "X-Requested-With": "XMLHttpRequest",
          Referer: `${ORIGIN}/card-search/index.php`,
        },
      });
      if (res.status === 403) throw new BlockedError(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      if (err instanceof BlockedError) throw err;
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`fetch failed after ${retries + 1} attempts: ${url}`, { cause: lastErr });
}

export async function fetchJson<T>(url: string): Promise<T> {
  return JSON.parse(await fetchText(url)) as T;
}
