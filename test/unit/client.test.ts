import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AuthenticationError,
  ChoiceAnswer,
  ConnectionError,
  DecisionNode,
  DecisionNodeError,
  Image,
  OverloadedError,
  RateLimitError,
  SPEC_VERSION,
  ScoreAnswer,
  ServerError,
  TimeoutError,
  TruthAnswer,
  VERSION,
  ValidationError,
  choice,
  score,
  truth,
} from '../../src/index.js';
import { OK_TRUTH, fakeFetch } from './helpers.js';
import type { FetchLike } from '../../src/index.js';

const ENV = ['DECISIONNODE_API_KEY', 'DECISIONNODE_BASE_URL', 'DECISIONNODE_MODEL'];
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGM8ISfHwMDAxMDAwMDAAAANBAEIfXHKZgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

beforeEach(() => ENV.forEach((v) => delete process.env[v]));
afterEach(() => ENV.forEach((v) => delete process.env[v]));

function client(replies: Parameters<typeof fakeFetch>[0], extra: ConstructorParameters<typeof DecisionNode>[0] = {}) {
  const f = fakeFetch(replies);
  return { dn: new DecisionNode({ apiKey: 'dn_test', baseUrl: 'https://api.example.test', fetch: f.fetch, fetchHonoursManualRedirect: true, ...extra }), calls: f.calls };
}

describe('configuration', () => {
  it('reads the environment when no argument is given', () => {
    process.env.DECISIONNODE_API_KEY = 'dn_env';
    process.env.DECISIONNODE_BASE_URL = 'https://env.example.test/';
    process.env.DECISIONNODE_MODEL = 'decisionnode-1.0-flash';
    const dn = new DecisionNode();
    expect(dn.baseUrl).toBe('https://env.example.test');
    expect(dn.model).toBe('decisionnode-1.0-flash');
  });

  it('prefers arguments over the environment', async () => {
    process.env.DECISIONNODE_API_KEY = 'dn_env';
    process.env.DECISIONNODE_MODEL = 'decisionnode-1.0-flash';
    const { dn, calls } = client([OK_TRUTH], { apiKey: 'dn_arg', model: 'decisionnode-1.0' });
    await dn.decide({ questions: { q: truth('?') } });
    expect(calls[0]!.headers.authorization).toBe('Bearer dn_arg');
    expect(JSON.parse(calls[0]!.body!).model).toBe('decisionnode-1.0');
  });

  it('treats empty strings as not given', async () => {
    process.env.DECISIONNODE_API_KEY = 'dn_env';
    process.env.DECISIONNODE_BASE_URL = 'https://env.example.test';
    process.env.DECISIONNODE_MODEL = 'decisionnode-1.0-flash';
    const f = fakeFetch([OK_TRUTH]);
    const dn = new DecisionNode({ apiKey: '', baseUrl: '', model: '', fetch: f.fetch, fetchHonoursManualRedirect: true });
    expect(dn.baseUrl).toBe('https://env.example.test');
    expect(dn.model).toBe('decisionnode-1.0-flash');
    await dn.decide({ questions: { q: truth('?') }, model: '' });
    expect(f.calls[0]!.headers.authorization).toBe('Bearer dn_env');
    expect(JSON.parse(f.calls[0]!.body!).model).toBe('decisionnode-1.0-flash');
    delete process.env.DECISIONNODE_MODEL;
    expect(new DecisionNode({ apiKey: 'k', model: '' }).model).toBe('decisionnode-latest');
  });

  it('fails before sending when the key is an empty string and none is set', async () => {
    const f = fakeFetch([OK_TRUTH]);
    const dn = new DecisionNode({ apiKey: '', fetch: f.fetch, fetchHonoursManualRedirect: true });
    await expect(dn.decide({ questions: { q: truth('?') } })).rejects.toBeInstanceOf(AuthenticationError);
    expect(f.calls).toHaveLength(0);
  });

  it('exports the specification version', () => {
    expect(SPEC_VERSION).toBe('1.0');
  });

  it('uses the defaults', () => {
    const dn = new DecisionNode({ apiKey: 'k' });
    expect(dn.baseUrl).toBe('https://api.decisionnode.com');
    expect(dn.model).toBe('decisionnode-latest');
    expect(dn.timeout).toBe(10_000);
    expect(dn.maxRetries).toBe(2);
  });

  it('refuses plain http except on a loopback host', () => {
    for (const baseUrl of ['http://api.example.test', 'http://10.0.0.5:8080', 'ftp://api.example.test', 'not a url']) {
      expect(() => new DecisionNode({ apiKey: 'k', baseUrl })).toThrow(TypeError);
    }
    process.env.DECISIONNODE_BASE_URL = 'http://api.example.test';
    expect(() => new DecisionNode({ apiKey: 'k' })).toThrow(TypeError);
    delete process.env.DECISIONNODE_BASE_URL;
    for (const baseUrl of ['http://localhost:8787', 'http://127.0.0.1:1', 'http://[::1]:9000/', 'https://api.example.test']) {
      expect(() => new DecisionNode({ apiKey: 'k', baseUrl })).not.toThrow();
    }
  });

  it('refuses a timeout of 0 or less and maxRetries below 0', () => {
    for (const timeout of [0, -1, Number.NaN]) {
      expect(() => new DecisionNode({ apiKey: 'k', timeout })).toThrow(RangeError);
    }
    for (const maxRetries of [-1, 1.5, Number.NaN]) {
      expect(() => new DecisionNode({ apiKey: 'k', maxRetries })).toThrow(RangeError);
    }
    expect(new DecisionNode({ apiKey: 'k', maxRetries: 0 }).maxRetries).toBe(0);
  });

  it('fails before sending when there is no key', async () => {
    const f = fakeFetch([OK_TRUTH]);
    const dn = new DecisionNode({ fetch: f.fetch, fetchHonoursManualRedirect: true });
    await expect(dn.decide({ questions: { q: truth('?') } })).rejects.toBeInstanceOf(AuthenticationError);
    expect(f.calls).toHaveLength(0);
  });

  it('does not expose the key', () => {
    const dn = new DecisionNode({ apiKey: 'dn_secret' });
    expect(JSON.stringify(dn)).not.toContain('dn_secret');
    expect(Object.values(dn)).not.toContain('dn_secret');
  });
});

