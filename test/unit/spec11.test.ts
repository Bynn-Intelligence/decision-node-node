import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BadRequestError,
  DecisionNode,
  Image,
  NumberAnswer,
  SessionLimitError,
  TimeoutError,
  TruthAnswer,
  UnknownAnswer,
  ValidationError,
  choice,
  number,
  parseAnswer,
  score,
  truth,
  type FetchLike,
} from '../../src/index.js';
import { checkQuestions, checkRequest, checkSessionOpen, gridSize } from '../../src/checks.js';
import { errorFromResponse } from '../../src/errors.js';
import { md5Js } from '../../src/hash.js';
import { bunEnvProxy } from '../../src/sessions.js';

const PNG = new Uint8Array(readFileSync(fileURLToPath(new URL('../fixtures/images/5x3.png', import.meta.url))));
const BASE = 'https://api.example.test';

function padded(bytes: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  out.set(bytes);
  return out;
}

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake API and storage: routes by method and path, records every call. */
function fakeApi(handlers: Record<string, (call: Call, n: number) => { status: number; body?: unknown; text?: string; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const counts: Record<string, number> = {};
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const call: Call = { method: String(init.method), url, headers: { ...(init.headers as Record<string, string>) }, body: init.body };
    calls.push(call);
    const key = `${call.method} ${u.pathname}`;
    const route = Object.keys(handlers).find((k) => key === k || (k.endsWith('*') && key.startsWith(k.slice(0, -1))));
    if (!route) return new Response('{}', { status: 404 });
    counts[route] = (counts[route] ?? 0) + 1;
    const r = handlers[route]!(call, counts[route]!);
    return new Response(r.text ?? JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers ?? {} });
  };
  return { fetch, calls };
}

const DECISION = { status: 200, body: { model: 'decisionnode-moe-0.9.0-rc1', answers: { q: { type: 'truth', truth: 0.5 } }, usage: {} } };

function presign(expiresAt = new Date(Date.now() + 3600_000).toISOString().replace(/\.\d+Z$/, 'Z')) {
  let n = 0;
  return (call: Call) => {
    const files = JSON.parse(call.body as string).files as Array<Record<string, unknown>>;
    return {
      status: 201,
      body: {
        uploads: files.map((f) => ({
          upload_id: `upl_${String(++n).padStart(32, '0')}`,
          url: `https://storage.example.test/uploads/${n}?X-Amz-Signature=s`,
          method: 'PUT',
          headers: { 'Content-Type': f.content_type, 'Content-MD5': f.checksum, 'If-None-Match': '*', 'x-amz-checksum-sha256': f.sha256 },
          expires_at: expiresAt,
        })),
        expires_in: 300,
      },
    };
  };
}

function client(fetch: FetchLike, extra: ConstructorParameters<typeof DecisionNode>[0] = {}) {
  return new DecisionNode({ apiKey: 'k', baseUrl: BASE, fetch, fetchHonoursManualRedirect: true, sleep: async () => {}, ...extra });
}

