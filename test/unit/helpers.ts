import type { FetchLike } from '../../src/index.js';

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  redirect: RequestRedirect | undefined;
}

export type Reply =
  | { status: number; body?: unknown; text?: string; headers?: Record<string, string>; delayMs?: number }
  | { error: 'network' }
  | { hang: true };

/** A fake fetch that answers from a list of replies, the last one repeating. */
export function fakeFetch(replies: Reply[]): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: String(init.method),
      headers: { ...(init.headers as Record<string, string>) },
      body: init.body as string | undefined,
      redirect: init.redirect,
    });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    const signal = init.signal ?? undefined;
    const wait = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
        });
      });
    if ('hang' in reply) {
      await wait(60_000);
      throw new Error('unreachable');
    }
    if ('error' in reply) throw new TypeError('fetch failed', { cause: new Error('other side closed') });
    if (reply.delayMs) await wait(reply.delayMs);
    const text = reply.text ?? JSON.stringify(reply.body ?? {});
    return new Response(text, { status: reply.status, headers: reply.headers ?? {} });
  };
  return { fetch, calls };
}

export const OK_TRUTH = {
  status: 200,
  body: { model: 'decisionnode-moe-0.9.0-rc1', answers: { q: { type: 'truth', truth: 0.94 } }, usage: { input_tokens: 9, output_tokens: 0 } },
  headers: {
    'x-request-id': 'req_1',
    'x-decisionnode-model': 'decisionnode-moe-0.9.0-rc1',
    'x-decisionnode-latency-ms': '23',
    'x-decisionnode-safety': 'harm=0.031, self_harm=0.004',
  },
} as const;
