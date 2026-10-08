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
import { checkQuestions, gridSize } from '../../src/checks.js';
import { errorFromResponse } from '../../src/errors.js';
import { md5Js } from '../../src/hash.js';

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

const DECISION = { status: 200, body: { model: 'decisionnode-1.0', answers: { q: { type: 'truth', truth: 0.5 } }, usage: {} } };

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
    ['a score of 11 levels', { q: score('?', Array.from({ length: 11 }, (_, i) => i)) }, BadRequestError],
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
        b: score('?', Array.from({ length: 10 }, (_, i) => i)),
        c: score('?', ['only']),
        d: truth(undefined, 'yes'),
        e: number('?'),
        f: number('?', 0, 4095),
        g: { type: 'rank', anything: true },
      }),
    ).not.toThrow();
  });

  it('builds the grid in exact decimals', () => {
    expect(gridSize({ min: 0, max: 0.3, step: 0.1 })).toEqual({ size: 4 });
    expect(gridSize({})).toEqual({ size: 256 });
    expect(gridSize({ min: 0, max: 10, step: 3 })).toEqual({ size: 4 });
    expect(gridSize({ min: 0.25, max: 2, step: 0.5 })).toEqual({ size: 4 });
    expect(gridSize({ min: -40, max: 10 })).toEqual({ size: 51 });
    expect(gridSize({ min: -3, max: -2, step: 0.001 })).toEqual({ size: 1001 });
    expect(gridSize({ min: 0, max: 1e-6, step: 1e-7 })).toEqual({ size: 11 });
    expect(gridSize({ min: 5, max: 5 })).toEqual({ size: 1 });
    expect(gridSize({ min: 0, max: 100, step: 0.1 })).toEqual({ size: 1001 });
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

  it('sends systemone with the model and truth written as that path takes it', async () => {
    const api = fakeApi({ 'POST /v1/systemone': () => DECISION });
    await client(api.fetch).systemone({ state: 's', questions: { q: truth('?'), c: choice('?', ['a', 'b']) } });
    expect(JSON.parse(api.calls[0]!.body as string)).toEqual({
      model: 'decisionnode-latest',
      state: 's',
      questions: { q: { type: 'noul', instructions: '?' }, c: { type: 'choice', instructions: '?', criteria: { a: null, b: null } } },
    });
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
    expect(api.calls[0]!.body).toBe('{"custom_id":"a","model":"decisionnode-latest","state":"","questions":{"q":{"type":"truth","instructions":"?"}}}\n');
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