describe('question checks', () => {
  it.each([
    ['a choice without options', { q: choice('?', []) }, BadRequestError],
    ['a choice of 256 options', { q: choice('?', Array.from({ length: 256 }, (_, i) => `o${i}`)) }, BadRequestError],
    ['a score of 11 levels', { q: score('?', Array.from({ length: 11 }, (_, i) => `l${i}`)) }, BadRequestError],
    ['a score of numbers', { q: score('?', [1, 2]) }, ValidationError],
    ['an unknown question type', { q: { type: 'rank' } }, BadRequestError],
    ['a question without a type', { q: { instructions: '?' } }, ValidationError],
    ['a choice without criteria', { q: { type: 'choice', instructions: '?' } }, ValidationError],
    ['a number with 7 decimals in step', { q: number('?', 0, 1, 0.0000001) }, ValidationError],
    ['a number beyond 2^53', { q: number('?', 0, 2 ** 54) }, ValidationError],
    ['a score without levels', { q: score('?', []) }, ValidationError],
    ['a truth with neither instructions nor criteria', { q: truth() }, BadRequestError],
    ['a number without instructions', { q: number(undefined, 0, 10) }, BadRequestError],
    ['a number with min above max', { q: number('?', 60, 50) }, ValidationError],
    ['a number with step 0', { q: number('?', 0, 10, 0) }, ValidationError],
    ['a number grid of 10,001 values', { q: number('?', 0, 1000, 0.1) }, ValidationError],
    ['a number given as text', { q: { type: 'number', instructions: '?', max: '5' } }, ValidationError],
  ])('refuses %s', (_name, questions, cls) => {
    let err: unknown;
    try {
      checkQuestions(questions as Record<string, unknown>);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(cls);
    expect((err as ValidationError).status).toBeNull();
  });

  it('accepts what the API accepts', () => {
    expect(() =>
      checkQuestions({
        a: choice('?', Array.from({ length: 255 }, (_, i) => `o${i}`)),
        b: score('?', Array.from({ length: 10 }, (_, i) => `l${i}`)),
        c: score('?', ['only']),
        d: truth(undefined, 'yes'),
        e: number('?'),
        f: number('?', 0, 4095),
        g: { type: 'score', criteria: { '0': 'low', '1': 'high' } },
      }),
    ).not.toThrow();
  });

  it('builds the grid in exact decimals', () => {
    expect(gridSize({ min: 0, max: 0.3, step: 0.1 })).toBe(4);
    expect(gridSize({})).toBe(256);
    expect(gridSize({ min: 0, max: 10, step: 3 })).toBe(4);
    expect(gridSize({ min: 0.25, max: 2, step: 0.5 })).toBe(4);
    expect(gridSize({ min: -40, max: 10 })).toBe(51);
    expect(gridSize({ min: -3, max: -2, step: 0.001 })).toBe(1001);
    expect(gridSize({ min: 0, max: 1e-6, step: 1e-7 })).toBe(11);
    expect(gridSize({ min: 5, max: 5 })).toBe(1);
    expect(gridSize({ min: 0, max: 100, step: 0.1 })).toBe(1001);
  });

  it('raises the API 422 with its entries, and the plain-string 400 with a null error type', () => {
    const grab = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        return e as ValidationError;
      }
      throw new Error('no error');
    };
    const tooLong = grab(() => checkQuestions({ p: number('Percent?', 0, 1000, 0.1) }));
    expect(tooLong.entries).toEqual([
      {
        type: 'too_long',
        loc: ['body', 'questions', 'p', 'number'],
        msg: 'Grid should have at most 4096 values, not 10001',
        input: { type: 'number', instructions: 'Percent?', min: 0, max: 1000, step: 0.1 },
        ctx: { field_type: 'Grid', max_length: 4096, actual_length: 10001 },
      },
    ]);
    const bound = grab(() => checkQuestions({ n: number('How much?', 0, 10_000_000_000, 0.000001) }));
    expect(bound.entries).toEqual([
      {
        type: 'less_than_equal',
        loc: ['body', 'questions', 'n', 'number', 'max'],
        msg: 'Input should be less than or equal to 999999999.999999',
        input: 10_000_000_000,
        ctx: { le: 999999999.999999 },
      },
    ]);
    const truthErr = grab(() => checkQuestions({ q: truth() }));
    expect(truthErr).toBeInstanceOf(BadRequestError);
    expect(truthErr.errorType).toBeNull();
    expect(truthErr.message).toBe('Truth question must have criteria or instructions: q');
    const nested = grab(() => checkRequest({ state: JSON.parse('['.repeat(128) + ']'.repeat(128)), questions: { q: truth('?') } }));
    expect(nested).toBeInstanceOf(BadRequestError);
    expect(nested.errorType).toBe('api_usage_error');
    expect(() => checkRequest({ state: JSON.parse('['.repeat(127) + ']'.repeat(127)), questions: { q: truth('?') } })).not.toThrow();
  });

  it('refuses a session window and ttl out of range with the API entries, using a held max_window', () => {
    let err: ValidationError | undefined;
    try {
      checkSessionOpen({ questions: { a: truth('?') }, window: 17, ttl_seconds: 0 }, { sessions: { max_window: 16 } });
    } catch (e) {
      err = e as ValidationError;
    }
    expect(err?.entries).toEqual([
      { type: 'less_than_equal', loc: ['body', 'window'], msg: 'Input should be less than or equal to 16', input: 17, ctx: { le: 16 } },
      { type: 'greater_than_equal', loc: ['body', 'ttl_seconds'], msg: 'Input should be greater than or equal to 1', input: 0, ctx: { ge: 1 } },
    ]);
  });
});

