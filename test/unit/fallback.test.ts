import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BatchResult, Decision, DecisionNode, OverloadedError, truth } from '../../src/index.js';
import { OK_TRUTH, fakeFetch } from './helpers.js';

const ENV = ['DECISIONNODE_API_KEY', 'DECISIONNODE_BASE_URL', 'DECISIONNODE_MODEL'];

beforeEach(() => ENV.forEach((v) => delete process.env[v]));
afterEach(() => ENV.forEach((v) => delete process.env[v]));

function client(replies: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(replies);
  return {
    dn: new DecisionNode({
      apiKey: 'dn_test',
      baseUrl: 'https://api.example.test',
      fetch: f.fetch,
      fetchHonoursManualRedirect: true,
      sleep: async () => {},
    }),
    calls: f.calls,
  };
}

const sent = (body: string | undefined) => JSON.parse(body ?? '{}') as Record<string, unknown>;

const FALLBACK_ANSWER = {
  status: 200,
  body: { model: 'decisionnode-1.0-flash', answers: { q: { type: 'truth', truth: 0.9 } }, usage: { input_tokens: 9, output_tokens: 0 } },
  headers: {
    'x-request-id': 'req_f',
    'x-decisionnode-model': 'decisionnode-1.0-flash',
    'x-decisionnode-fallback': 'decisionnode-1.0-flash',
    'x-decisionnode-requested-model': 'decisionnode-1.0',
  },
};

describe('the fallback option', () => {
  it('is sent as given on decide, and left out when not given', async () => {
    const { dn, calls } = client([OK_TRUTH]);
    await dn.decide({ questions: { q: truth('?') }, fallback: false });
    await dn.decide({ questions: { q: truth('?') }, fallback: true });
    await dn.decide({ questions: { q: truth('?') } });
    await dn.decide({ questions: { q: truth('?') }, fallback: null });
    expect(calls.map((c) => sent(c.body).fallback)).toEqual([false, true, undefined, undefined]);
    expect(calls[2]!.body).not.toContain('fallback');
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
    await dn.check({ instructions: '?', fallback: false });
    await dn.classify({ instructions: '?', options: ['a'], fallback: false });
    await dn.score({ instructions: '?', levels: ['x'], fallback: false });
    await dn.number({ instructions: '?', fallback: false });
    await dn.gate({ action: 'deploy', fallback: false });
    expect(calls.map((c) => sent(c.body).fallback)).toEqual([false, false, false, false, false]);
  });

  it('goes on decideMany requests and batch lines', async () => {
    const { dn, calls } = client([OK_TRUTH]);
    await dn.decideMany([{ questions: { q: truth('?') }, fallback: false }, { questions: { q: truth('?') } }], { concurrency: 1 });
    expect(calls.map((c) => sent(c.body).fallback)).toEqual([false, undefined]);

    const batch = client([{ status: 201, body: { id: 'batch_1', state: 'draft', counters: {}, created_at: 'x', ended_at: null } }]);
    await batch.dn.batches.create([
      { customId: 'a', questions: { q: truth('?') }, fallback: false },
      { customId: 'b', questions: { q: truth('?') } },
    ]);
    const lines = batch.calls[0]!.body!.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]!.fallback).toBe(false);
    expect('fallback' in lines[1]!).toBe(false);
    await expect(
      batch.dn.checkRequest('batches.create', [{ customId: 'a', questions: { q: truth('?') }, fallback: true }]),
    ).resolves.toBeUndefined();
  });

  it('refuses a value that is not true or false before anything is sent', async () => {
    const { dn, calls } = client([OK_TRUTH]);
    const bad = 'no' as unknown as boolean;
    await expect(dn.decide({ questions: { q: truth('?') }, fallback: bad })).rejects.toBeInstanceOf(TypeError);
    await expect(dn.check({ instructions: '?', fallback: bad })).rejects.toBeInstanceOf(TypeError);
    await expect(dn.decideMany([{ questions: { q: truth('?') } }, { questions: { q: truth('?') }, fallback: bad }])).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(dn.checkRequest('decide', { questions: { q: truth('?') }, fallback: bad })).rejects.toBeInstanceOf(TypeError);
    await expect(dn.batches.create([{ customId: 'a', questions: { q: truth('?') }, fallback: bad }])).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });
});

describe('Decision.fallback', () => {
  it('names the model that answered and the one asked for on a fallback answer', async () => {
    const { dn } = client([FALLBACK_ANSWER]);
    const d = await dn.decide({ questions: { q: truth('?') }, model: 'decisionnode-1.0' });
    expect(d.fallback).toEqual({ servedModel: 'decisionnode-1.0-flash', requestedModel: 'decisionnode-1.0' });
    expect(d.model).toBe('decisionnode-1.0-flash');
  });

  it('is null on an ordinary answer', async () => {
    const { dn } = client([OK_TRUTH]);
    const d = await dn.decide({ questions: { q: truth('?') } });
    expect(d.fallback).toBeNull();
  });

  it('keeps requestedModel null when only the served model is sent', () => {
    const d = new Decision({ model: 'decisionnode-1.0-flash', answers: {} }, { 'x-decisionnode-fallback': 'decisionnode-1.0-flash' });
    expect(d.fallback).toEqual({ servedModel: 'decisionnode-1.0-flash', requestedModel: null });
  });

  it('is read from a batch line headers', () => {
    const r = new BatchResult({
      custom_id: 'a',
      status: 200,
      body: FALLBACK_ANSWER.body,
      headers: { 'X-DecisionNode-Fallback': 'decisionnode-1.0-flash', 'X-DecisionNode-Requested-Model': 'decisionnode-1.0' },
    });
    expect(r.decision!.fallback).toEqual({ servedModel: 'decisionnode-1.0-flash', requestedModel: 'decisionnode-1.0' });
  });

  it('a fallback: false request answered 529 is an OverloadedError, retried as every 529', async () => {
    const overloaded = {
      status: 529,
      body: { detail: { error_type: 'overloaded_error', message: 'No worker is ready.' } },
      headers: { 'retry-after-ms': '10' },
    };
    const { dn, calls } = client([overloaded]);
    const err = await dn.decide({ questions: { q: truth('?') }, model: 'decisionnode-1.0', fallback: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OverloadedError);
    expect(calls).toHaveLength(3);
  });
});
