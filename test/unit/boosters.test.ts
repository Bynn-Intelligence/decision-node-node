import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgeReading,
  AiGeneratedReading,
  BadRequestError,
  BatchResult,
  Booster,
  Decision,
  DecisionNode,
  Evidence,
  Image,
  ModelInfo,
  OverloadedError,
  PermissionDeniedError,
  RefusalError,
  UnknownReading,
  Video,
  VideoFrame,
  parseBoostersHeader,
  truth,
} from '../../src/index.js';
import { OK_TRUTH, fakeFetch } from './helpers.js';

const ENV = ['DECISIONNODE_API_KEY', 'DECISIONNODE_BASE_URL', 'DECISIONNODE_MODEL'];
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGM8ISfHwMDAxMDAwMDAAAANBAEIfXHKZgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

beforeEach(() => ENV.forEach((v) => delete process.env[v]));
afterEach(() => ENV.forEach((v) => delete process.env[v]));

function client(replies: Parameters<typeof fakeFetch>[0], extra: ConstructorParameters<typeof DecisionNode>[0] = {}) {
  const f = fakeFetch(replies);
  return {
    dn: new DecisionNode({ apiKey: 'dn_test', baseUrl: 'https://api.example.test', fetch: f.fetch, fetchHonoursManualRedirect: true, ...extra }),
    calls: f.calls,
  };
}

const sent = (body: string | undefined) => JSON.parse(body ?? '{}') as Record<string, unknown>;

const EVIDENCE = {
  age: {
    version: 'age-v3',
    status: 'ok',
    latency_ms: 212,
    results: [
      { image: 'a1b2', age_years: 27, low: 22, high: 33, confidence: 0.81, faces: 1 },
      { image: 'c3d4', faces: 0 },
    ],
  },
  ai_generated: {
    version: 'ai_generated-v2',
    status: 'ok',
    latency_ms: 340,
    results: [
      {
        image: 'c3d4',
        generated: 0.93,
        confidence: 0.86,
        method: 'inference',
        top_generator: { name: 'generator-a', probability: 0.71 },
        c2pa_signer: null,
      },
    ],
  },
};

const BOOSTED = {
  status: 200,
  body: {
    model: 'decisionnode-1.0',
    answers: { q: { type: 'truth', truth: 0.97 } },
    evidence: EVIDENCE,
    usage: { input_tokens: 341, output_tokens: 0, booster_tokens: 72, boosters: 3 },
  },
  headers: { 'x-request-id': 'req_b', 'x-decisionnode-boosters': 'age=ok:212,ai_generated=ok:340' },
};