describe('number and truth', () => {
  it('leaves out the grid fields not given', () => {
    expect(number('How many?')).toEqual({ type: 'number', instructions: 'How many?' });
    expect(number('How many?', 0, 50)).toEqual({ type: 'number', instructions: 'How many?', min: 0, max: 50 });
    expect(number('t', -40.5, 10.25, 0.25)).toEqual({ type: 'number', instructions: 't', min: -40.5, max: 10.25, step: 0.25 });
  });

  it('parses a number answer with its keys as sent', () => {
    const a = parseAnswer({ type: 'number', number: 3.5, expected: 3.42, confidence: 0.61, probabilities: { '2.5': 0.04, '3': 0.21, '3.5': 0.612 } });
    expect(a).toBeInstanceOf(NumberAnswer);
    expect((a as NumberAnswer).probabilities).toEqual({ '2.5': 0.04, '3': 0.21, '3.5': 0.612 });
    expect(parseAnswer({ type: 'number', number: 3, confidence: 0.5, probabilities: {} })).toBeInstanceOf(UnknownAnswer);
  });

  it('reads an answer under the older wire name as a truth answer', () => {
    const a = parseAnswer({ type: 'noul', noul: 0.94 });
    expect(a).toBeInstanceOf(TruthAnswer);
    expect((a as TruthAnswer).truth).toBe(0.94);
    expect(a.type).toBe('truth');
    expect(a.raw).toEqual({ type: 'noul', noul: 0.94 });
    expect(parseAnswer({ type: 'noul', noul: '0.94' })).toBeInstanceOf(UnknownAnswer);
  });

  it('has one decision call, /v1/decide, and writes truth as truth', async () => {
    const api = fakeApi({ 'POST /v1/decide': () => DECISION });
    const dn = client(api.fetch);
    expect('systemone' in dn).toBe(false);
    await dn.decide({ state: 's', questions: { q: truth('?') } });
    expect(JSON.parse(api.calls[0]!.body as string).questions).toEqual({ q: { type: 'truth', instructions: '?' } });
  });
});

describe('errors', () => {
  it('gives SessionLimitError, a RateLimitError, for session_limit_exceeded', () => {
    const err = errorFromResponse(429, { 'retry-after': '5' }, JSON.stringify({ detail: { error_type: 'session_limit_exceeded', message: 'm' } }));
    expect(err).toBeInstanceOf(SessionLimitError);
    expect(err.name).toBe('SessionLimitError');
    expect((err as SessionLimitError).retryAfter).toBe(5);
  });
});

describe('md5', () => {
  it('matches node:crypto on lengths around the block boundaries', () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 70_000]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 31 + n) & 0xff);
      expect(Buffer.from(md5Js(bytes)).toString('hex')).toBe(createHash('md5').update(bytes).digest('hex'));
    }
  });
});