describe('decide', () => {
  it('sends the request and reads the decision', async () => {
    const { dn, calls } = client([OK_TRUTH], { headers: { 'X-Team': 'support' } });
    const d = await dn.decide({ state: { ticket: 'charged twice' }, questions: { q: truth('Escalate?') } });
    expect(calls[0]!.url).toBe('https://api.example.test/v1/decide');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers['user-agent']).toBe(`decisionnode-node/${VERSION}`);
    expect(calls[0]!.redirect).toBe('manual');
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[0]!.headers['x-team']).toBe('support');
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      model: 'decisionnode-latest',
      state: { ticket: 'charged twice' },
      questions: { q: { type: 'truth', instructions: 'Escalate?' } },
    });
    expect(d.answers.q).toBeInstanceOf(TruthAnswer);
    expect(d.answers.q.truth).toBe(0.94);
    expect(d.model).toBe('decisionnode-1.0');
    expect(d.requestId).toBe('req_1');
    expect(d.latencyMs).toBe(23);
    expect(d.safety).toEqual({ checked: true, harm: 0.031, selfHarm: 0.004, flagged: [] });
  });

  it('sends an empty string when there is no state', async () => {
    const { dn, calls } = client([OK_TRUTH]);
    await dn.decide({ questions: { q: truth('Is hotdog a sandwich?') } });
    expect(JSON.parse(calls[0]!.body!).state).toBe('');
  });

  it('refuses an empty question map before sending', async () => {
    const { dn, calls } = client([OK_TRUTH]);
    await expect(dn.decide({ questions: {} })).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });

  it('refuses a value that cannot be serialised before sending', async () => {
    const { dn, calls } = client([OK_TRUTH]);
    const state: Record<string, unknown> = {};
    state.self = state;
    await expect(dn.decide({ state, questions: { q: truth('?') } })).rejects.toBeInstanceOf(TypeError);
    await expect(dn.decide({ state: { n: 1n }, questions: { q: truth('?') } })).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });

  it('sends images from bytes, a blob and a url', async () => {
    const { dn, calls } = client([OK_TRUTH]);
    await dn.decide({
      questions: { q: truth('?') },
      images: [
        Image.fromBytes('a', PNG),
        Image.fromBytes('b', new Blob([PNG], { type: 'image/png' })),
        Image.fromUrl('c', 'https://example.com/c.jpg'),
        { id: 'd', url: 'https://example.com/d.jpg' },
      ],
    });
    const images = JSON.parse(calls[0]!.body!).images;
    expect(images[0]).toEqual({ id: 'a', media_type: 'image/png', data: btoa(String.fromCharCode(...PNG)) });
    expect(images[1].media_type).toBe('image/png');
    expect(images[2]).toEqual({ id: 'c', url: 'https://example.com/c.jpg' });
    expect(images[3]).toEqual({ id: 'd', url: 'https://example.com/d.jpg' });
  });

  it('reads an image file when the Image is made, and fails there when it cannot', () => {
    expect(() => Image.fromPath('x', '/nonexistent/receipt.jpg')).toThrow(TypeError);
    const dir = mkdtempSync(join(tmpdir(), 'dn-img-'));
    const file = join(dir, 'pixel.png');
    writeFileSync(file, PNG);
    const img = Image.fromPath('p', file);
    expect(img.mediaType).toBe('image/png');
    writeFileSync(file, 'not an image');
    expect(() => Image.fromPath('t', file)).toThrow(TypeError);
  });

  it('detects the media type of bytes given without one, and refuses an unknown format', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    const webp = new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ');
    expect(Image.fromBytes('a', PNG).mediaType).toBe('image/png');
    expect(Image.fromBytes('b', jpeg).mediaType).toBe('image/jpeg');
    expect(Image.fromBytes('c', webp.buffer).mediaType).toBe('image/webp');
    expect(() => Image.fromBytes('x', new Uint8Array([1, 2, 3]))).toThrow(TypeError);
    const { dn, calls } = client([OK_TRUTH]);
    await expect(
      dn.decide({ questions: { q: truth('?') }, images: [Image.fromBytes('y', new Blob([new Uint8Array([1, 2, 3])]))] }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });

  it('logs method, path, status, request id and time, never the content', async () => {
    const lines: string[] = [];
    const { dn } = client([OK_TRUTH], { logger: (l) => lines.push(l) });
    await dn.decide({ state: 'secret state', questions: { q: truth('secret question') } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^decisionnode POST \/v1\/decide 200 req_1 \d+ms$/);
    expect(lines[0]).not.toContain('secret');
    expect(lines[0]).not.toContain('dn_test');
  });
});

