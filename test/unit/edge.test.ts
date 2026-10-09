import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BadRequestError,
  ContextLimitError,
  DecisionNode,
  DecisionNodeError,
  Image,
  OverloadedError,
  PermissionDeniedError,
  RateLimitError,
  RefusalError,
  RequestTooLargeError,
  ServerError,
  ValidationError,
  truth,
} from '../../src/index.js';
import { OK_TRUTH, fakeFetch, type Reply } from './helpers.js';

const ENV = ['DECISIONNODE_API_KEY', 'DECISIONNODE_BASE_URL', 'DECISIONNODE_MODEL'];
const Q = { q: truth('?') };
const HTML = { 'content-type': 'text/html' };
const PAGE_413 = '<html><body><h1>413 Request Entity Too Large</h1></body></html>';
const PAGE_408 = '<html><body><h1>408 Request Time-out</h1></body></html>';

beforeEach(() => ENV.forEach((v) => delete process.env[v]));
afterEach(() => ENV.forEach((v) => delete process.env[v]));

function client(replies: Reply[], maxRetries?: number) {
  const f = fakeFetch(replies);
  const dn = new DecisionNode({
    apiKey: 'dn_test',
    baseUrl: 'https://api.example.test',
    fetch: f.fetch,
    fetchHonoursManualRedirect: true,
    sleep: async () => {},
    ...(maxRetries === undefined ? {} : { maxRetries }),
  });
  return { dn, calls: f.calls };
}

async function failure(replies: Reply[], maxRetries?: number): Promise<{ err: DecisionNodeError; attempts: number }> {
  const { dn, calls } = client(replies, maxRetries);
  const err = await dn.decide({ questions: Q }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(DecisionNodeError);
  return { err: err as DecisionNodeError, attempts: calls.length };
}

describe('an error body that is not JSON', () => {
  it("classes the edge's 413 page by its status and never reads the page", async () => {
    const { err, attempts } = await failure([{ status: 413, text: PAGE_413, headers: HTML }], 0);
    expect(err).toBeInstanceOf(RequestTooLargeError);
    expect([err.status, err.errorType, err.message, err.requestId, err.reason]).toEqual([
      413,
      null,
      'HTTP 413 Content Too Large',
      null,
      null,
    ]);
    expect(err.body).toBeUndefined();
    expect(attempts).toBe(1);
  });

  it('never retries the 413 page', async () => {
    const { err, attempts } = await failure([{ status: 413, text: PAGE_413, headers: HTML }, OK_TRUTH]);
    expect(err).toBeInstanceOf(RequestTooLargeError);
    expect(attempts).toBe(1);
  });

  it('retries the 408 page, then raises the base class with the request id in the message', async () => {
    const { err, attempts } = await failure([
      { status: 408, text: PAGE_408, headers: { ...HTML, 'x-request-id': 'req_edge_0408' } },
    ]);
    expect(err.constructor).toBe(DecisionNodeError);
    expect([err.status, err.errorType, err.message, err.requestId, err.reason]).toEqual([
      408,
      null,
      'HTTP 408 Request Timeout (request id req_edge_0408)',
      'req_edge_0408',
      null,
    ]);
    expect(attempts).toBe(3);
  });

  it('answers after a 408 page and one retry', async () => {
    const { dn, calls } = client([{ status: 408, text: PAGE_408, headers: HTML }, OK_TRUTH]);
    const d = await dn.decide({ questions: Q });
    expect(d.answers.q!.type).toBe('truth');
    expect(calls).toHaveLength(2);
  });

  it.each([
    [400, BadRequestError, 'HTTP 400 Bad Request'],
    [403, PermissionDeniedError, 'HTTP 403 Forbidden'],
    [422, ValidationError, 'HTTP 422 Unprocessable Content'],
    [429, RateLimitError, 'HTTP 429 Too Many Requests'],
    [529, OverloadedError, 'HTTP 529 Overloaded'],
    [503, ServerError, 'HTTP 503 Service Unavailable'],
  ] as const)('classes a %i page by its status alone', async (status, cls, message) => {
    const { err } = await failure(
      [{ status, text: '<html>busy</html>', headers: { ...HTML, 'x-decisionnode-error': 'why', 'retry-after-ms': '2000' } }],
      0,
    );
    expect(err).toBeInstanceOf(cls);
    expect([err.errorType, err.message, err.reason]).toEqual([null, message, 'why']);
    expect(err).not.toBeInstanceOf(ContextLimitError);
    expect(err).not.toBeInstanceOf(RefusalError);
    if (err instanceof ValidationError) expect(err.entries).toBeNull();
    if (err instanceof RateLimitError || err instanceof OverloadedError) expect(err.retryAfter).toBe(2);
  });

  it('reads an empty body as not JSON', async () => {
    const { err } = await failure([{ status: 500, text: '' }], 0);
    expect(err).toBeInstanceOf(ServerError);
    expect(err.message).toBe('HTTP 500 Internal Server Error');
  });

  it('writes a status outside the table as HTTP <status>, with the request id when sent', async () => {
    const { err } = await failure([{ status: 418, text: "I'm a teapot", headers: { 'x-request-id': 'req_1' } }], 0);
    expect(err.constructor).toBe(DecisionNodeError);
    expect(err.message).toBe('HTTP 418 (request id req_1)');
    const plain = await failure([{ status: 418, text: 'teapot' }], 0);
    expect(plain.err.message).toBe('HTTP 418');
  });

  it('keeps the empty message of a JSON envelope without one', async () => {
    const { err } = await failure([{ status: 502, body: {} }], 0);
    expect(err).toBeInstanceOf(ServerError);
    expect(err.message).toBe('');
    expect(err.body).toEqual({});
  });
});

describe('image ids of at most 64 characters', () => {
  const url = (id: string) => Image.fromUrl(id, 'https://files.example.com/p.jpg');

  it('sends an id of exactly 64 characters, also outside the Basic Multilingual Plane', async () => {
    const wide = '\u{20000}'.repeat(64);
    expect(wide.length).toBe(128);
    const { dn, calls } = client([OK_TRUTH]);
    await dn.decide({ questions: Q, images: [url('a'.repeat(64)), url(wide)] });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.body!).images.map((i: { id: string }) => i.id)).toEqual(['a'.repeat(64), wide]);
  });

  it('refuses 65 characters with the API message, counting from 0, and sends nothing', async () => {
    const { dn, calls } = client([OK_TRUTH]);
    const err = await dn
      .decide({ questions: Q, images: [url('a'), { id: 'b'.repeat(65), url: 'https://files.example.com/p.jpg' }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestError);
    const e = err as BadRequestError;
    expect([e.status, e.requestId, e.errorType, e.message]).toEqual([
      null,
      null,
      'api_usage_error',
      'Image 1: its id is longer than 64 characters.',
    ]);
    expect(calls).toHaveLength(0);
  });

  it('reports a long id that is also a duplicate as too long', async () => {
    const long = 'x'.repeat(65);
    const { dn, calls } = client([OK_TRUTH]);
    const err = await dn.checkRequest('decide', { questions: Q, images: [url('a'), url(long), url(long)] }).catch((e: unknown) => e);
    expect((err as Error).message).toBe('Image 1: its id is longer than 64 characters.');
    expect(calls).toHaveLength(0);
  });
});
