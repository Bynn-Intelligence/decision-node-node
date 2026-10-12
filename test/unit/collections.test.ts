import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BadRequestError,
  DecisionNode,
  DecisionNodeError,
  Image,
  NotFoundError,
  PermissionDeniedError,
  ServerError,
  ValidationError,
} from '../../src/index.js';
import { fakeFetch, type Recorded, type Reply } from './helpers.js';

const ENV = ['DECISIONNODE_API_KEY', 'DECISIONNODE_BASE_URL', 'DECISIONNODE_MODEL'];

beforeEach(() => ENV.forEach((v) => delete process.env[v]));
afterEach(() => ENV.forEach((v) => delete process.env[v]));

const BASE = 'https://api.example.test';
const COL = 'col_3f6c1a9e0b2d4c7f8a1e5d9b2c4f6a80';
const ITEM = 'itm_9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d';
const BADGE = Image.fromUrl('badge', 'https://files.example.com/badges/emp-1042.jpg');
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGM8ISfHwMDAxMDAwMDAAAANBAEIfXHKZgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);
const COLLECTION = { id: COL, type: 'face', name: 'Staff', public: false, items: 0, created_at: '2026-10-12T09:00:00Z', deletion: null };
const ENROLLED = { id: ITEM, collection: COL, reference: 'emp-1042', label: 'Reception', faces_found: 1, usage: { enrollments: 1 } };
const BUSY = { status: 529, headers: { 'retry-after-ms': '10' }, body: { detail: { error_type: 'overloaded_error', message: 'busy' } } };
const BROKEN = { status: 500, body: { detail: { error_type: 'api_error', message: 'broken' } } };

function client(replies: Reply[]) {
  const f = fakeFetch(replies);
  const dn = new DecisionNode({ apiKey: 'dn_test', baseUrl: BASE, fetch: f.fetch, fetchHonoursManualRedirect: true, sleep: async () => {} });
  return { dn, calls: f.calls };
}

function sent(call: Recorded): { method: string; path: string; body: unknown } {
  const url = new URL(call.url);
  return { method: call.method, path: url.pathname + url.search, body: call.body === undefined ? undefined : JSON.parse(call.body) };
}

async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => {
      throw new Error('expected a refusal');
    },
    (err: unknown) => err,
  );
}

