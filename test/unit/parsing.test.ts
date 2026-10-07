import { describe, expect, it } from 'vitest';

import {
  AuthenticationError,
  BadRequestError,
  ChoiceAnswer,
  ContextLimitError,
  Decision,
  DecisionNodeError,
  InsufficientCreditError,
  ModelInfo,
  NotFoundError,
  OverloadedError,
  PermissionDeniedError,
  RateLimitError,
  RefusalError,
  ScoreAnswer,
  ServerError,
  TruthAnswer,
  UnknownAnswer,
  ValidationError,
  parseSafety,
} from '../../src/index.js';
import { errorFromResponse, retryAfterSeconds } from '../../src/errors.js';

describe('parseSafety', () => {
  it('is null without a header', () => {
    expect(parseSafety(undefined)).toBeNull();
  });

  it('reads both categories', () => {
    expect(parseSafety('harm=0.031, self_harm=0.004')).toEqual({ checked: true, harm: 0.031, selfHarm: 0.004, flagged: [] });
  });

  it('lists flagged and blocked categories in header order', () => {
    expect(parseSafety('harm=0.912;flagged, self_harm=0.95;blocked')).toEqual({
      checked: true,
      harm: 0.912,
      selfHarm: 0.95,
      flagged: ['harm', 'self_harm'],
    });
  });

  it('reads an unchecked header and its reason', () => {
    expect(parseSafety('unchecked;reason="no-model-question"')).toEqual({ checked: false, reason: 'no-model-question' });
    expect(parseSafety('unchecked')).toEqual({ checked: false, reason: null });
  });

  it('ignores categories it does not know', () => {
    expect(parseSafety('harm=0.1, other=0.9;flagged')).toEqual({ checked: true, harm: 0.1, selfHarm: null, flagged: ['other'] });
  });
});

describe('answers', () => {
  it('keeps long floats as sent', () => {
    const body = JSON.parse(
      '{"model":"decisionnode-1.0","answers":{"r":{"type":"choice","choice":"a","confidence":0.64,"probabilities":{"a":0.8200000000000001,"b":0.18}}},"usage":{"input_tokens":1,"output_tokens":0}}',
    );
    const d = new Decision(body, {});
    const a = d.answers.r as ChoiceAnswer;
    expect(a).toBeInstanceOf(ChoiceAnswer);
    expect(a.probabilities.a).toBe(0.8200000000000001);
  });

  it('reads score maps by integer index', () => {
    const a = new ScoreAnswer({
      type: 'score',
      score: 1.7,
      confidence: 0.45,
      legend: { '0': 'low', '1': { what: 'mid' }, '2': 'high' },
      probabilities: { '0': 0.1, '1': 0.11000000000000001, '2': 0.79 },
    });
    expect(a.probabilities[1]).toBe(0.11000000000000001);
    expect(a.legend[1]).toEqual({ what: 'mid' });
  });

  it('returns an unknown type as a generic answer with its raw fields', () => {
    const d = new Decision(
      {
        model: 'm',
        answers: { t: { type: 'truth', truth: 0.5 }, f: { type: 'ranking', order: ['b', 'a'] } },
        usage: { input_tokens: 1, output_tokens: 0 },
      },
      {},
    );
    expect(d.answers.t).toBeInstanceOf(TruthAnswer);
    const f = d.answers.f!;
    expect(f.constructor).toBe(UnknownAnswer);
    expect(f.type).toBe('ranking');
    expect(f.raw).toEqual({ type: 'ranking', order: ['b', 'a'] });
  });

  it('returns a known type with missing or wrongly typed fields as UnknownAnswer', () => {
    const bad = {
      t1: { type: 'truth' },
      t2: { type: 'truth', truth: '0.5' },
      c1: { type: 'choice', choice: 'a', confidence: 0.5 },
      c2: { type: 'choice', choice: 1, confidence: 0.5, probabilities: { a: 1 } },
      c3: { type: 'choice', choice: 'a', confidence: 0.5, probabilities: { a: 'high' } },
      s1: { type: 'score', score: 1, confidence: 0.5, probabilities: { '0': 1 } },
      s2: { type: 'score', score: 1, confidence: 0.5, probabilities: { x: 1 }, legend: { '0': 'a' } },
      s3: { type: 'score', score: null, confidence: 0.5, probabilities: { '0': 1 }, legend: { '0': 'a' } },
    };
    const d = new Decision({ model: 'm', answers: bad, usage: {} }, {});
    for (const [id, raw] of Object.entries(bad)) {
      const a = d.answers[id]!;
      expect(a.constructor, id).toBe(UnknownAnswer);
      expect(a.raw).toEqual(raw);
      expect(a.type).toBe(raw.type);
    }
  });

  it('reads headers into the decision', () => {
    const d = new Decision(
      { model: 'decisionnode-1.0', answers: {}, usage: { input_tokens: 3, output_tokens: 0 } },
      { 'x-request-id': 'req_9', 'x-decisionnode-latency-ms': '12.5', 'x-decisionnode-safety': 'harm=0.2, self_harm=0.1' },
    );
    expect(d.requestId).toBe('req_9');
    expect(d.latencyMs).toBe(12.5);
    expect(d.usage).toEqual({ inputTokens: 3, outputTokens: 0 });
    expect(d.safety).toEqual({ checked: true, harm: 0.2, selfHarm: 0.1, flagged: [] });
  });

  it('gives null, never 0, for a missing token count', () => {
    expect(new Decision({ model: 'm', answers: {} }, {}).usage).toEqual({ inputTokens: null, outputTokens: null });
    expect(new Decision({ model: 'm', answers: {}, usage: { input_tokens: 9 } }, {}).usage).toEqual({
      inputTokens: 9,
      outputTokens: null,
    });
    expect(new Decision({ model: 'm', answers: {} }, {}).latencyMs).toBeNull();
  });

  it('get() reads an answer by id and refuses an unknown id', () => {
    const d = new Decision({ model: 'm', answers: { q: { type: 'truth', truth: 1.0 } }, usage: {} }, {});
    expect((d.get('q') as TruthAnswer).truth).toBe(1);
    expect(() => d.get('nope')).toThrow(RangeError);
  });

  it('puts every extra model field in limits', () => {
    const m = new ModelInfo({ name: 'decisionnode-1.0', description: 'd', release_date: '2026-10-01', max_images: 4 });
    expect(m.releaseDate).toBe('2026-10-01');
    expect(m.limits).toEqual({ max_images: 4 });
  });
});

