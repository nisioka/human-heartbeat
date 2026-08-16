/**
 * 通知アダプタ。
 *
 * healthchecks.io の Webhook を受け、対応表（src/routes.ts）を引いて Discord へ流すだけ。
 * 状態は持たず、無音判定もしない。それらは healthchecks.io 側の責務（設計 §6）。
 */

import { postToDiscord } from './discord';
import {
  deliveryFailureText,
  route,
  type Audience,
  type Delivery,
  type Payload,
} from './routes';

export interface Env {
  /** healthchecks.io 側のカスタムヘッダで付与する共有シークレット */
  HOOK_SECRET: string;
  /** 一次受信者向け Discord Webhook URL */
  DISCORD_WEBHOOK_PRIMARY: string;
  /** 運用者向け Discord Webhook URL。フォールバック先も兼ねる */
  DISCORD_WEBHOOK_OPERATOR: string;
  /** 通知文面に出す運用者の呼称 */
  OPERATOR_NAME?: string;
}

const HOOK_PATH = '/hook';
const SECRET_HEADER = 'x-deadman-secret';

/** ペイロードから値を拾うときの候補キー。名前の食い違いで沈黙しないよう緩く受ける（設計 §6）。 */
const EVENT_KEYS = ['event', 'name', 'check', 'check_name'];
const STATUS_KEYS = ['status', 'state'];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== HOOK_PATH) {
      return new Response('not found\n', { status: 404 });
    }
    if (request.method !== 'POST') {
      return new Response('method not allowed\n', {
        status: 405,
        headers: { allow: 'POST' },
      });
    }

    const missing = missingConfig(env);
    if (missing.length > 0) {
      console.error(`設定が不足しています: ${missing.join(', ')}`);
      return new Response('misconfigured\n', { status: 500 });
    }

    // 認証失敗の理由は返さない。長さの違いだけは早期に返るが、
    // 秘密の推測に使える情報ではないため許容する。
    if (!timingSafeEqual(request.headers.get(SECRET_HEADER) ?? '', env.HOOK_SECRET)) {
      return new Response('unauthorized\n', { status: 401 });
    }

    const raw = await request.text();
    const payload = parsePayload(raw, new Date());
    const deliveries = route(payload, { operatorName: env.OPERATOR_NAME || '運用者' });

    const failures = await deliverAll(deliveries, env);
    if (failures.length === 0) {
      return new Response('ok\n', { status: 200 });
    }

    for (const failure of failures) {
      console.error(`配信失敗 audience=${failure.audience}: ${failure.reason}`);
    }
    // 運用者にも届かないところまで壊れている可能性があるので best-effort。
    // いずれにせよ 502 を返し、healthchecks.io 側に失敗を記録させる。
    await postToDiscord(env.DISCORD_WEBHOOK_OPERATOR, deliveryFailureText(failures, payload)).catch(
      (error: unknown) => {
        console.error(`フォールバック通知にも失敗: ${describeError(error)}`);
      },
    );
    return new Response('delivery failed\n', { status: 502 });
  },
};

interface Failure {
  audience: Audience;
  reason: string;
}

async function deliverAll(deliveries: Delivery[], env: Env): Promise<Failure[]> {
  const results = await Promise.all(
    deliveries.map(async (delivery): Promise<Failure | null> => {
      try {
        await postToDiscord(webhookFor(delivery.audience, env), delivery.text);
        return null;
      } catch (error: unknown) {
        return { audience: delivery.audience, reason: describeError(error) };
      }
    }),
  );
  return results.filter((result): result is Failure => result !== null);
}

function webhookFor(audience: Audience, env: Env): string {
  return audience === 'primary' ? env.DISCORD_WEBHOOK_PRIMARY : env.DISCORD_WEBHOOK_OPERATOR;
}

function missingConfig(env: Env): string[] {
  return (['HOOK_SECRET', 'DISCORD_WEBHOOK_PRIMARY', 'DISCORD_WEBHOOK_OPERATOR'] as const).filter(
    (key) => !env[key],
  );
}

/**
 * ボディを正規化する。
 *
 * JSON として読めない場合も 400 にはしない。未知イベントとして運用者へ転送し、
 * 設定ミスを沈黙ではなく通知として観測できるようにする（設計 §3）。
 */
export function parsePayload(raw: string, receivedAt: Date): Payload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const record = isRecord(parsed) ? parsed : {};
  return {
    event: pickString(record, EVENT_KEYS).trim(),
    status: pickString(record, STATUS_KEYS).trim().toLowerCase(),
    receivedAt,
    raw,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

/** 長さが一致する場合は定数時間で比較する。 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length === 0 || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left[i] ^ right[i];
  }
  return diff === 0;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
