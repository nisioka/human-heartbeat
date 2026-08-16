/**
 * イベント種別 → 宛先・文面の対応表。
 *
 * 発火時のアクションを差し替えるとき、変更範囲はこのファイルに閉じる（設計 N-3）。
 * ここに判定ロジックや状態を持ち込まないこと。「何が起きたか」は healthchecks.io が決め、
 * このファイルは「誰に、どう伝えるか」だけを決める。
 */

/** 通知の宛先種別。実際の Webhook URL は環境変数で解決する（src/index.ts）。 */
export type Audience = 'primary' | 'operator';

/** 対応表に無いイベントを流し込む先。沈黙させないための逃げ道。 */
export const FALLBACK_AUDIENCE: Audience = 'operator';

/** healthchecks.io から受け取ったペイロードを正規化したもの。 */
export interface Payload {
  /** チェック名。例: alive-72 */
  event: string;
  /** 小文字化した状態。例: down / up */
  status: string;
  /** アダプタが受信した時刻 */
  receivedAt: Date;
  /** 受信したボディの原文（未知イベントの転送に使う） */
  raw: string;
}

export interface Delivery {
  audience: Audience;
  text: string;
}

export interface RouteContext {
  /** 通知文面に出す運用者の呼称。環境変数 OPERATOR_NAME で差し替える。 */
  operatorName: string;
}

type Template = (payload: Payload, audience: Audience, ctx: RouteContext) => string;

interface RouteEntry {
  audiences: Audience[];
  template: Template;
}

const TOKYO = 'Asia/Tokyo';

/** 日本語の文面に埋め込むための時刻表記。 */
export function formatTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: TOKYO,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} (JST)`;
}

/**
 * 72時間の無音で発火したときの本文。
 *
 * 機微情報は一切含めない（設計 N-4）。伝えるのは「連絡が取れていない事実」と
 * 「次に取るべき行動」だけで、資産や保管場所の話はここに書かない。
 */
const fired: Template = (payload, audience, ctx) => {
  const lines = [
    '🚨 **ハートビートが72時間途絶えています**',
    '',
    `${ctx.operatorName} の端末操作が72時間確認できていません。事故や急病の可能性があります。`,
    '',
    '**お願いしたいこと**',
    '1. 本人に電話やメッセージで連絡を取ってください',
    '2. 連絡が取れない場合は、立ち寄り先や勤務先に確認してください',
    '3. それでも所在が分からない場合は、警察（#9110、緊急時は110）に相談してください',
    '',
    'この通知は自動送信です。本人が無事な場合、これは誤報です。',
    `検知時刻: ${formatTimestamp(payload.receivedAt)}`,
  ];
  if (audience === 'operator') {
    lines.push(
      '',
      '― 運用者向け ―',
      '誤報であればこの端末から ping URL を開けば解除できます（healthchecks.io の通知メールに記載）。',
      '解除すると一次受信者へ復帰通知が届きます。',
    );
  }
  return lines.join('\n');
};

/** 発火後にハートビートが戻ったとき（＝誤報の取り消し）の本文。 */
const recovered: Template = (payload, _audience, ctx) => {
  return [
    '✅ **解除: ハートビートを再検知しました**',
    '',
    `先ほどの「72時間途絶」の通知は解除されました。${ctx.operatorName} の端末操作を再び確認できています。`,
    '先の通知は誤報だったとみられます。対応は不要です。',
    '',
    `解除時刻: ${formatTimestamp(payload.receivedAt)}`,
  ].join('\n');
};

/**
 * 対応表。キーは `${event}:${status}`。
 *
 * 72h の発火は一次受信者と運用者の両方へ同時に送る。運用者が生きていれば
 * 誤爆に即座に気づいて取り消せる（設計 F-5）。
 */
const ROUTE_TABLE: Record<string, RouteEntry> = {
  'alive-72:down': { audiences: ['primary', 'operator'], template: fired },
  'alive-72:up': { audiences: ['primary', 'operator'], template: recovered },
};

/** 未知のイベントを運用者へ転送するための本文。 */
function unknownEventText(payload: Payload): string {
  return [
    '⚠️ **対応表に無いイベントを受信しました**',
    '',
    `event: \`${payload.event || '(不明)'}\` / status: \`${payload.status || '(不明)'}\``,
    '通知アダプタの対応表と healthchecks.io 側の設定が食い違っている可能性があります。',
    '',
    `受信時刻: ${formatTimestamp(payload.receivedAt)}`,
    '受信したボディ:',
    '```',
    payload.raw.slice(0, 800) || '(空)',
    '```',
  ].join('\n');
}

/**
 * ペイロードを配信内容へ変換する。
 *
 * 対応表に無いイベントでも空配列は返さない。捨てた通知は不発と区別がつかないため、
 * 必ずフォールバック宛先へ流す（設計 §3・§6）。
 */
export function route(payload: Payload, ctx: RouteContext): Delivery[] {
  const entry = ROUTE_TABLE[`${payload.event}:${payload.status}`];
  if (!entry) {
    return [{ audience: FALLBACK_AUDIENCE, text: unknownEventText(payload) }];
  }
  return entry.audiences.map((audience) => ({
    audience,
    text: entry.template(payload, audience, ctx),
  }));
}

/** 配信に失敗したことを運用者へ知らせる本文。 */
export function deliveryFailureText(
  failures: { audience: Audience; reason: string }[],
  payload: Payload,
): string {
  return [
    '❗ **通知の配信に失敗しました**',
    '',
    `event: \`${payload.event || '(不明)'}\` / status: \`${payload.status || '(不明)'}\``,
    ...failures.map((f) => `- 宛先 \`${f.audience}\`: ${f.reason}`),
    '',
    'Discord Webhook の失効や権限変更が疑われます。設定を確認してください。',
    `受信時刻: ${formatTimestamp(payload.receivedAt)}`,
  ].join('\n');
}
