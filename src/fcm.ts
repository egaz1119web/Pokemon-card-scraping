/**
 * Firebase Cloud Messaging へ 1 通投げるだけの最小の送信部。
 *
 * **なぜ SDK を入れないか。**
 * firebase-admin は依存が大きく、ここでやることは「トピック宛に 1 通」だけ。
 * 認証は JWT を作って access token に交換するだけなので、node:crypto で足りる。
 * src/r2.ts で SigV4 を自前で書いているのと同じ判断。
 *
 * **旧サーバーキー（legacy FCM）は使えない。**
 * `https://fcm.googleapis.com/fcm/send` は 2024 年に停止済み。
 * いまは HTTP v1 で、サービスアカウントの署名が要る。
 *
 * **トークンではなくトピックへ送る。**
 * 端末ごとのトークンを集めると、識別子を預かることになってプライバシーポリシーと
 * ストアの収集申告の話になる。トピックなら購読はアプリ側が勝手にやるので、
 * こちらは誰が受け取るのかを知らないままでいられる。
 */
import { createSign } from "node:crypto";

/** アプリ側が購読するトピック名。Android / iOS の CardUpdateTopic と揃えること。 */
export const TOPIC = "card-update";

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

function serviceAccountFromEnv(): ServiceAccount {
  const raw = process.env.FCM_SERVICE_ACCOUNT;
  if (!raw) throw new Error("環境変数 FCM_SERVICE_ACCOUNT が無い");
  const sa = JSON.parse(raw) as ServiceAccount;
  for (const key of ["project_id", "client_email", "private_key"] as const) {
    if (!sa[key]) throw new Error(`FCM_SERVICE_ACCOUNT に ${key} が無い`);
  }
  return sa;
}

const base64url = (input: string | Buffer): string =>
  Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** サービスアカウントの鍵で署名した JWT を、access token に交換する。 */
async function accessToken(sa: ServiceAccount): Promise<string> {
  const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    }),
  );
  // Secrets に JSON をそのまま入れると改行が \n の 2 文字で入ることがある。
  // PEM は改行が無いと読めないので戻す。
  const privateKey = sa.private_key.replace(/\\n/g, "\n");
  const signature = base64url(createSign("RSA-SHA256").update(`${header}.${claim}`).sign(privateKey));

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claim}.${signature}`,
    }),
  });
  if (!res.ok) {
    throw new Error(`access token の取得に失敗 (HTTP ${res.status}): ${await res.text()}`);
  }
  return ((await res.json()) as { access_token: string }).access_token;
}

export interface Push {
  title: string;
  body: string;
  /**
   * タップしたときにアプリへ渡す値。**すべて文字列でなければならない**（FCM の仕様）。
   * いまは絞り込みたい収録名を `pack` で渡している。
   */
  data?: Record<string, string>;
}

/**
 * 通知を 1 通送る。
 *
 * @param dryRun 組み立てた中身を表示するだけで、実際には送らない。
 *   文面を確かめたいときに使う（誤爆すると取り消せないため）。
 * @param token 指定すると、トピックではなく**その端末 1 台だけ**へ送る。
 *   本番と同じ経路（JWT → access token → FCM）を通したまま、届く先だけを絞れる。
 *   端末のトークンはアプリが起動時にログへ出している。
 */
export async function sendToTopic(
  push: Push,
  { dryRun = false, token }: { dryRun?: boolean; token?: string } = {},
): Promise<void> {
  const message = {
    ...(token ? { token } : { topic: TOPIC }),
    notification: { title: push.title, body: push.body },
    ...(push.data ? { data: push.data } : {}),
    android: {
      // 通知そのものより、開いた先で新着を見てもらうのが目的なので既定の重要度でよい。
      notification: { channel_id: "card_update" },
    },
    apns: {
      payload: { aps: { sound: "default" } },
    },
  };

  if (dryRun) {
    console.log("（下書き。送信しない）");
    console.log(JSON.stringify(message, null, 2));
    return;
  }

  const sa = serviceAccountFromEnv();
  const bearer = await accessToken(sa);
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    },
  );
  if (!res.ok) {
    throw new Error(`通知の送信に失敗 (HTTP ${res.status}): ${await res.text()}`);
  }
  console.log(`通知を送った（宛先 ${token ? "端末 1 台" : `トピック ${TOPIC}`}）: ${push.title} / ${push.body}`);
}
