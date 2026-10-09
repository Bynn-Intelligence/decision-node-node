import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DecisionNode, Image, RequestTooLargeError, truth } from '../../src/index.js';
import { OK_TRUTH, fakeFetch } from './helpers.js';

const ENV = ['DECISIONNODE_API_KEY', 'DECISIONNODE_BASE_URL', 'DECISIONNODE_MODEL'];
const LIMIT = 26_214_400;
const MESSAGE =
  'The request body is over 26,214,400 bytes (25 MiB). Send large images as uploads (POST /v1/uploads) and name them by upload_id.';
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGM8ISfHwMDAxMDAwMDAAAANBAEIfXHKZgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);
const BATCH = { status: 201, body: { id: 'batch_1', state: 'draft', counters: {}, created_at: 'x', ended_at: null } };
const Q = { q: truth('?') };

beforeEach(() => ENV.forEach((v) => delete process.env[v]));
afterEach(() => ENV.forEach((v) => delete process.env[v]));

function client(replies: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(replies);
  return {
    dn: new DecisionNode({ apiKey: 'dn_test', baseUrl: 'https://api.example.test', fetch: f.fetch, fetchHonoursManualRedirect: true }),
    calls: f.calls,
  };
}

/** The bytes a decide body takes besides its state, from the body this client sends. */
async function overhead(): Promise<number> {
  const { dn, calls } = client([OK_TRUTH]);
  await dn.decide({ state: 'x', questions: Q });
  return new TextEncoder().encode(calls[0]!.body!).length - 1;
}

function expectTooLarge(err: unknown, size: number): void {
  expect(err).toBeInstanceOf(RequestTooLargeError);
  const e = err as RequestTooLargeError;
  expect([e.status, e.requestId, e.errorType, e.message]).toEqual([null, null, 'request_too_large_error', MESSAGE]);
  expect(e.reason).toBe(`the body is ${size} bytes; the limit is ${LIMIT}`);
}