describe('collections: the calls', () => {
  it('creates a face collection, the type sent by default', async () => {
    const { dn, calls } = client([{ status: 201, body: COLLECTION }]);
    expect(await dn.collections.create({ name: 'Staff' })).toEqual(COLLECTION);
    expect(sent(calls[0]!)).toEqual({ method: 'POST', path: '/v1/collections', body: { type: 'face', name: 'Staff' } });
  });

  it('lists the collections in the order sent', async () => {
    const list = [COLLECTION, { id: 'celebrities', type: 'face', name: 'celebrities', public: true, items: 1200 }];
    const { dn, calls } = client([{ status: 200, body: { collections: list } }]);
    expect(await dn.collections.list()).toEqual(list);
    expect(sent(calls[0]!)).toEqual({ method: 'GET', path: '/v1/collections', body: undefined });
  });

  it('gets and deletes by the id in the path, a public name included', async () => {
    const { dn, calls } = client([
      { status: 200, body: COLLECTION },
      { status: 200, body: { id: 'celebrities', public: true } },
      { status: 200, body: { id: COL, deleted: true } },
    ]);
    await dn.collections.get(COL);
    await dn.collections.get('celebrities');
    expect(await dn.collections.delete(COL)).toEqual({ id: COL, deleted: true });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      `GET /v1/collections/${COL}`,
      'GET /v1/collections/celebrities',
      `DELETE /v1/collections/${COL}`,
    ]);
  });

  it('enrolls an image as a decision sends it, the label only when given', async () => {
    const { dn, calls } = client([
      { status: 201, body: ENROLLED },
      { status: 201, body: ENROLLED },
      { status: 201, body: ENROLLED },
    ]);
    expect(await dn.collections.enroll(COL, { image: BADGE, reference: 'emp-1042', label: 'Reception' })).toEqual(ENROLLED);
    await dn.collections.enroll(COL, { image: BADGE, reference: 'emp-1042' });
    await dn.collections.enroll(COL, { image: Image.fromBytes('local', PNG), reference: 'emp-1043' });
    const image = { id: 'badge', url: 'https://files.example.com/badges/emp-1042.jpg' };
    expect(sent(calls[0]!)).toEqual({ method: 'POST', path: `/v1/collections/${COL}/items`, body: { image, reference: 'emp-1042', label: 'Reception' } });
    expect(sent(calls[1]!).body).toEqual({ image, reference: 'emp-1042' });
    const local = sent(calls[2]!).body as { image: Record<string, unknown> };
    expect(local.image).toMatchObject({ id: 'local', media_type: 'image/png' });
    expect(typeof local.image.data).toBe('string');
  });

  it('lists items with offset and limit only when given, and deletes an item', async () => {
    const page = { items: [], offset: 20, limit: 50, total: 0, next_offset: null };
    const { dn, calls } = client([
      { status: 200, body: page },
      { status: 200, body: page },
      { status: 200, body: { id: ITEM, deleted: true } },
    ]);
    expect(await dn.collections.listItems(COL, { offset: 20, limit: 50 })).toEqual(page);
    await dn.collections.listItems(COL);
    await dn.collections.deleteItem(COL, ITEM);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`)).toEqual([
      `GET /v1/collections/${COL}/items?offset=20&limit=50`,
      `GET /v1/collections/${COL}/items`,
      `DELETE /v1/collections/${COL}/items/${ITEM}`,
    ]);
  });
});

describe('collections: retries', () => {
  it('retries create and enroll only on 429 and 529, never on another 5xx', async () => {
    const busy = client([BUSY, { status: 201, body: COLLECTION }]);
    await busy.dn.collections.create({ name: 'Staff' });
    expect(busy.calls).toHaveLength(2);
    const broken = client([BROKEN, { status: 201, body: COLLECTION }]);
    expect(await refusal(() => broken.dn.collections.create({ name: 'Staff' }))).toBeInstanceOf(ServerError);
    expect(broken.calls).toHaveLength(1);
    const enroll = client([BROKEN, { status: 201, body: ENROLLED }]);
    expect(await refusal(() => enroll.dn.collections.enroll(COL, { image: BADGE, reference: 'emp-1042' }))).toBeInstanceOf(ServerError);
    expect(enroll.calls).toHaveLength(1);
  });

  it('retries the reads and deletes as every call', async () => {
    const { dn, calls } = client([BROKEN, { status: 200, body: COLLECTION }]);
    await dn.collections.get(COL);
    expect(calls).toHaveLength(2);
  });
});

describe('collections: local checks', () => {
  async function entries(run: () => Promise<unknown>): Promise<unknown> {
    const err = await refusal(run);
    expect(err).toBeInstanceOf(ValidationError);
    const e = err as ValidationError;
    expect([e.status, e.requestId, e.errorType]).toEqual([null, null, null]);
    return e.entries;
  }

  it('refuses a type other than face and a name not 1 to 80 characters, sending nothing', async () => {
    const { dn, calls } = client([{ status: 201, body: COLLECTION }]);
    expect(await entries(() => dn.collections.create({ name: 'Plates', type: 'plate' }))).toEqual([
      { type: 'literal_error', loc: ['body', 'type'], msg: "Input should be 'face'", input: 'plate', ctx: { expected: "'face'" } },
    ]);
    expect(await entries(() => dn.collections.create({ name: '' }))).toEqual([
      { type: 'string_too_short', loc: ['body', 'name'], msg: 'String should have at least 1 character', input: '', ctx: { min_length: 1 } },
    ]);
    const long = 'x'.repeat(81);
    expect(await entries(() => dn.collections.create({ name: long }))).toEqual([
      { type: 'string_too_long', loc: ['body', 'name'], msg: 'String should have at most 80 characters', input: long, ctx: { max_length: 80 } },
    ]);
    await dn.collections.create({ name: 'x'.repeat(80) });
    expect(calls).toHaveLength(1);
  });

  it('refuses a reference not 1 to 64 of the allowed characters and a label over 128', async () => {
    const { dn, calls } = client([{ status: 201, body: ENROLLED }]);
    const enroll = (reference: string, label?: string) => () => dn.collections.enroll(COL, { image: BADGE, reference, label });
    expect(await entries(enroll(''))).toEqual([
      { type: 'string_too_short', loc: ['body', 'reference'], msg: 'String should have at least 1 character', input: '', ctx: { min_length: 1 } },
    ]);
    const long = 'r'.repeat(65);
    expect(await entries(enroll(long))).toEqual([
      { type: 'string_too_long', loc: ['body', 'reference'], msg: 'String should have at most 64 characters', input: long, ctx: { max_length: 64 } },
    ]);
    expect(await entries(enroll('emp 1042'))).toEqual([
      {
        type: 'string_pattern_mismatch',
        loc: ['body', 'reference'],
        msg: "String should match pattern '^[A-Za-z0-9_.:-]+$'",
        input: 'emp 1042',
        ctx: { pattern: '^[A-Za-z0-9_.:-]+$' },
      },
    ]);
    const label = 'l'.repeat(129);
    expect(await entries(enroll('emp-1042', label))).toEqual([
      { type: 'string_too_long', loc: ['body', 'label'], msg: 'String should have at most 128 characters', input: label, ctx: { max_length: 128 } },
    ]);
    expect(calls).toHaveLength(0);
    await enroll('emp_1.a:b-c', 'l'.repeat(128))();
    expect(calls).toHaveLength(1);
  });

  it('checks the enrolled image as a decision image', async () => {
    const { dn, calls } = client([{ status: 201, body: ENROLLED }]);
    const err = await refusal(() => dn.collections.enroll(COL, { image: Image.fromUrl('plain', 'http://files.example.com/a.jpg'), reference: 'emp-1' }));
    expect(err).toBeInstanceOf(BadRequestError);
    expect(calls).toHaveLength(0);
  });

  it('refuses offset and limit outside their ranges with the batch list messages', async () => {
    const { dn, calls } = client([]);
    const offset = (await refusal(() => dn.collections.listItems(COL, { offset: -1 }))) as BadRequestError;
    expect([offset.status, offset.errorType, offset.message]).toEqual([null, 'api_usage_error', 'Query parameter offset must be an integer of 0 or more, got -1.']);
    for (const limit of [0, 101]) {
      const err = (await refusal(() => dn.collections.listItems(COL, { limit }))) as BadRequestError;
      expect(err.message).toBe(`Query parameter limit must be an integer from 1 to 100, got ${limit}.`);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('collections: errors as sent', () => {
  const answer = (status: number, errorType: string) => ({ status, body: { detail: { error_type: errorType, message: errorType } } });

  it('maps each status to its class with the error type kept', async () => {
    const cases: Array<[number, string, new (...args: never[]) => DecisionNodeError]> = [
      [404, 'collection_not_found', NotFoundError],
      [404, 'item_not_found', NotFoundError],
      [403, 'collection_read_only', PermissionDeniedError],
      [403, 'collection_not_enabled', PermissionDeniedError],
      [403, 'collections_region_unavailable', PermissionDeniedError],
      [400, 'collection_type_mismatch', BadRequestError],
    ];
    for (const [status, errorType, cls] of cases) {
      const { dn } = client([answer(status, errorType)]);
      const err = (await refusal(() => dn.collections.get(COL))) as DecisionNodeError;
      expect(err).toBeInstanceOf(cls);
      expect([err.status, err.errorType]).toEqual([status, errorType]);
    }
  });

  it('raises a 409 as the base error and a 422 no_face as a ValidationError', async () => {
    const limit = client([answer(409, 'items_limit_reached')]);
    const err = (await refusal(() => limit.dn.collections.enroll(COL, { image: BADGE, reference: 'emp-1' }))) as DecisionNodeError;
    expect(err.constructor).toBe(DecisionNodeError);
    expect([err.status, err.errorType]).toEqual([409, 'items_limit_reached']);
    const entry = { type: 'no_face', loc: ['body', 'image'], msg: 'No face was found in the image.', input: 'badge' };
    const noFace = client([{ status: 422, body: { detail: [entry] } }]);
    const v = (await refusal(() => noFace.dn.collections.enroll(COL, { image: BADGE, reference: 'emp-1' }))) as ValidationError;
    expect(v).toBeInstanceOf(ValidationError);
    expect([v.status, v.entries]).toEqual([422, [entry]]);
  });
});
