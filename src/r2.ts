/**
 * R2 に置く・R2 の中身を数えるだけの、最小限の S3 互換クライアント。
 *
 * **なぜ SDK を入れないか。**
 * @aws-sdk/client-s3 は依存が 100 を超える。このリポジトリが R2 に対してやることは
 * 「一覧」と「置く」の 2 つだけで、そのために毎日の Actions の npm ci を重くしたくない。
 * SigV4 の署名は node:crypto だけで書ける量なので、ここに閉じ込めてある。
 *
 * **wrangler r2 object put を回さない理由。**
 * 2 万件をコマンドで 1 件ずつ置くと、毎回プロセスが起きて認証をやり直すので
 * 1 件 1 秒近くかかる。それだけで 6 時間になり、公式サイトから取る時間と
 * 二重に効いてジョブの上限を越える。
 */
import { createHash, createHmac } from "node:crypto";

const SERVICE = "s3";
const REGION = "auto"; // R2 は region を見ないが、署名の scope には必要

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function r2ConfigFromEnv(): R2Config {
  const need = (name: string): string => {
    const v = process.env[name];
    if (!v) throw new Error(`環境変数 ${name} が無い`);
    return v;
  };
  return {
    accountId: need("R2_ACCOUNT_ID"),
    accessKeyId: need("R2_ACCESS_KEY_ID"),
    secretAccessKey: need("R2_SECRET_ACCESS_KEY"),
    bucket: need("R2_BUCKET"),
  };
}

const sha256hex = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

const hmac = (key: Buffer, data: string): Buffer =>
  createHmac("sha256", key).update(data).digest();

/**
 * RFC 3986 の encodeURIComponent。JavaScript の既定は ! ' ( ) * を残すが、
 * AWS の正規化はこれらも %XX にすることを求める。ここがずれると署名が合わない。
 */
function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** パスは区切りの / を残したまま、各区間だけを符号化する。 */
const encodePath = (path: string): string => path.split("/").map(uriEncode).join("/");

interface SignedRequest {
  method: "GET" | "PUT";
  /** バケットより下の鍵。先頭の / は付けない。 */
  key?: string;
  query?: Record<string, string>;
  body?: Buffer;
  contentType?: string;
  /** x-amz-* 以外で署名に含めたいもの。 */
  extraHeaders?: Record<string, string>;
}

async function send(cfg: R2Config, req: SignedRequest): Promise<Response> {
  const host = `${cfg.accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${cfg.bucket}${req.key ? `/${encodePath(req.key)}` : ""}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20260905T064300Z
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(req.body ?? "");

  // 署名に使う名前は必ず小文字にする。大文字が混ざると、下の並べ替えで
  // 小文字にした名前で引けなくなり、値が undefined のまま署名されて 403 になる。
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(req.contentType ? { "content-type": req.contentType } : {}),
    ...(req.extraHeaders ?? {}),
  })) {
    headers[k.toLowerCase()] = v;
  }

  // 正規化ヘッダは名前で辞書順に並べ、値の前後の空白を落とす。
  const sortedNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedNames
    .map((n) => `${n}:${String(headers[n]).trim()}\n`)
    .join("");
  const signedHeaders = sortedNames.join(";");

  // クエリも名前で辞書順。値も符号化してから並べる。
  const canonicalQuery = Object.entries(req.query ?? {})
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalRequest = [
    req.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256hex(canonicalRequest),
  ].join("\n");

  let signingKey: Buffer = Buffer.from(`AWS4${cfg.secretAccessKey}`, "utf8");
  for (const part of [dateStamp, REGION, SERVICE, "aws4_request"]) {
    signingKey = hmac(signingKey, part);
  }
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `https://${host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
  // host は fetch が自分で付けるので渡さない。渡すと環境によっては弾かれる。
  const { host: _host, ...sendHeaders } = headers;
  return fetch(url, {
    method: req.method,
    headers: { ...sendHeaders, Authorization: authorization },
    // tsconfig の lib に DOM が入っている（build.ts が page.evaluate を使うため）ので、
    // BodyInit がブラウザ側の定義になり Node の Buffer を受け付けない。
    // 実行時は問題なく送れるため、ここだけ型を黙らせる。
    body: req.body as unknown as BodyInit | undefined,
  });
}

/**
 * バケットにある鍵をすべて集める。
 *
 * **進捗ファイルを持たずにここを毎回読むのは意図的。**
 * 取り込みは何日かに分かれるうえ、途中で失敗もする。別に進捗を書くと
 * 「ファイルには済みと書いてあるが R2 には無い」がいつか必ず起きる。
 * 置いた先そのものを正とすれば、その食い違いが原理的に発生しない。
 * 2 万件でも 1000 件ずつ 22 回で、Class B の無料枠 1000 万に対して誤差。
 */
export async function listKeys(cfg: R2Config): Promise<Set<string>> {
  const keys = new Set<string>();
  let token: string | undefined;
  do {
    const query: Record<string, string> = { "list-type": "2", "max-keys": "1000" };
    if (token) query["continuation-token"] = token;
    const res = await send(cfg, { method: "GET", query });
    if (!res.ok) {
      throw new Error(`R2 の一覧に失敗 (HTTP ${res.status}): ${await res.text()}`);
    }
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
      const key = m[1];
      if (key) keys.add(decodeXml(key));
    }
    const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1];
    token = next ? decodeXml(next) : undefined;
  } while (token);
  return keys;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export async function putObject(
  cfg: R2Config,
  key: string,
  body: Buffer,
  { contentType, cacheControl }: { contentType: string; cacheControl: string },
): Promise<void> {
  const res = await send(cfg, {
    method: "PUT",
    key,
    body,
    contentType,
    extraHeaders: { "cache-control": cacheControl },
  });
  if (!res.ok) {
    throw new Error(`R2 への保存に失敗 (HTTP ${res.status}) ${key}: ${await res.text()}`);
  }
}