describe('the 25 MiB body limit', () => {
  it('sends a body of exactly 26,214,400 bytes and refuses one byte more, with nothing sent', async () => {
    const room = LIMIT - (await overhead());
    const ok = client([OK_TRUTH]);
    await ok.dn.decide({ state: 'a'.repeat(room), questions: Q });
    expect(ok.calls).toHaveLength(1);
    expect(new TextEncoder().encode(ok.calls[0]!.body!).length).toBe(LIMIT);

    const over = client([OK_TRUTH]);
    const err = await over.dn.decide({ state: 'a'.repeat(room + 1), questions: Q }).catch((e: unknown) => e);
    expectTooLarge(err, LIMIT + 1);
    expect(over.calls).toHaveLength(0);
  });

  it('counts bytes in UTF-8, not characters', async () => {
    const room = LIMIT - (await overhead());
    // Two bytes each: half as many characters fill the body.
    const { dn, calls } = client([OK_TRUTH]);
    const err = await dn.decide({ state: 'é'.repeat(Math.floor(room / 2) + 1), questions: Q }).catch((e: unknown) => e);
    expectTooLarge(err, LIMIT - room + 2 * (Math.floor(room / 2) + 1));
    expect(calls).toHaveLength(0);
  });

  it('goes on every helper', async () => {
    const { dn, calls } = client([OK_TRUTH]);
    const state = 'a'.repeat(LIMIT);
    for (const call of [
      () => dn.check({ state, instructions: '?' }),
      () => dn.classify({ state, instructions: '?', options: ['a'] }),
      () => dn.score({ state, instructions: '?', levels: ['x'] }),
      () => dn.number({ state, instructions: '?' }),
      () => dn.gate({ action: state }),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(RequestTooLargeError);
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses the whole of decideMany when one request is over, sending none', async () => {
    const { dn, calls } = client([OK_TRUTH]);
    const err = await dn
      .decideMany([
        { state: 'small', questions: Q },
        { state: 'a'.repeat(LIMIT), questions: Q },
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestTooLargeError);
    expect(calls).toHaveLength(0);
  });

  it('measures each batch line as sent, its custom_id included', async () => {
    const probe = client([BATCH]);
    await probe.dn.batches.create([{ customId: 'a', state: 'x', questions: Q }]);
    const line = probe.calls[0]!.body!.replace(/\n$/, '');
    const room = LIMIT - (new TextEncoder().encode(line).length - 1);

    const ok = client([BATCH]);
    await ok.dn.batches.create([{ customId: 'a', state: 'a'.repeat(room), questions: Q }]);
    expect(ok.calls).toHaveLength(1);

    // One more character of custom_id puts the same line over.
    const over = client([BATCH]);
    for (const call of [
      () => over.dn.batches.create([{ customId: 'ab', state: 'a'.repeat(room), questions: Q }]),
      () => over.dn.batches.add('batch_1', [{ customId: 'ab', state: 'a'.repeat(room), questions: Q }]),
      () => over.dn.checkRequest('batches.create', [{ customId: 'ab', state: 'a'.repeat(room), questions: Q }]),
    ]) {
      expectTooLarge(await call().catch((e: unknown) => e), LIMIT + 1);
    }
    expect(over.calls).toHaveLength(0);
  });

  it('is checked by checkRequest, with nothing sent', async () => {
    const room = LIMIT - (await overhead());
    const { dn, calls } = client([OK_TRUTH]);
    await expect(dn.checkRequest('decide', { state: 'a'.repeat(room), questions: Q })).resolves.toBeUndefined();
    expectTooLarge(await dn.checkRequest('decide', { state: 'a'.repeat(room + 1), questions: Q }).catch((e: unknown) => e), LIMIT + 1);
    expect(calls).toHaveLength(0);
  });

  it('counts an image it would upload by its upload id, uploading nothing to measure', async () => {
    const big = new Uint8Array(600_000);
    big.set(PNG);
    const image = Image.fromBytes('big', big);
    // The image goes as {"id","upload_id"}, with an upload id of 36 characters.
    const part = `,"images":${JSON.stringify([{ id: 'big', upload_id: `upl_${'0'.repeat(32)}` }])}`.length;
    const room = LIMIT - (await overhead()) - part;
    const { dn, calls } = client([OK_TRUTH]);
    await expect(dn.checkRequest('decide', { state: 'a'.repeat(room), questions: Q, images: [image] })).resolves.toBeUndefined();
    const err = await dn.decide({ state: 'a'.repeat(room + 1), questions: Q, images: [image] }).catch((e: unknown) => e);
    expectTooLarge(err, LIMIT + 1);
    expect(calls).toHaveLength(0);
  });

  it('counts an inline image with its base64 data', async () => {
    const image = Image.fromBytes('small', PNG);
    const part = `,"images":${JSON.stringify([{ id: 'small', media_type: 'image/png', data: btoa(String.fromCharCode(...PNG)) }])}`.length;
    const room = LIMIT - (await overhead()) - part;
    const ok = client([OK_TRUTH]);
    await ok.dn.decide({ state: 'a'.repeat(room), questions: Q, images: [image] });
    expect(new TextEncoder().encode(ok.calls[0]!.body!).length).toBe(LIMIT);
    const over = client([OK_TRUTH]);
    expectTooLarge(await over.dn.decide({ state: 'a'.repeat(room + 1), questions: Q, images: [image] }).catch((e: unknown) => e), LIMIT + 1);
    expect(over.calls).toHaveLength(0);
  });

  it('leaves decideRaw to send its body as given', async () => {
    const { dn, calls } = client([OK_TRUTH]);
    await dn.decideRaw({ state: 'a'.repeat(LIMIT), questions: { q: { type: 'truth', instructions: '?' } } });
    expect(calls).toHaveLength(1);
  });
});

describe('the API answering 413', () => {
  const tooLarge = {
    status: 413,
    body: { detail: { error_type: 'request_too_large_error', message: MESSAGE } },
    headers: { 'x-request-id': 'req_413', 'retry-after-ms': '1', 'x-decisionnode-error': 'the body is 26214500 bytes; the limit is 26214400' },
  };

  it('raises RequestTooLargeError on decide, never retried', async () => {
    const { dn, calls } = client([tooLarge]);
    const err = await dn.decide({ state: 's', questions: Q }).catch((e: unknown) => e);
    expect(calls).toHaveLength(1);
    expect(err).toBeInstanceOf(RequestTooLargeError);
    const e = err as RequestTooLargeError;
    expect([e.status, e.requestId, e.errorType, e.message, e.name]).toEqual([413, 'req_413', 'request_too_large_error', MESSAGE, 'RequestTooLargeError']);
  });

  it('raises RequestTooLargeError on the presign and on a batch add, never retried', async () => {
    const presign = client([tooLarge]);
    await expect(presign.dn.upload([Image.fromBytes('a', PNG)])).rejects.toBeInstanceOf(RequestTooLargeError);
    expect(presign.calls).toHaveLength(1);

    const add = client([tooLarge]);
    await expect(add.dn.batches.add('batch_1', [{ customId: 'a', questions: Q }])).rejects.toBeInstanceOf(RequestTooLargeError);
    expect(add.calls).toHaveLength(1);
  });
});
