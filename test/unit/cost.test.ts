import { describe, expect, it } from 'vitest';

import { BatchResult, Decision } from '../../src/index.js';

const answer = (usage: unknown) =>
  new Decision({ model: 'decisionnode-moe-0.9.0-rc1', answers: { q: { type: 'truth', truth: 0.5 } }, usage }, {});

describe('usage.cost', () => {
  it('reads a plain answer cost as sent', () => {
    const d = answer({ input_tokens: 62, output_tokens: 0, cost: { usd: 0.000002604, model_usd: 0.000002604, boosters_usd: 0, free_tier: false } });
    expect(d.usage.cost).toEqual({ usd: 0.000002604, modelUsd: 0.000002604, boostersUsd: 0, freeTier: false });
  });

  it('keeps usd as the server sent it, never the sum of its parts', () => {
    expect(0.000014322 + 0.036).not.toBe(0.036014322);
    const d = answer({ input_tokens: 341, output_tokens: 0, cost: { usd: 0.036014322, model_usd: 0.000014322, boosters_usd: 0.036, free_tier: false } });
    expect(d.usage.cost!.usd).toBe(0.036014322);
    expect([d.usage.cost!.modelUsd, d.usage.cost!.boostersUsd]).toEqual([0.000014322, 0.036]);
  });

  it('reads an answer covered by the free tier', () => {
    const d = answer({ input_tokens: 10, output_tokens: 0, cost: { usd: 0, model_usd: 0, boosters_usd: 0, free_tier: true } });
    expect(d.usage.cost).toEqual({ usd: 0, modelUsd: 0, boostersUsd: 0, freeTier: true });
  });

  it('is null when the server sent none, or not an object, never zeros', () => {
    expect(answer({ input_tokens: 10, output_tokens: 0 }).usage.cost).toBeNull();
    expect(answer({ input_tokens: 10, output_tokens: 0, cost: null }).usage.cost).toBeNull();
    expect(answer({ input_tokens: 10, output_tokens: 0, cost: [1] }).usage.cost).toBeNull();
    expect(answer(undefined).usage.cost).toBeNull();
  });

  it('reads a field of the wrong type as null and keeps the others', () => {
    const d = answer({ cost: { usd: '0.1', model_usd: 0.1, boosters_usd: true, free_tier: 'no' } });
    expect(d.usage.cost).toEqual({ usd: null, modelUsd: 0.1, boostersUsd: null, freeTier: null });
  });

  it('reads the cost of a batch result line', () => {
    const r = new BatchResult({
      custom_id: 't1',
      status: 200,
      body: {
        model: 'decisionnode-moe-0.9.0-rc1',
        answers: { q: { type: 'truth', truth: 0.5 } },
        usage: { input_tokens: 31, output_tokens: 0, cost: { usd: 0.000000651, model_usd: 0.000000651, boosters_usd: 0, free_tier: false } },
      },
      headers: {},
    });
    expect(r.decision!.usage.cost).toEqual({ usd: 0.000000651, modelUsd: 0.000000651, boostersUsd: 0, freeTier: false });
  });
});