describe('helpers', () => {
  const answer = (id: string, a: unknown) => ({
    status: 200,
    body: { model: 'decisionnode-1.0', answers: { [id]: a }, usage: { input_tokens: 1, output_tokens: 0 } },
  });

  it('check sends one truth question under the id check', async () => {
    const { dn, calls } = client([answer('check', { type: 'truth', truth: 0.7 })]);
    const a = await dn.check({ state: 'refund me', instructions: 'Refund?', ifTrue: 'asks for money', ifFalse: 'other' });
    expect(a.truth).toBe(0.7);
    expect(JSON.parse(calls[0]!.body!).questions).toEqual({
      check: { type: 'truth', instructions: 'Refund?', criteria: { true: 'asks for money', false: 'other' } },
    });
  });

  it('classify sends one choice question under the id classify', async () => {
    const { dn, calls } = client([
      answer('classify', { type: 'choice', choice: 'bug', confidence: 0.5, probabilities: { billing: 0.25, bug: 0.75 } }),
    ]);
    const a = await dn.classify({ state: 's', instructions: 'Route?', options: ['billing', 'bug'] });
    expect(a).toBeInstanceOf(ChoiceAnswer);
    expect(a.choice).toBe('bug');
    expect(JSON.parse(calls[0]!.body!).questions.classify.criteria).toEqual({ billing: null, bug: null });
  });

  it('score sends one score question under the id score', async () => {
    const { dn, calls } = client([
      answer('score', { type: 'score', score: 1.2, confidence: 0.5, legend: { '0': 'a', '1': 'b' }, probabilities: { '0': 0.4, '1': 0.6 } }),
    ]);
    const a = await dn.score({ state: 's', instructions: 'How?', levels: ['a', 'b'], model: 'decisionnode-1.0-flash' });
    expect(a).toBeInstanceOf(ScoreAnswer);
    expect(a.probabilities[1]).toBe(0.6);
    const body = JSON.parse(calls[0]!.body!);
    expect(body.model).toBe('decisionnode-1.0-flash');
    expect(body.questions.score).toEqual({ type: 'score', instructions: 'How?', criteria: ['a', 'b'] });
  });

  it('gate sends the action, the context and three fixed questions', async () => {
    const { dn, calls } = client([OK_TRUTH]);
    await dn.gate({ action: 'rm -rf /var/data', context: { host: 'db-1' } });
    const body = JSON.parse(calls[0]!.body!);
    expect(body.state).toEqual({ action: 'rm -rf /var/data', context: { host: 'db-1' } });
    expect(Object.keys(body.questions)).toEqual(['risk', 'touches_production', 'verdict']);
    expect(body.questions.risk.type).toBe('score');
    expect(body.questions.touches_production.type).toBe('truth');
    expect(Object.keys(body.questions.verdict.criteria)).toEqual(['allow', 'confirm', 'block']);
    expect(body.questions).toEqual({
      risk: {
        type: 'score',
        instructions: 'How much harm could this action cause if it is wrong?',
        criteria: ['none', 'low', 'moderate', 'high', 'severe'],
      },
      touches_production: {
        type: 'truth',
        instructions: 'Does this action change a production system, production data or anything customers use?',
      },
      verdict: {
        type: 'choice',
        instructions: 'Should this action run as it is, wait for a person to confirm it, or be blocked?',
        criteria: {
          allow: 'safe to run without asking',
          confirm: 'a person should confirm it first',
          block: 'should not run',
        },
      },
    });
  });

  const ALL_HELPERS = {
    status: 200,
    body: {
      model: 'decisionnode-1.0',
      answers: {
        check: { type: 'truth', truth: 0.7 },
        classify: { type: 'choice', choice: 'a', confidence: 0.5, probabilities: { a: 0.75, b: 0.25 } },
        score: { type: 'score', score: 0.4, confidence: 0.5, legend: { '0': 'low', '1': 'high' }, probabilities: { '0': 0.6, '1': 0.4 } },
      },
      usage: {},
    },
  };

  it.each([
    ['check', { type: 'truth', truth: '0.7' }],
    ['check', undefined],
    ['classify', { type: 'choice', choice: 'a', confidence: 0.5 }],
    ['score', { type: 'score', score: 0.4, confidence: 0.5, legend: { '0': 'low' }, probabilities: [1] }],
    ['score', { type: 'truth', truth: 0.5 }],
  ] as const)('%s raises ServerError for its own malformed or missing answer (%j)', async (method, raw) => {
    const answers = raw === undefined ? {} : { [method]: raw };
    const { dn, calls } = client([
      {
        status: 200,
        body: { model: 'decisionnode-1.0', answers, usage: {} },
        headers: { 'x-request-id': 'req_h', 'x-decisionnode-error': 'the answer could not be completed' },
      },
    ]);
    const call =
      method === 'check'
        ? dn.check({ instructions: '?' })
        : method === 'classify'
          ? dn.classify({ instructions: '?', options: ['a', 'b'] })
          : dn.score({ instructions: '?', levels: ['low', 'high'] });
    const err = await call.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerError);
    expect((err as ServerError).status).toBe(200);
    expect((err as ServerError).requestId).toBe('req_h');
    expect((err as ServerError).reason).toBe('the answer could not be completed');
    expect(calls).toHaveLength(1);
  });

  it.each(['check', 'classify', 'score', 'gate'] as const)('%s takes images and a model', async (method) => {
    const { dn, calls } = client([ALL_HELPERS]);
    const images = [Image.fromBytes('photo', PNG)];
    const model = 'decisionnode-1.0-flash';
    if (method === 'check') await dn.check({ instructions: '?', images, model });
    if (method === 'classify') await dn.classify({ instructions: '?', options: ['a', 'b'], images, model });
    if (method === 'score') await dn.score({ instructions: '?', levels: ['low', 'high'], images, model });
    if (method === 'gate') await dn.gate({ action: 'deploy', images, model });
    const body = JSON.parse(calls[0]!.body!);
    expect(body.model).toBe(model);
    expect(body.images).toHaveLength(1);
    expect(body.images[0].id).toBe('photo');
  });

  it('gate leaves out a missing context', async () => {
    const { dn, calls } = client([OK_TRUTH]);
    await dn.gate({ action: 'deploy' });
    expect(JSON.parse(calls[0]!.body!).state).toEqual({ action: 'deploy' });
  });

  it('models reads the list and its limits', async () => {
    const { dn, calls } = client([
      { status: 200, body: { models: [{ name: 'decisionnode-1.0', description: 'd', release_date: '2026-10-01', max_images: 4 }] } },
    ]);
    const models = await dn.models();
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe('https://api.example.test/v1/models');
    expect(calls[0]!.headers['content-type']).toBeUndefined();
    expect(calls[0]!.body).toBeUndefined();
    expect(models[0]!.limits).toEqual({ max_images: 4 });
  });

  it('decideRaw sends the body as given and returns the parsed body', async () => {
    const { dn, calls } = client([{ status: 200, text: '{"answers":{},"future":[1,2.5,null]}' }]);
    const body = { model: 'decisionnode-1.0', questions: { q: { type: 'truth', instructions: '?' } }, extra: true };
    const out = await dn.decideRaw<{ future: unknown[] }>(body);
    expect(JSON.parse(calls[0]!.body!)).toEqual(body);
    expect(out.future).toEqual([1, 2.5, null]);
  });

  it('accepts plain wire-form questions', async () => {
    const { dn, calls } = client([OK_TRUTH]);
    await dn.decide({
      questions: {
        route: { type: 'choice', criteria: { billing: null } },
        urgency: score('?', ['low', 'high']),
        pick: choice('?', ['a']),
      },
    });
    expect(JSON.parse(calls[0]!.body!).questions.route).toEqual({ type: 'choice', criteria: { billing: null } });
  });
});

