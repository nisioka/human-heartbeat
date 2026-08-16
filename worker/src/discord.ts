/** Discord Incoming Webhook への送信のみを担う。ここに宛先の判断は持たせない。 */

/** Discord のメッセージ本文の上限。 */
export const DISCORD_CONTENT_LIMIT = 2000;

const ELLIPSIS = '\n…（以下省略）';

export function truncate(text: string, limit: number = DISCORD_CONTENT_LIMIT): string {
  if (Array.from(text).length <= limit) return text;
  const head = Array.from(text).slice(0, limit - Array.from(ELLIPSIS).length).join('');
  return head + ELLIPSIS;
}

/**
 * Webhook へ POST する。失敗は例外で返す（呼び出し側がフォールバックを判断する）。
 *
 * allowed_mentions を空にしているのは、未知イベントの転送で受信したボディをそのまま
 * 貼るため。外部由来の文字列に @everyone が混ざっていても発火させない。
 * 受信者への到達性はチャンネルの通知設定（すべてのメッセージ）で担保する。
 */
export async function postToDiscord(webhookUrl: string, content: string): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: truncate(content),
      allowed_mentions: { parse: [] },
    }),
  });
  if (!response.ok) {
    throw new Error(`Discord が ${response.status} を返しました`);
  }
}