describe('the boosters option', () => {
  it('sends names, Boosters and wire-form objects in order, each setting only when given', async () => {
    const { dn, calls } = client([OK_TRUTH]);
    await dn.decide({
      questions: { q: truth('?') },
      images: [Image.fromUrl('a1b2', 'https://files.example.com/a1b2.jpg'), Image.fromUrl('c3d4', 'https://files.example.com/c3d4.jpg')],
      boosters: [
        'age',
        new Booster('ai_generated', { images: ['c3d4'], require: true }),
        new Booster('moderation', { require: false, options: { level: 'strict' } }),
        new Booster('faces'),
        { booster: 'text', images: ['a1b2'] },
      ],
    });
    expect(sent(calls[0]!.body).boosters).toEqual([
      'age',
      { booster: 'ai_generated', images: ['c3d4'], require: true },
      { booster: 'moderation', require: false, options: { level: 'strict' } },
      { booster: 'faces' },
      { booster: 'text', images: ['a1b2'] },
    ]);
  });

  it('leaves the key out when none or an empty list is given, so the body is the one without boosters', async () => {
    const { dn, calls } = client([OK_TRUTH]);
    const base = { questions: { q: truth('?') }, videos: [new Video('v', [new VideoFrame(0, PNG)])] };
    await dn.decide(base);
    await dn.decide({ ...base, boosters: [] });
    await dn.decide({ ...base, boosters: null });
    expect(calls[0]!.body).not.toContain('boosters');
    expect(calls[1]!.body).toBe(calls[0]!.body);
    expect(calls[2]!.body).toBe(calls[0]!.body);
  });

  it('sends boosters after the videos', async () => {
    const { dn, calls } = client([OK_TRUTH]);
    await dn.decide({ questions: { q: truth('?') }, videos: [new Video('v', [new VideoFrame(0, PNG)])], boosters: ['age'] });
    expect(Object.keys(sent(calls[0]!.body))).toEqual(['model', 'state', 'questions', 'videos', 'boosters']);
  });

  it('checks nothing about boosters locally: the server answers', async () => {
    const { dn, calls } = client([OK_TRUTH]);
    const odd = ['age', 'age', 'nope', { name: 'x' }, 5, 'ai_generated'];
    await dn.decide({ questions: { q: truth('?') }, boosters: odd as never });
    expect(sent(calls[0]!.body).boosters).toEqual(odd);
    await dn.decide({ questions: { q: truth('?') }, boosters: 'age' as never });
    expect(sent(calls[1]!.body).boosters).toBe('age');
  });

  it('counts the nesting of a booster options toward the request limit', async () => {
    let deep: unknown = 1;
    for (let i = 0; i < 125; i++) deep = [deep];
    const { dn, calls } = client([OK_TRUTH]);
    // body, boosters, the booster, options, 125 arrays: 129 levels.
    const err = await dn
      .decide({ questions: { q: truth('?') }, boosters: [new Booster('age', { options: { x: deep as unknown[] } })] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as BadRequestError).message).toBe('Invalid request.');
    expect(calls).toHaveLength(0);
    await expect(
      dn.checkRequest('decide', { questions: { q: truth('?') }, boosters: [{ booster: 'age', options: { x: deep as unknown[] } }] }),
    ).rejects.toBeInstanceOf(BadRequestError);
    // One level less is sent.
    await dn.decide({ questions: { q: truth('?') }, boosters: [new Booster('age', { options: { x: (deep as unknown[])[0] as unknown[] } })] });
    expect(calls).toHaveLength(1);
  });

  it('goes on every helper', async () => {
    const reply = (id: string, answer: Record<string, unknown>) => ({ status: 200, body: { model: 'm', answers: { [id]: answer } } });
    const { dn, calls } = client([
      reply('check', { type: 'truth', truth: 0.5 }),
      reply('classify', { type: 'choice', choice: 'a', confidence: 1, probabilities: { a: 1 } }),
      reply('score', { type: 'score', score: 0, confidence: 1, probabilities: { 0: 1 }, legend: { 0: 'x' } }),
      reply('number', { type: 'number', number: 1, expected: 1, confidence: 1, probabilities: { 1: 1 } }),
      OK_TRUTH,
    ]);
    const boosters = ['age'];
    await dn.check({ instructions: '?', boosters });
    await dn.classify({ instructions: '?', options: ['a'], boosters });
    await dn.score({ instructions: '?', levels: ['x'], boosters });
    await dn.number({ instructions: '?', boosters });
    await dn.gate({ action: 'deploy', boosters });
    expect(calls.map((c) => sent(c.body).boosters)).toEqual([boosters, boosters, boosters, boosters, boosters]);
  });

  it('goes on decideMany requests and batch lines', async () => {
    const { dn, calls } = client([OK_TRUTH]);
    await dn.decideMany([
      { questions: { q: truth('?') }, boosters: ['age'] },
      { questions: { q: truth('?') } },
    ]);
    expect(calls.map((c) => sent(c.body).boosters)).toEqual([['age'], undefined]);

    const batch = client([{ status: 201, body: { id: 'batch_1', state: 'draft', counters: {}, created_at: 'x', ended_at: null } }]);
    await batch.dn.batches.create([
      { customId: 'a', questions: { q: truth('?') }, boosters: [new Booster('age', { require: true })] },
      { customId: 'b', questions: { q: truth('?') } },
    ]);
    const lines = batch.calls[0]!.body!.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]!.boosters).toEqual([{ booster: 'age', require: true }]);
    expect('boosters' in lines[1]!).toBe(false);
    await expect(
      batch.dn.checkRequest('batches.create', [{ customId: 'a', questions: { q: truth('?') }, boosters: ['age'] }]),
    ).resolves.toBeUndefined();
  });

  it('sends a fine-tuned model name as given and reads the pinned name back', async () => {
    const pinned = 'decisionnode-1.0-flash@acme/fraud:3';
    const { dn, calls } = client([{ status: 200, body: { model: pinned, answers: {} }, headers: { 'x-decisionnode-model': pinned } }], {
      model: 'decisionnode-1.0-flash@acme/fraud',
    });
    const d = await dn.decide({ questions: { q: truth('?') } });
    expect(sent(calls[0]!.body).model).toBe('decisionnode-1.0-flash@acme/fraud');
    expect(d.model).toBe(pinned);
    await dn.decide({ questions: { q: truth('?') }, model: pinned });
    expect(sent(calls[1]!.body).model).toBe(pinned);
  });
});