describe('retries', () => {
  const overloaded = { status: 529, body: { detail: { error_type: 'overloaded_error' } }, headers: { 'retry-after-ms': '1' } };

  it('retries 529 and succeeds', async () => {
    const { dn, calls } = client([overloaded, OK_TRUTH]);
    const d = await dn.decide({ questions: { q: truth('?') } });
    expect(calls).toHaveLength(2);
    expect(d.requestId).toBe('req_1');
  });

  it('gives up after maxRetries', async () => {
    const { dn, calls } = client([overloaded], { maxRetries: 3 });
    await expect(dn.decide({ questions: { q: truth('?') } })).rejects.toBeInstanceOf(OverloadedError);
    expect(calls).toHaveLength(4);
  });

  it.each([400, 401, 402, 403, 404, 422])('never retries %i', async (status) => {
    const { dn, calls } = client([{ status, body: { detail: { error_type: 'x' } }, headers: { 'retry-after-ms': '1' } }]);
    await expect(dn.decide({ questions: { q: truth('?') } })).rejects.toBeInstanceOf(DecisionNodeError);
    expect(calls).toHaveLength(1);
  });

  it('retries a dropped connection, then raises ConnectionError', async () => {
    const { dn, calls } = client([{ error: 'network' }], { maxRetries: 1 });
    const started = Date.now();
    await expect(dn.decide({ questions: { q: truth('?') } })).rejects.toBeInstanceOf(ConnectionError);
    expect(calls).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300); // backoff of 0.5 s with jitter
  });

  it('times out each attempt', async () => {
    const { dn, calls } = client([{ hang: true }], { timeout: 50, maxRetries: 0 });
    await expect(dn.decide({ questions: { q: truth('?') } })).rejects.toBeInstanceOf(TimeoutError);
    expect(calls).toHaveLength(1);
  });

  it('times the whole attempt, the body included', async () => {
    const slowBody: FetchLike = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"model":'));
          },
        }),
        { status: 200 },
      );
    const dn = new DecisionNode({ apiKey: 'k', baseUrl: 'https://api.example.test', fetch: slowBody, fetchHonoursManualRedirect: true, timeout: 50, maxRetries: 0 });
    await expect(dn.decide({ questions: { q: truth('?') } })).rejects.toBeInstanceOf(TimeoutError);
  });

  it('ends an attempt on time even when the fetch ignores the signal', async () => {
    const deaf: FetchLike = () => new Promise(() => {});
    const dn = new DecisionNode({ apiKey: 'k', baseUrl: 'https://api.example.test', fetch: deaf, fetchHonoursManualRedirect: true, timeout: 50, maxRetries: 0 });
    await expect(dn.decide({ questions: { q: truth('?') } })).rejects.toBeInstanceOf(TimeoutError);
  });

  it('refuses a response from a fetch that followed a redirect anyway', async () => {
    let calls = 0;
    const following: FetchLike = async () => {
      calls++;
      const res = new Response(JSON.stringify(OK_TRUTH.body), { status: 200 });
      Object.defineProperty(res, 'redirected', { value: true });
      return res;
    };
    const dn = new DecisionNode({ apiKey: 'k', baseUrl: 'https://api.example.test', fetch: following, fetchHonoursManualRedirect: true });
    const err = await dn.decide({ questions: { q: truth('?') } }).catch((e: unknown) => e);
    expect((err as Error).constructor).toBe(DecisionNodeError);
    expect((err as Error).message).toContain('redirect');
    expect(calls).toBe(1);
  });

  it('refuses a response from another URL than the one requested', async () => {
    let calls = 0;
    const moved: FetchLike = async () => {
      calls++;
      const res = new Response(JSON.stringify(OK_TRUTH.body), { status: 200 });
      Object.defineProperty(res, 'url', { value: 'https://elsewhere.example.test/v1/decide' });
      return res;
    };
    const dn = new DecisionNode({ apiKey: 'k', baseUrl: 'https://api.example.test', fetch: moved, fetchHonoursManualRedirect: true });
    const err = await dn.decide({ questions: { q: truth('?') } }).catch((e: unknown) => e);
    expect((err as Error).constructor).toBe(DecisionNodeError);
    expect(calls).toBe(1);
  });

  it('refuses an opaque redirect', async () => {
    const opaque: FetchLike = async () => {
      const res = new Response(null, { status: 200 });
      Object.defineProperty(res, 'type', { value: 'opaqueredirect' });
      return res;
    };
    const dn = new DecisionNode({ apiKey: 'k', baseUrl: 'https://api.example.test', fetch: opaque, fetchHonoursManualRedirect: true });
    const err = await dn.decide({ questions: { q: truth('?') } }).catch((e: unknown) => e);
    expect((err as Error).constructor).toBe(DecisionNodeError);
  });

  it('stops on the caller signal without retrying', async () => {
    const { dn, calls } = client([{ hang: true }]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('stop')), 30);
    await expect(dn.decide({ questions: { q: truth('?') } }, { signal: controller.signal })).rejects.toThrow('stop');
    expect(calls).toHaveLength(1);
  });

  it('raises ServerError when a success body is not JSON', async () => {
    const { dn } = client([{ status: 200, text: 'not json' }]);
    await expect(dn.decide({ questions: { q: truth('?') } })).rejects.toThrow(ServerError);
  });

  it.each([301, 302, 303, 307, 308])('never follows a %i and does not retry it', async (status) => {
    const { dn, calls } = client([
      { status, body: { detail: { error_type: 'redirect', message: 'Moved.' } }, headers: { location: 'http://elsewhere.example.test/' } },
    ]);
    const err = await dn.decide({ questions: { q: truth('?') } }).catch((e: unknown) => e);
    expect((err as Error).constructor).toBe(DecisionNodeError);
    expect((err as DecisionNodeError).status).toBe(status);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.redirect).toBe('manual');
  });

  it('treats only 200 to 299 as success', async () => {
    const { dn } = client([{ status: 299, body: OK_TRUTH.body }]);
    await expect(dn.decide({ questions: { q: truth('?') } })).resolves.toBeDefined();
  });

  it('gives the base class to a status with no class, after its retries', async () => {
    const { dn, calls } = client([{ status: 408, body: { detail: { message: 'Timeout.' } }, headers: { 'retry-after-ms': '1' } }], {
      maxRetries: 1,
    });
    const err = await dn.decide({ questions: { q: truth('?') } }).catch((e: unknown) => e);
    expect((err as Error).constructor).toBe(DecisionNodeError);
    expect((err as Error).message).toBe('Timeout.');
    expect(calls).toHaveLength(2);
  });

  it('caps the wait the server asks for at 60 seconds, through an injectable sleep', async () => {
    const waits: number[] = [];
    const { dn } = client(
      [{ status: 429, body: { detail: { error_type: 'rate_limit_error' } }, headers: { 'retry-after': '3600' } }, OK_TRUTH],
      { sleep: async (ms) => void waits.push(ms) },
    );
    await dn.decide({ questions: { q: truth('?') } });
    expect(waits).toEqual([60_000]);
  });

  it('reports the capped wait on the error', async () => {
    const { dn } = client([{ status: 429, body: { detail: {} }, headers: { 'retry-after-ms': '600000' } }], { maxRetries: 0 });
    const err = (await dn.decide({ questions: { q: truth('?') } }).catch((e: unknown) => e)) as RateLimitError;
    expect(err.retryAfter).toBe(60);
  });
});

