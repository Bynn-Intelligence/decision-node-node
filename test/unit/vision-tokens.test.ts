import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BatchResult, Decision, DecisionNode, truth } from '../../src/index.js';
import { fakeFetch } from './helpers.js';

const ENV = ['DECISIONNODE_API_KEY', 'DECISIONNODE_BASE_URL', 'DECISIONNODE_MODEL'];

beforeEach(() => ENV.forEach((v) => delete process.env[v]));
afterEach(() => ENV.forEach((v) => delete process.env[v]));

const IMAGE = 'x-decisionnode-image-tokens';
const VIDEO = 'x-decisionnode-video-tokens';
const BODY = { model: 'decisionnode-flash', answers: {}, usage: { input_tokens: 1300, output_tokens: 0 } };

function read(headers: Record<string, string>): [number | null, number | null] {
  const body = structuredClone(BODY);
  const d = new Decision(body, headers);
  // The shares never change the input count and never reach raw.
  expect(d.usage.inputTokens).toBe(1300);
  expect(d.raw).toEqual(BODY);
  return [d.usage.imageTokens, d.usage.videoTokens];
}

describe('image and video token shares', () => {
  it('reads both headers', () => {
    expect(read({ [IMAGE]: '1024', [VIDEO]: '256' })).toEqual([1024, 256]);
  });

  it('reads null for both without the headers', () => {
    expect(read({})).toEqual([null, null]);
  });

  for (const name of [IMAGE, VIDEO]) {
    const one = (value: string): number | null => {
      const [image, video] = read({ [name]: value });
      if (name === IMAGE) {
        expect(video).toBeNull();
        return image;
      }
      expect(image).toBeNull();
      return video;
    };

    it(`${name}: reads a whole number from 0 to 2^31 - 1, spaces around trimmed`, () => {
      expect(one('512')).toBe(512);
      expect(one('0')).toBe(0);
      expect(one('  77 ')).toBe(77);
      expect(one('2147483647')).toBe(2147483647);
    });

    it(`${name}: reads null for an empty, negative, non-number or too large value`, () => {
      for (const bad of ['', '   ', '-1', '-0', '+5', '12.0', '1e3', 'abc', '12 3', '0x10', '2147483648', '99999999999999999999999']) {
        expect(one(bad), JSON.stringify(bad)).toBeNull();
      }
    });
  }

  it('a decide reads them from the response headers', async () => {
    const f = fakeFetch([
      {
        status: 200,
        body: { model: 'decisionnode-flash', answers: { q: { type: 'truth', truth: 0.9 } }, usage: { input_tokens: 1400, output_tokens: 0 } },
        headers: { 'x-request-id': 'req_9', [IMAGE]: '1024', [VIDEO]: '300' },
      },
    ]);
    const dn = new DecisionNode({ apiKey: 'dn_test', baseUrl: 'https://api.example.test', fetch: f.fetch, fetchHonoursManualRedirect: true, maxRetries: 0 });
    const d = await dn.decide({ state: 's', questions: { q: truth('?') } });
    expect(d.requestId).toBe('req_9');
    expect(d.usage.inputTokens).toBe(1400);
    expect([d.usage.imageTokens, d.usage.videoTokens]).toEqual([1024, 300]);
    expect((d.raw.usage as Record<string, unknown>).image_tokens).toBeUndefined();
  });

  it('a batch line without the headers reads null for both', () => {
    const r = new BatchResult({ custom_id: 'a', status: 200, body: BODY, headers: { 'x-request-id': 'req_1' } });
    expect(r.decision!.requestId).toBe('req_1');
    expect([r.decision!.usage.imageTokens, r.decision!.usage.videoTokens]).toEqual([null, null]);
  });
});