describe('evidence', () => {
  it('reads every booster in order, with typed readings', async () => {
    const { dn } = client([BOOSTED]);
    const d = await dn.decide({ questions: { q: truth('?') }, boosters: ['age', 'ai_generated'] });
    expect(Object.keys(d.evidence!)).toEqual(['age', 'ai_generated']);
    const age = d.evidence!.age!;
    expect(age).toBeInstanceOf(Evidence);
    expect([age.version, age.status, age.latencyMs]).toEqual(['age-v3', 'ok', 212]);
    const [first, second] = age.results;
    expect(first).toBeInstanceOf(AgeReading);
    expect(first).toMatchObject({ image: 'a1b2', faces: 1, ageYears: 27, low: 22, high: 33, confidence: 0.81 });
    // No face: the age fields are null.
    expect(second).toBeInstanceOf(AgeReading);
    expect(second).toMatchObject({ image: 'c3d4', faces: 0, ageYears: null, low: null, high: null, confidence: null });
    const gen = d.evidence!.ai_generated!.results[0]!;
    expect(gen).toBeInstanceOf(AiGeneratedReading);
    expect(gen).toMatchObject({
      image: 'c3d4',
      generated: 0.93,
      confidence: 0.86,
      method: 'inference',
      topGenerator: { name: 'generator-a', probability: 0.71 },
      c2paSigner: null,
    });
    expect(d.usage.boosterTokens).toBe(72);
    expect(d.usage.boosters).toBe(3);
  });

  it('reads a c2pa reading with its signer, and a timed-out and a skipped booster with no results', () => {
    const d = new Decision(
      {
        model: 'm',
        answers: {},
        evidence: {
          ai_generated: {
            version: 'ai_generated-v2',
            status: 'ok',
            latency_ms: 40,
            results: [
              {
                image: 'a',
                generated: 1,
                confidence: 1,
                method: 'c2pa',
                top_generator: { name: 'generator-b', probability: 0.64 },
                c2pa_signer: 'Example Camera Co.',
              },
            ],
          },
          age: { version: 'age-v3', status: 'timeout', latency_ms: 800, results: [] },
          faces: { version: 'faces-v1', status: 'skipped', latency_ms: 0, results: [] },
        },
      },
      {},
    );
    const gen = d.evidence!.ai_generated!.results[0] as AiGeneratedReading;
    expect([gen.method, gen.c2paSigner, gen.topGenerator]).toEqual(['c2pa', 'Example Camera Co.', { name: 'generator-b', probability: 0.64 }]);
    expect([d.evidence!.age!.status, d.evidence!.age!.results]).toEqual(['timeout', []]);
    expect([d.evidence!.faces!.status, d.evidence!.faces!.results]).toEqual(['skipped', []]);
  });

  it('keeps an unknown booster reading and a malformed one as UnknownReading, and the decision stands', () => {
    const d = new Decision(
      {
        model: 'm',
        answers: { q: { type: 'truth', truth: 0.5 } },
        evidence: {
          objects: { version: 'objects-v1', status: 'ok', latency_ms: 5, results: [{ image: 'a', labels: ['crate'] }] },
          age: {
            version: 'age-v3',
            status: 'ok',
            latency_ms: 5,
            results: [
              { image: 'a', faces: 1, age_years: '27', low: 22, high: 33, confidence: 0.8 },
              { image: 'b', faces: 1, low: 22, high: 33, confidence: 0.8 },
              { image: 'c', faces: true },
              { image: 'd', faces: 1, age_years: 27.5, low: 22, high: 33, confidence: 0.8 },
              { image: 'e', faces: -1 },
              { faces: 0 },
              'not a reading',
            ],
          },
          ai_generated: {
            status: 'ok',
            results: [
              { image: 'a', generated: 0.5, confidence: 0.5, method: 'inference', top_generator: { name: 1, probability: 0.5 } },
              { image: 'b', generated: 0.5, confidence: 0.5, method: 'inference', c2pa_signer: 7 },
              { image: 'c', generated: true, confidence: 0.5, method: 'inference' },
              // No top_generator, and no c2pa_signer key: each is required.
              { image: 'd', generated: 0.5, confidence: 0.5, method: 'inference', c2pa_signer: null },
              { image: 'e', generated: 0.5, confidence: 0.5, method: 'inference', top_generator: { name: 'g', probability: 0.5 } },
            ],
          },
        },
      },
      {},
    );
    const objects = d.evidence!.objects!.results[0]!;
    expect(objects).toBeInstanceOf(UnknownReading);
    expect(objects).toMatchObject({ image: 'a', raw: { image: 'a', labels: ['crate'] } });
    const age = d.evidence!.age!.results;
    expect(age.every((r) => r instanceof UnknownReading)).toBe(true);
    expect(age.map((r) => r.image)).toEqual(['a', 'b', 'c', 'd', 'e', null, null]);
    expect((age[6] as UnknownReading).raw).toEqual({ value: 'not a reading' });
    expect(d.evidence!.ai_generated!.results.every((r) => r instanceof UnknownReading)).toBe(true);
    expect(d.evidence!.ai_generated!.version).toBeNull();
    expect(d.answers.q!.type).toBe('truth');
  });

  it('reads an entry that is not an object as empty, and no evidence as null', () => {
    const d = new Decision({ model: 'm', answers: {}, evidence: { age: 'broken' } }, {});
    expect(d.evidence!.age).toMatchObject({ version: null, status: null, latencyMs: null, results: [], raw: 'broken' });
    const plain = new Decision({ model: 'm', answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }, {});
    expect(plain.evidence).toBeNull();
    expect([plain.usage.boosterTokens, plain.usage.boosters]).toEqual([null, null]);
  });

  it('reads a batch line decision as decide reads it', () => {
    const r = new BatchResult({ custom_id: 'a', status: 200, body: BOOSTED.body, headers: BOOSTED.headers });
    expect(r.decision!.evidence!.age!.results[0]).toBeInstanceOf(AgeReading);
    expect(r.decision!.usage.boosters).toBe(3);
  });
});