describe('errorFromResponse', () => {
  const err = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    errorFromResponse(status, headers, typeof body === 'string' ? body : JSON.stringify(body));

  it.each([
    [400, BadRequestError],
    [401, AuthenticationError],
    [402, InsufficientCreditError],
    [403, PermissionDeniedError],
    [404, NotFoundError],
    [302, DecisionNodeError],
    [307, DecisionNodeError],
    [405, DecisionNodeError],
    [408, DecisionNodeError],
    [409, DecisionNodeError],
    [418, DecisionNodeError],
    [422, ValidationError],
    [429, RateLimitError],
    [500, ServerError],
    [503, ServerError],
    [529, OverloadedError],
    [599, ServerError],
  ])('maps %i to its class', (status, cls) => {
    const e = err(status, { detail: { error_type: 'x', message: 'm' } });
    expect(e.constructor).toBe(cls);
    expect(e).toBeInstanceOf(DecisionNodeError);
    expect(e.name).toBe(cls.name);
    expect(e.status).toBe(status);
  });

  it('gives ContextLimitError for max_tokens_exceeded, with no server message', () => {
    const e = err(400, { detail: { error_type: 'max_tokens_exceeded' } }, { 'x-decisionnode-error': 'the request is 9000 tokens' });
    expect(e).toBeInstanceOf(ContextLimitError);
    expect(e).toBeInstanceOf(BadRequestError);
    expect(e.message).toBe('');
    expect(e.reason).toBe('the request is 9000 tokens');
  });

  it('reads a string detail as the message', () => {
    const e = err(400, { detail: 'Too many score levels. Must have at most 10 levels.' });
    expect(e.message).toBe('Too many score levels. Must have at most 10 levels.');
    expect(e.errorType).toBeNull();
  });

  it('uses the server message as the error message, and the header as the reason', () => {
    const e = err(400, { detail: { error_type: 'invalid_request_error', message: 'A score question takes 1 to 10 levels.' } }, {
      'x-decisionnode-error': "question 'q': a score takes up to 10 levels, got 11",
    });
    expect(e.message).toBe('A score question takes 1 to 10 levels.');
    expect(e.reason).toBe("question 'q': a score takes up to 10 levels, got 11");
    expect(Object.keys(e)).not.toContain('apiMessage');
  });

  it('reads a refusal with its category and safety', () => {
    const e = err(
      403,
      { detail: { error_type: 'refusal_error', message: 'refused', category: 'self_harm' } },
      { 'x-decisionnode-safety': 'harm=0.01, self_harm=0.97;blocked', 'x-request-id': 'req_r' },
    ) as RefusalError;
    expect(e).toBeInstanceOf(RefusalError);
    expect(e.category).toBe('self_harm');
    expect(e.safety).toEqual({ checked: true, harm: 0.01, selfHarm: 0.97, flagged: ['self_harm'] });
    expect(e.requestId).toBe('req_r');
  });

  it('keeps the 422 entries', () => {
    const entries = [{ type: 'missing', loc: ['body', 'state'], msg: 'Field required' }];
    const e = err(422, { detail: entries }) as ValidationError;
    expect(e.entries).toEqual(entries);
  });

  it('handles a body that is not JSON', () => {
    const e = err(502, '<html>Bad gateway</html>');
    expect(e).toBeInstanceOf(ServerError);
    expect(e.errorType).toBeNull();
    expect(e.body).toBe('<html>Bad gateway</html>');
  });

  it('prefers retry-after-ms over Retry-After', () => {
    expect(retryAfterSeconds({ 'retry-after-ms': '200', 'retry-after': '1' })).toBe(0.2);
    expect(retryAfterSeconds({ 'retry-after': '3' })).toBe(3);
    expect(retryAfterSeconds({})).toBeNull();
    const date = new Date(Date.now() + 5000).toUTCString();
    const s = retryAfterSeconds({ 'retry-after': date })!;
    expect(s).toBeGreaterThan(3);
    expect(s).toBeLessThanOrEqual(5);
    const e = err(429, { detail: { error_type: 'rate_limit_error' } }, { 'retry-after-ms': '1500' }) as RateLimitError;
    expect(e.retryAfter).toBe(1.5);
  });

  it('caps every wait the server asks for at 60 seconds', () => {
    expect(retryAfterSeconds({ 'retry-after-ms': '600000' })).toBe(60);
    expect(retryAfterSeconds({ 'retry-after': '3600' })).toBe(60);
    expect(retryAfterSeconds({ 'retry-after': new Date(Date.now() + 3_600_000).toUTCString() })).toBe(60);
    expect(retryAfterSeconds({ 'retry-after': new Date(Date.now() - 10_000).toUTCString() })).toBe(0);
  });
});