describe("the caller's fetch and transport", () => {
  it('refuses a caller fetch that is not confirmed to honour manual redirects', () => {
    const f = fakeFetch([OK_TRUTH]);
    expect(() => new DecisionNode({ apiKey: 'k', baseUrl: 'https://api.example.test', fetch: f.fetch })).toThrow(TypeError);
    expect(
      () => new DecisionNode({ apiKey: 'k', baseUrl: 'https://api.example.test', fetch: f.fetch, fetchHonoursManualRedirect: 'yes' as never }),
    ).toThrow(TypeError);
    expect(() => new DecisionNode({ apiKey: 'k', fetch: 'nope' as never, fetchHonoursManualRedirect: true })).toThrow(TypeError);
    expect(f.calls).toHaveLength(0);
  });

  it('calls a confirmed fetch with redirect manual', async () => {
    const f = fakeFetch([OK_TRUTH]);
    const dn = new DecisionNode({ apiKey: 'k', baseUrl: 'https://api.example.test', fetch: f.fetch, fetchHonoursManualRedirect: true });
    await dn.decide({ questions: { q: truth('?') } });
    expect(f.calls[0]!.redirect).toBe('manual');
  });

  describe('with TLS checks turned off', () => {
    beforeEach(() => {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    });
    afterEach(() => {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    });

    it('refuses an https base URL', () => {
      expect(() => new DecisionNode({ apiKey: 'k', baseUrl: 'https://api.example.test' })).toThrow(TypeError);
      expect(() => new DecisionNode({ apiKey: 'k' })).toThrow(TypeError);
    });

    it('refuses an https base URL whatever the case of its scheme', () => {
      expect(() => new DecisionNode({ apiKey: 'k', baseUrl: 'HTTPS://api.example.test' })).toThrow(TypeError);
      expect(() => new DecisionNode({ apiKey: 'k', baseUrl: 'Https://api.example.test' })).toThrow(TypeError);
      process.env.DECISIONNODE_BASE_URL = 'HTTPS://api.example.test';
      expect(() => new DecisionNode({ apiKey: 'k' })).toThrow(TypeError);
    });

    it('refuses an uppercase https scheme before sending when the setting changes after the client is made', async () => {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      const f = fakeFetch([OK_TRUTH]);
      const dn = new DecisionNode({ apiKey: 'k', baseUrl: 'HTTPS://api.example.test', fetch: f.fetch, fetchHonoursManualRedirect: true });
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      await expect(dn.decide({ questions: { q: truth('?') } })).rejects.toBeInstanceOf(TypeError);
      expect(f.calls).toHaveLength(0);
    });

    it('still allows plain http to a loopback host', () => {
      expect(() => new DecisionNode({ apiKey: 'k', baseUrl: 'http://127.0.0.1:8787' })).not.toThrow();
      expect(() => new DecisionNode({ apiKey: 'k', baseUrl: 'HTTP://127.0.0.1:8787' })).not.toThrow();
    });

    it('refuses before sending when the setting changes after the client is made', async () => {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      const f = fakeFetch([OK_TRUTH]);
      const dn = new DecisionNode({ apiKey: 'k', baseUrl: 'https://api.example.test', fetch: f.fetch, fetchHonoursManualRedirect: true });
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      await expect(dn.decide({ questions: { q: truth('?') } })).rejects.toBeInstanceOf(TypeError);
      expect(f.calls).toHaveLength(0);
    });
  });
});