describe('the boosters header', () => {
  it('reads each booster status and time in order', () => {
    const h = parseBoostersHeader('age=ok:212,ai_generated=timeout:800');
    expect(Object.keys(h)).toEqual(['age', 'ai_generated']);
    expect(h).toEqual({ age: { status: 'ok', latencyMs: 212 }, ai_generated: { status: 'timeout', latencyMs: 800 } });
  });

  it('skips what it cannot read and never throws', () => {
    expect(parseBoostersHeader(undefined)).toEqual({});
    expect(parseBoostersHeader('')).toEqual({});
    expect(parseBoostersHeader(' age=ok:1 , ,=ok:2,nothing,x=error')).toEqual({
      age: { status: 'ok', latencyMs: 1 },
      x: { status: 'error', latencyMs: null },
    });
    expect(parseBoostersHeader('a=ok:12.5,b=ok:-1,c=ok:,d=skipped:0')).toEqual({
      a: { status: 'ok', latencyMs: null },
      b: { status: 'ok', latencyMs: null },
      c: { status: 'ok', latencyMs: null },
      d: { status: 'skipped', latencyMs: 0 },
    });
    // A name given twice keeps its first place and its last value.
    const twice = parseBoostersHeader('age=ok:1,x=ok:2,age=error:3');
    expect(Object.keys(twice)).toEqual(['age', 'x']);
    expect(twice.age).toEqual({ status: 'error', latencyMs: 3 });
  });
});