describe('uploads', () => {
  it('sends a request whose local images total under the threshold inline, with no presign', async () => {
    const api = fakeApi({ 'POST /v1/decide': () => DECISION });
    await client(api.fetch).decide({ questions: { q: truth('?') }, images: [Image.fromBytes('a', padded(PNG, 1000))] });
    expect(api.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['POST /v1/decide']);
  });

  it('uploads at the threshold: one presign, a PUT with exactly the returned headers, then the upload id', async () => {
    const api = fakeApi({ 'POST /v1/uploads': presign(), 'PUT /uploads/*': () => ({ status: 200, text: '' }), 'POST /v1/decide': () => DECISION });
    const dn = client(api.fetch, { inlineThreshold: 1000, headers: { 'x-tenant': 't1' } });
    const bytes = padded(PNG, 1000);
    await dn.decide({ questions: { q: truth('?') }, images: [Image.fromBytes('a', bytes)] });
    expect(api.calls.map((c) => c.method)).toEqual(['POST', 'PUT', 'POST']);
    const files = JSON.parse(api.calls[0]!.body as string).files;
    expect(files).toEqual([
      {
        content_type: 'image/png',
        byte_size: 1000,
        checksum: createHash('md5').update(bytes).digest('base64'),
        sha256: createHash('sha256').update(bytes).digest('base64'),
      },
    ]);
    const put = api.calls[1]!;
    expect(Object.keys(put.headers).sort()).toEqual(['Content-MD5', 'Content-Type', 'If-None-Match', 'x-amz-checksum-sha256']);
    expect(put.body).toEqual(bytes);
    expect(JSON.parse(api.calls[2]!.body as string).images).toEqual([{ id: 'a', upload_id: `upl_${'1'.padStart(32, '0')}` }]);
  });

  it('reuses an upload for the same bytes, whatever their size, until 5 minutes before it expires', async () => {
    const api = fakeApi({ 'POST /v1/uploads': presign(), 'PUT /uploads/*': () => ({ status: 200, text: '' }), 'POST /v1/decide': () => DECISION });
    const dn = client(api.fetch, { inlineThreshold: 1000 });
    const bytes = padded(PNG, 1000);
    await dn.upload([Image.fromBytes('a', bytes)]);
    await dn.decide({ questions: { q: truth('?') }, images: [Image.fromBytes('b', bytes.slice())] });
    expect(api.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/v1/uploads'))).toHaveLength(1);

    const soon = fakeApi({
      'POST /v1/uploads': presign(new Date(Date.now() + 200_000).toISOString()),
      'PUT /uploads/*': () => ({ status: 200, text: '' }),
      'POST /v1/decide': () => DECISION,
    });
    const dn2 = client(soon.fetch, { inlineThreshold: 0 });
    await dn2.decide({ questions: { q: truth('?') }, images: [Image.fromBytes('a', bytes)] });
    await dn2.decide({ questions: { q: truth('?') }, images: [Image.fromBytes('a', bytes)] });
    expect(soon.calls.filter((c) => c.url.endsWith('/v1/uploads'))).toHaveLength(2);
  });

  it('uploads again and resends once when a placed upload went stale, then raises the second time', async () => {
    const stale = { status: 400, body: { detail: { error_type: 'upload_expired', message: 'expired' } } };
    const api = fakeApi({ 'POST /v1/uploads': presign(), 'PUT /uploads/*': () => ({ status: 200, text: '' }), 'POST /v1/decide': () => stale });
    const err = await client(api.fetch, { inlineThreshold: 0 })
      .decide({ questions: { q: truth('?') }, images: [Image.fromBytes('a', PNG)] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect(api.calls.map((c) => c.method)).toEqual(['POST', 'PUT', 'POST', 'POST', 'PUT', 'POST']);
  });

  it('takes a 412 on a retried PUT as success, and refuses a storage URL that is not https', async () => {
    const api = fakeApi({
      'POST /v1/uploads': presign(),
      'PUT /uploads/*': (_c, n) => (n === 1 ? { status: 503, text: '<Error><Code>SlowDown</Code></Error>' } : { status: 412, text: '' }),
      'POST /v1/decide': () => DECISION,
    });
    await client(api.fetch, { inlineThreshold: 0 }).decide({ questions: { q: truth('?') }, images: [Image.fromBytes('a', PNG)] });
    expect(api.calls.map((c) => c.method)).toEqual(['POST', 'PUT', 'PUT', 'POST']);

    const plain = fakeApi({
      'POST /v1/uploads': () => ({
        status: 201,
        body: { uploads: [{ upload_id: 'upl_1', url: 'http://storage.example.test/x', headers: {}, expires_at: '2099-01-01T00:00:00Z' }] },
      }),
    });
    const err = await client(plain.fetch, { inlineThreshold: 0 })
      .decide({ questions: { q: truth('?') }, images: [Image.fromBytes('a', PNG)] })
      .catch((e: unknown) => e);
    expect((err as Error).name).toBe('DecisionNodeError');
    expect(plain.calls).toHaveLength(1);
  });
});

describe('batches', () => {
  const BATCH = { id: 'batch_0123456789', state: 'draft', counters: {}, created_at: '2026-10-08T00:00:00Z', ended_at: null };

  it('sends JSON Lines with the model always and an absent state as empty', async () => {
    const api = fakeApi({ 'POST /v1/batches': () => ({ status: 201, body: BATCH }) });
    await client(api.fetch).batches.create([{ customId: 'a', questions: { q: truth('?') } }]);
    expect(api.calls[0]!.headers['content-type']).toBe('application/x-ndjson');
    expect(api.calls[0]!.body).toBe('{"custom_id":"a","model":"decisionnode-moe","state":"","questions":{"q":{"type":"truth","instructions":"?"}}}\n');
  });

  it('polls at the interval, takes a longer Retry-After, and raises TimeoutError past the timeout', async () => {
    const waits: number[] = [];
    const api = fakeApi({
      'POST /v1/batches': () => ({ status: 201, body: BATCH }),
      'POST /v1/batches/*': () => ({ status: 200, body: { ...BATCH, state: 'queued' } }),
      'GET /v1/batches/*': () => ({ status: 200, body: { ...BATCH, state: 'running' }, headers: { 'retry-after': '30' } }),
    });
    const dn = client(api.fetch, { sleep: async (ms) => void waits.push(ms) });
    const err = await dn
      .runBatch([{ customId: 'a', questions: { q: truth('?') } }], { pollInterval: 10_000, timeout: 60_000 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(waits).toEqual([10_000, 30_000, 30_000]);
    await expect(dn.runBatch([], { pollInterval: 9_999 })).rejects.toBeInstanceOf(RangeError);
  });
});

describe('checks without sending', () => {
  it('checkRequest raises what sending raises and sends nothing, uploads included', async () => {
    const api = fakeApi({});
    const dn = client(api.fetch, { inlineThreshold: 0 });
    await expect(dn.checkRequest('decide', { questions: { q: truth('?') }, images: [Image.fromBytes('a', PNG)] })).resolves.toBeUndefined();
    await expect(dn.checkRequest('openSession', { questions: { a: truth('?') }, window: 65 })).rejects.toBeInstanceOf(ValidationError);
    const repeated = [
      { customId: 'a', questions: { q: truth('?') } },
      { customId: 'a', questions: { q: truth('?') } },
    ];
    await expect(dn.checkRequest('batches.create', repeated)).rejects.toThrow('Line 2: custom_id "a" is already in the batch.');
    await expect(dn.checkRequest('batches.add', [])).rejects.toThrow('The call holds no requests.');
    await expect(dn.checkRequest('batches.create', [])).resolves.toBeUndefined();
    await expect((dn.checkRequest as (m: string, r: unknown) => Promise<void>)('gate', {})).rejects.toBeInstanceOf(TypeError);
    expect(api.calls).toHaveLength(0);
  });

  it('applies limits held from models() to a model named by its alias or version', async () => {
    const entry = { name: 'decisionnode-moe-0.9.0-rc1', version: 'decisionnode-moe-0.9.0-rc1', alias: 'decisionnode-moe', sessions: { max_window: 16 }, number_max_grid_values: 0 };
    const api = fakeApi({ 'GET /v1/models': () => ({ status: 200, body: { models: [entry] } }) });
    const dn = client(api.fetch);
    await expect(dn.checkRequest('openSession', { questions: { a: truth('?') }, window: 17, model: 'decisionnode-moe' })).resolves.toBeUndefined();
    await dn.models();
    await expect(dn.checkRequest('openSession', { questions: { a: truth('?') }, window: 17, model: 'decisionnode-moe' })).rejects.toBeInstanceOf(ValidationError);
    await expect(dn.checkRequest('decide', { questions: { n: number('How many?') }, model: 'decisionnode-moe' })).rejects.toThrow(
      'does not answer number questions',
    );
    await expect(dn.checkRequest('openSession', { questions: { a: truth('?') }, window: 17, model: 'decisionnode-other' })).resolves.toBeUndefined();
  });
});

describe('client options of 1.6', () => {
  it('validates uploadTimeout and webSocketOptions', () => {
    expect(() => new DecisionNode({ apiKey: 'k', uploadTimeout: 0 })).toThrow(RangeError);
    expect(new DecisionNode({ apiKey: 'k' }).uploadTimeout).toBe(60_000);
    expect(() => new DecisionNode({ apiKey: 'k', webSocketOptions: { rejectUnauthorized: false } })).toThrow(TypeError);
    expect(() => new DecisionNode({ apiKey: 'k', webSocketOptions: { tls: { rejectUnauthorized: false } } })).toThrow(TypeError);
    expect(() => new DecisionNode({ apiKey: 'k', webSocketOptions: { headers: {} } })).toThrow(TypeError);
    expect(() => new DecisionNode({ apiKey: 'k', webSocketOptions: { dispatcher: {} } })).not.toThrow();
  });

  it('gives a Bun session socket the proxy its fetch reads from the environment', () => {
    const g = globalThis as { Bun?: unknown };
    const saved = { ...process.env };
    g.Bun = {};
    try {
      process.env.HTTPS_PROXY = 'http://proxy.example.test:8080';
      process.env.NO_PROXY = 'internal.example.test';
      expect(bunEnvProxy('wss://api.example.test/v1/sessions/s/stream', {})).toBe('http://proxy.example.test:8080');
      expect(bunEnvProxy('wss://api.internal.example.test/v1/sessions/s/stream', {})).toBeNull();
      expect(bunEnvProxy('wss://api.example.test/v1/sessions/s/stream', { proxy: 'http://other:1' })).toBeNull();
      expect(bunEnvProxy('ws://127.0.0.1:8787/v1/sessions/s/stream', {})).toBeNull();
    } finally {
      delete g.Bun;
      process.env = saved;
    }
    expect(bunEnvProxy('wss://api.example.test/v1/sessions/s/stream', {})).toBeNull();
  });
});
