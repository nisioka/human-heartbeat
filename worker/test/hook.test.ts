import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import worker, { parsePayload, timingSafeEqual, type Env } from '../src/index';
import { truncate, DISCORD_CONTENT_LIMIT } from '../src/discord';

const SECRET = 'test-secret-value';
const PRIMARY = 'https://example.invalid/webhook/primary';
const OPERATOR = 'https://example.invalid/webhook/operator';

const env: Env = {
  HOOK_SECRET: SECRET,
  DISCORD_WEBHOOK_PRIMARY: PRIMARY,
  DISCORD_WEBHOOK_OPERATOR: OPERATOR,
  OPERATOR_NAME: 'テスト運用者',
};

interface SentMessage {
  url: string;
  content: string;
  allowedMentions: unknown;
}

let sent: SentMessage[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

/** Discord への送信を捕まえる。既定では 204 を返す。 */
function mockDiscord(responder: (url: string) => Response = () => new Response(null, { status: 204 })) {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}'));
    sent.push({ url, content: body.content, allowedMentions: body.allowed_mentions });
    return responder(url);
  });
  vi.stubGlobal('fetch', fetchMock);
}

function hookRequest(body: unknown, init: { secret?: string | null; method?: string; path?: string } = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });
  const secret = init.secret === undefined ? SECRET : init.secret;
  if (secret !== null) headers.set('x-deadman-secret', secret);
  return new Request(`https://adapter.example.invalid${init.path ?? '/hook'}`, {
    method: init.method ?? 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  sent = [];
  mockDiscord();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('入口の防御', () => {
  it('未知のパスは 404 で、Discord へは何も送らない', async () => {
    const response = await worker.fetch(hookRequest({ event: 'alive-72', status: 'down' }, { path: '/' }), env);
    expect(response.status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  it('POST 以外は 405 を返す', async () => {
    const response = await worker.fetch(
      new Request('https://adapter.example.invalid/hook', { method: 'GET' }),
      env,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(sent).toHaveLength(0);
  });

  it('シークレットが無ければ 401 で、Discord へは何も送らない', async () => {
    const response = await worker.fetch(
      hookRequest({ event: 'alive-72', status: 'down' }, { secret: null }),
      env,
    );
    expect(response.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it('シークレットが違えば 401', async () => {
    const response = await worker.fetch(
      hookRequest({ event: 'alive-72', status: 'down' }, { secret: 'wrong-secret-val' }),
      env,
    );
    expect(response.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it('シークレットが未設定の環境では認証を通さず 500 を返す', async () => {
    const broken: Env = { ...env, HOOK_SECRET: '' };
    const response = await worker.fetch(hookRequest({ event: 'alive-72', status: 'down' }, { secret: '' }), broken);
    expect(response.status).toBe(500);
    expect(sent).toHaveLength(0);
  });

  it('Webhook URL が未設定なら 500', async () => {
    const broken: Env = { ...env, DISCORD_WEBHOOK_PRIMARY: '' };
    const response = await worker.fetch(hookRequest({ event: 'alive-72', status: 'down' }), broken);
    expect(response.status).toBe(500);
    expect(sent).toHaveLength(0);
  });
});

describe('alive-72 の発火', () => {
  it('一次受信者と運用者の両方へ送る', async () => {
    const response = await worker.fetch(hookRequest({ event: 'alive-72', status: 'down' }), env);
    expect(response.status).toBe(200);
    expect(sent.map((m) => m.url).sort()).toEqual([OPERATOR, PRIMARY].sort());
  });

  it('一次受信者向けの本文は日本語で、次の行動が書かれている', async () => {
    await worker.fetch(hookRequest({ event: 'alive-72', status: 'down' }), env);
    const primary = sent.find((m) => m.url === PRIMARY)!;
    expect(primary.content).toContain('72時間');
    expect(primary.content).toContain('テスト運用者');
    expect(primary.content).toContain('連絡');
    expect(primary.content).toContain('誤報');
  });

  it('解除手順は運用者向けにだけ書く', async () => {
    await worker.fetch(hookRequest({ event: 'alive-72', status: 'down' }), env);
    const primary = sent.find((m) => m.url === PRIMARY)!;
    const operator = sent.find((m) => m.url === OPERATOR)!;
    expect(operator.content).toContain('ping URL');
    expect(primary.content).not.toContain('ping URL');
  });

  it('機微情報につながる語を本文に含めない', async () => {
    await worker.fetch(hookRequest({ event: 'alive-72', status: 'down' }), env);
    for (const message of sent) {
      for (const word of ['口座', '証券', 'パスワード', '暗証', '保管場所']) {
        expect(message.content).not.toContain(word);
      }
    }
  });

  it('メンションは常に無効化する', async () => {
    await worker.fetch(hookRequest({ event: 'alive-72', status: 'down' }), env);
    for (const message of sent) {
      expect(message.allowedMentions).toEqual({ parse: [] });
    }
  });

  it('status の大文字表記でも同じ経路に乗る', async () => {
    await worker.fetch(hookRequest({ event: 'alive-72', status: 'DOWN' }), env);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.content).toContain('72時間');
  });

  it('event キーが name でも拾う', async () => {
    await worker.fetch(hookRequest({ name: 'alive-72', status: 'down' }), env);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.content).toContain('72時間');
  });
});

describe('復帰', () => {
  it('up は解除の文面を両者へ送る', async () => {
    const response = await worker.fetch(hookRequest({ event: 'alive-72', status: 'up' }), env);
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(2);
    for (const message of sent) {
      expect(message.content).toContain('解除');
      expect(message.content).toContain('対応は不要');
    }
  });
});

describe('未知のイベント', () => {
  it('捨てずに運用者へ転送する', async () => {
    const response = await worker.fetch(hookRequest({ event: 'alive-99', status: 'down' }), env);
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(OPERATOR);
    expect(sent[0]!.content).toContain('対応表に無いイベント');
    expect(sent[0]!.content).toContain('alive-99');
  });

  it('対応表にある名前でも未知の status なら転送する', async () => {
    await worker.fetch(hookRequest({ event: 'alive-72', status: 'paused' }), env);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(OPERATOR);
  });

  it('JSON として読めないボディでも 400 にせず転送する', async () => {
    const response = await worker.fetch(hookRequest('これはJSONではない', {}), env);
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(OPERATOR);
    expect(sent[0]!.content).toContain('これはJSONではない');
  });

  it('空ボディでも転送する', async () => {
    const response = await worker.fetch(hookRequest('', {}), env);
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.content).toContain('(不明)');
  });
});

describe('配信の失敗', () => {
  it('一次受信者への配信が失敗したら運用者へ通知し 502 を返す', async () => {
    mockDiscord((url) =>
      url === PRIMARY ? new Response('boom', { status: 500 }) : new Response(null, { status: 204 }),
    );
    const response = await worker.fetch(hookRequest({ event: 'alive-72', status: 'down' }), env);
    expect(response.status).toBe(502);

    const failureNotice = sent.filter((m) => m.content.includes('配信に失敗'));
    expect(failureNotice).toHaveLength(1);
    expect(failureNotice[0]!.url).toBe(OPERATOR);
    expect(failureNotice[0]!.content).toContain('primary');
  });

  it('全経路が死んでいても例外を投げずに 502 を返す', async () => {
    mockDiscord(() => new Response('boom', { status: 500 }));
    const response = await worker.fetch(hookRequest({ event: 'alive-72', status: 'down' }), env);
    expect(response.status).toBe(502);
  });

  it('fetch 自体が例外を投げても 502 を返す', async () => {
    fetchMock = vi.fn(async () => {
      throw new TypeError('network unreachable');
    });
    vi.stubGlobal('fetch', fetchMock);
    const response = await worker.fetch(hookRequest({ event: 'alive-72', status: 'down' }), env);
    expect(response.status).toBe(502);
  });
});

describe('部品', () => {
  it('timingSafeEqual は長さ違い・空文字を通さない', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(false);
  });

  it('parsePayload は前後の空白と大小文字を正規化する', () => {
    const payload = parsePayload(JSON.stringify({ event: ' alive-72 ', status: ' Down ' }), new Date(0));
    expect(payload.event).toBe('alive-72');
    expect(payload.status).toBe('down');
  });

  it('truncate は Discord の上限を超えない', () => {
    const long = 'あ'.repeat(5000);
    const result = truncate(long);
    expect(Array.from(result).length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
    expect(result).toContain('以下省略');
  });

  it('truncate は上限以下の文字列をそのまま返す', () => {
    expect(truncate('短い本文')).toBe('短い本文');
  });

  it('長大なボディを転送しても Discord へは上限内で送る', async () => {
    await worker.fetch(hookRequest('x'.repeat(10000), {}), env);
    expect(Array.from(sent[0]!.content).length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
  });
});