describe('booster errors', () => {
  const failed = (status: number, errorType: string, message: string, extra: Record<string, string> = {}) => ({
    status,
    body: { detail: { error_type: errorType, message } },
    headers: { 'x-request-id': 'req_e', 'x-decisionnode-boosters': 'age=error:31', 'retry-after-ms': '1', ...extra },
  });

  it('retries booster_unavailable as every 529, then raises it with the boosters header read', async () => {
    const { dn, calls } = client([failed(529, 'booster_unavailable', "The booster 'age' failed.")]);
    const err = await dn.decide({ questions: { q: truth('?') }, boosters: [new Booster('age', { require: true })] }).catch((e: unknown) => e);
    expect(calls).toHaveLength(3);
    expect(err).toBeInstanceOf(OverloadedError);
    expect((err as OverloadedError).errorType).toBe('booster_unavailable');
    expect((err as OverloadedError).boosters).toEqual({ age: { status: 'error', latencyMs: 31 } });
  });

  it('raises booster_not_enabled and a suspended workspace as PermissionDeniedError, never retried', async () => {
    for (const [type, message] of [
      ['booster_not_enabled', "The booster 'age' is not enabled for this workspace."],
      ['workspace_suspended', 'The workspace is suspended.'],
    ]) {
      const { dn, calls } = client([failed(403, type!, message!)]);
      const err = await dn.decide({ questions: { q: truth('?') }, boosters: ['age'] }).catch((e: unknown) => e);
      expect(calls).toHaveLength(1);
      expect(err).toBeInstanceOf(PermissionDeniedError);
      expect(err).not.toBeInstanceOf(RefusalError);
      expect([(err as PermissionDeniedError).errorType, (err as PermissionDeniedError).message]).toEqual([type, message]);
    }
  });

  it('keeps a refusal a RefusalError', async () => {
    const { dn } = client([{ status: 403, body: { detail: { error_type: 'refusal_error', message: 'Refused.', category: 'harm' } } }]);
    await expect(dn.decide({ questions: { q: truth('?') }, boosters: ['age'] })).rejects.toBeInstanceOf(RefusalError);
  });

  it('raises booster_unknown, booster_input_mismatch and a malformed list as BadRequestError, never retried', async () => {
    for (const [type, reason] of [
      ['booster_unknown', null],
      ['booster_input_mismatch', null],
      ['api_usage_error', 'boosters: at most 4 boosters, got 5'],
    ] as const) {
      const { dn, calls } = client([failed(400, type, 'x', reason ? { 'x-decisionnode-error': reason } : {})]);
      const err = await dn.decide({ questions: { q: truth('?') }, boosters: ['age'] }).catch((e: unknown) => e);
      expect(calls).toHaveLength(1);
      expect(err).toBeInstanceOf(BadRequestError);
      expect((err as BadRequestError).errorType).toBe(type);
      expect((err as BadRequestError).reason).toBe(reason);
      expect((err as BadRequestError).boosters).toEqual({ age: { status: 'error', latencyMs: 31 } });
    }
  });

  it('gives an empty map when the header is absent', async () => {
    const { dn } = client([{ status: 400, body: { detail: { error_type: 'api_usage_error', message: 'x' } } }]);
    const err = (await dn.decide({ questions: { q: truth('?') } }).catch((e: unknown) => e)) as BadRequestError;
    expect(err.boosters).toEqual({});
  });
});

describe('fine-tuned models in models()', () => {
  it('reads the four fields of a fine-tuned entry, and null on a catalogue entry', async () => {
    const catalogue = { name: 'decisionnode-1.0-flash', description: 'Fast', release_date: '2026-10-01', version: 'decisionnode-1.0-flash-0.1.0', max_images: 16 };
    const tuned = {
      name: 'decisionnode-1.0-flash@acme/fraud:3',
      description: 'Claims fraud',
      release_date: '2026-10-09',
      version: 'decisionnode-1.0-flash@acme/fraud:3',
      fine_tuned: true,
      base: 'decisionnode-1.0-flash-0.1.0',
      adapter_version: 3,
      status: 'deployed',
      max_images: 16,
    };
    const ready = { ...tuned, name: 'decisionnode-1.0-flash@acme/fraud:4', adapter_version: 4, status: 'ready' };
    const { dn } = client([{ status: 200, body: { models: [catalogue, tuned, ready] } }]);
    const [c, t, r] = await dn.models();
    expect([c!.fineTuned, c!.base, c!.adapterVersion, c!.status]).toEqual([null, null, null, null]);
    expect(t).toBeInstanceOf(ModelInfo);
    expect([t!.fineTuned, t!.base, t!.adapterVersion, t!.status]).toEqual([true, 'decisionnode-1.0-flash-0.1.0', 3, 'deployed']);
    expect(t!.limits).toMatchObject({ fine_tuned: true, adapter_version: 3, status: 'deployed', max_images: 16 });
    expect([r!.adapterVersion, r!.status]).toEqual([4, 'ready']);
  });

  it('reads a field of the wrong type as null', () => {
    const m = new ModelInfo({ name: 'x', description: '', release_date: '', fine_tuned: 'yes', base: 1, adapter_version: 1.5, status: 2 });
    expect([m.fineTuned, m.base, m.adapterVersion, m.status]).toEqual([null, null, null, null]);
  });
});

describe('names that are object keys', () => {
  it('keeps __proto__ as a plain key in evidence and in the header', () => {
    const d = new Decision(JSON.parse('{"model":"m","answers":{},"evidence":{"__proto__":{"status":"ok","results":[]}}}'), {});
    expect(Object.keys(d.evidence!)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(d.evidence)).toBe(Object.prototype);
    const h = parseBoostersHeader('__proto__=ok:1');
    expect(Object.keys(h)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(h)).toBe(Object.prototype);
  });
});