describe('decideMany', () => {
  it('returns results in input order with failures in place', async () => {
    const f = fakeFetch([]);
    let inFlight = 0;
    let peak = 0;
    const fetch: typeof f.fetch = async (_url, init) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      const state = JSON.parse(String(init.body)).state as string;
      await new Promise((r) => setTimeout(r, state === 'a' ? 40 : 5));
      inFlight--;
      if (state === 'b') return new Response(JSON.stringify({ detail: [] }), { status: 422 });
      return new Response(
        JSON.stringify({ model: 'm', answers: { q: { type: 'truth', truth: state === 'a' ? 0.1 : 0.3 } }, usage: {} }),
        { status: 200 },
      );
    };
    const dn = new DecisionNode({ apiKey: 'k', baseUrl: 'https://api.example.test', fetch, fetchHonoursManualRedirect: true });
    const results = await dn.decideMany(
      ['a', 'b', 'c', 'd'].map((state) => ({ state, questions: { q: truth('?') } })),
      { concurrency: 2 },
    );
    expect(peak).toBe(2);
    expect(results).toHaveLength(4);
    expect((results[0] as { answers: { q: TruthAnswer } }).answers.q.truth).toBe(0.1);
    expect(results[1]).toBeInstanceOf(ValidationError);
    expect((results[2] as { answers: { q: TruthAnswer } }).answers.q.truth).toBe(0.3);
    expect(results[3]).not.toBeInstanceOf(Error);
  });

  it('checks every request before sending any: an invalid last request sends nothing', async () => {
    const { dn, calls } = client([OK_TRUTH]);
    await expect(
      dn.decideMany([{ questions: { q: truth('a?') } }, { questions: { q: truth('b?') } }, { questions: {} }], { concurrency: 1 }),
    ).rejects.toBeInstanceOf(TypeError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(
      dn.decideMany([{ questions: { q: truth('a?') } }, { state: cyclic, questions: { q: truth('b?') } }], { concurrency: 1 }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(dn.decideMany([{ questions: { q: truth('a?') } }, null as never])).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });

  it.each([0, -1, Number.NaN])('rejects a concurrency of %s before sending', async (concurrency) => {
    const { dn, calls } = client([OK_TRUTH]);
    await expect(dn.decideMany([{ questions: { q: truth('?') } }], { concurrency })).rejects.toBeInstanceOf(RangeError);
    expect(calls).toHaveLength(0);
  });

  it('handles an empty list', async () => {
    const { dn } = client([OK_TRUTH]);
    expect(await dn.decideMany([])).toEqual([]);
  });
});
