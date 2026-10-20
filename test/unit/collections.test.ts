import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BadRequestError,
  DecisionNode,
  DecisionNodeError,
  Image,
  NotFoundError,
  PermissionDeniedError,
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

describe('collections: retries and the Idempotency-Key', () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const IN_PROGRESS = {
    status: 409,
    headers: { 'retry-after': '1' },
    body: { detail: { error_type: 'idempotency_in_progress', message: 'A request with this Idempotency-Key is still running. Try again shortly.' } },
  };
  const REUSED = {
    status: 409,
    body: { detail: { error_type: 'idempotency_key_reused', message: 'This Idempotency-Key was already used with a different request.' } },
  };
  const key = (call: Recorded) => call.headers['idempotency-key'];

  it('sends a UUID v4 key on create and enroll, the same on every attempt, retried like any call', async () => {
    const created = client([BROKEN, BUSY, { status: 201, body: COLLECTION }]);
    await created.dn.collections.create({ name: 'Staff' });
    expect(created.calls).toHaveLength(3);
    expect(key(created.calls[0]!)).toMatch(UUID_V4);
    expect(new Set(created.calls.map(key)).size).toBe(1);
    const enrolled = client([BROKEN, { status: 201, body: ENROLLED }]);
    await enrolled.dn.collections.enroll(COL, { image: BADGE, reference: 'emp-1042' });
    expect(enrolled.calls).toHaveLength(2);
    expect(key(enrolled.calls[0]!)).toMatch(UUID_V4);
    expect(key(enrolled.calls[1]!)).toBe(key(enrolled.calls[0]!));
  });

  it('uses a new key for each call', async () => {
    const { dn, calls } = client([{ status: 201, body: COLLECTION }]);
    await dn.collections.create({ name: 'Staff' });
    await dn.collections.create({ name: 'Staff' });
    expect(key(calls[0]!)).not.toBe(key(calls[1]!));
  });

  it('retries a 409 idempotency_in_progress after its Retry-After, with the same key', async () => {
    const f = fakeFetch([IN_PROGRESS, { status: 201, body: ENROLLED }]);
    const waits: number[] = [];
    const dn = new DecisionNode({
      apiKey: 'dn_test',
      baseUrl: BASE,
      fetch: f.fetch,
      fetchHonoursManualRedirect: true,
      sleep: async (ms: number) => void waits.push(ms),
    });
    expect(await dn.collections.enroll(COL, { image: BADGE, reference: 'emp-1042' })).toEqual(ENROLLED);
    expect(f.calls).toHaveLength(2);
    expect(waits).toEqual([1000]);
    expect(key(f.calls[1]!)).toBe(key(f.calls[0]!));
  });

  it('throws a 409 idempotency_key_reused as the base error, never retried', async () => {
    const { dn, calls } = client([REUSED, { status: 201, body: ENROLLED }]);
    const err = (await refusal(() => dn.collections.enroll(COL, { image: BADGE, reference: 'emp-1042' }))) as DecisionNodeError;
    expect(err.constructor).toBe(DecisionNodeError);
    expect([err.status, err.errorType]).toEqual([409, 'idempotency_key_reused']);
    expect(calls).toHaveLength(1);
  });

  it('returns a replayed answer as sent', async () => {
    const { dn } = client([{ status: 201, headers: { 'x-decisionnode-idempotent-replay': 'true' }, body: ENROLLED }]);
    expect(await dn.collections.enroll(COL, { image: BADGE, reference: 'emp-1042' })).toEqual(ENROLLED);
  });

  it('sends no key on the reads and deletes, which retry as every call', async () => {
    const { dn, calls } = client([BROKEN, { status: 200, body: COLLECTION }, { status: 200, body: { collections: [] } }, { status: 200, body: { deleted: true } }]);
    await dn.collections.get(COL);
    expect(calls).toHaveLength(2);
    await dn.collections.list();
    await dn.collections.delete(COL);
    expect(calls.every((c) => key(c) === undefined)).toBe(true);
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

  it('refuses a type other than face or text and a name not 1 to 80 characters, sending nothing', async () => {
    const { dn, calls } = client([{ status: 201, body: COLLECTION }]);
    expect(await entries(() => dn.collections.create({ name: 'Plates', type: 'plate' }))).toEqual([
      { type: 'literal_error', loc: ['body', 'type'], msg: "Input should be 'face' or 'text'", input: 'plate', ctx: { expected: "'face' or 'text'" } },
    ]);
    expect(await entries(() => dn.collections.create({ name: '' }))).toEqual([
      { type: 'string_too_short', loc: ['body', 'name'], msg: 'String should have at least 1 character', input: '', ctx: { min_length: 1 } },
    ]);
    // A long input is echoed cut to 64 characters, then "...", as the API echoes it.
    const long = 'x'.repeat(81);
    expect(await entries(() => dn.collections.create({ name: long }))).toEqual([
      {
        type: 'string_too_long',
        loc: ['body', 'name'],
        msg: 'String should have at most 80 characters',
        input: `${'x'.repeat(64)}...`,
        ctx: { max_length: 80 },
      },
    ]);
    // An object is never echoed; a number is, as it is.
    expect(await entries(() => dn.collections.create({ name: 'Plates', type: { kind: 'face' } as never }))).toEqual([
      { type: 'literal_error', loc: ['body', 'type'], msg: "Input should be 'face' or 'text'", input: null, ctx: { expected: "'face' or 'text'" } },
    ]);
    expect(await entries(() => dn.collections.create({ name: 7 as never }))).toEqual([
      { type: 'string_type', loc: ['body', 'name'], msg: 'Input should be a valid string', input: 7 },
    ]);
    // Counted in code points: 81 characters outside the BMP are cut to 64 of them.
    const wide = '\u{20000}'.repeat(81);
    const cut = (await entries(() => dn.collections.create({ name: wide }))) as Array<{ input: string }>;
    expect(cut[0]!.input).toBe(`${'\u{20000}'.repeat(64)}...`);
    await dn.collections.create({ name: 'x'.repeat(80) });
    expect(calls).toHaveLength(1);
  });

  it('refuses a reference not 1 to 64 of the allowed characters and a label empty or over 128', async () => {
    const { dn, calls } = client([{ status: 201, body: ENROLLED }]);
    const enroll = (reference: string, label?: string) => () => dn.collections.enroll(COL, { image: BADGE, reference, label });
    // The length is checked before the pattern: an empty reference is too short.
    const pattern = '^[A-Za-z0-9_.:-]{1,64}$';
    expect(await entries(enroll(''))).toEqual([
      { type: 'string_too_short', loc: ['body', 'reference'], msg: 'String should have at least 1 character', input: '', ctx: { min_length: 1 } },
    ]);
    expect(await entries(enroll('emp-1042', ''))).toEqual([
      { type: 'string_too_short', loc: ['body', 'label'], msg: 'String should have at least 1 character', input: '', ctx: { min_length: 1 } },
    ]);
    expect(await entries(() => dn.collections.enroll(COL, { reference: 'emp-1042' } as never))).toEqual([
      { type: 'missing', loc: ['body', 'image'], msg: 'Field required', input: null },
    ]);
    expect(await entries(() => dn.collections.enroll(COL, { image: BADGE } as never))).toEqual([
      { type: 'missing', loc: ['body', 'reference'], msg: 'Field required', input: null },
    ]);
    const long = 'r'.repeat(65);
    expect(await entries(enroll(long))).toEqual([
      {
        type: 'string_too_long',
        loc: ['body', 'reference'],
        msg: 'String should have at most 64 characters',
        input: `${'r'.repeat(64)}...`,
        ctx: { max_length: 64 },
      },
    ]);
    expect(await entries(enroll('emp 1042'))).toEqual([
      {
        type: 'string_pattern_mismatch',
        loc: ['body', 'reference'],
        msg: `String should match pattern '${pattern}'`,
        input: 'emp 1042',
        ctx: { pattern },
      },
    ]);
    const label = 'l'.repeat(129);
    expect(await entries(enroll('emp-1042', label))).toEqual([
      {
        type: 'string_too_long',
        loc: ['body', 'label'],
        msg: 'String should have at most 128 characters',
        input: `${'l'.repeat(64)}...`,
        ctx: { max_length: 128 },
      },
    ]);
    expect(calls).toHaveLength(0);
    await enroll('emp_1.a:b-c', 'l'.repeat(128))();
    expect(calls).toHaveLength(1);
  });

  it('checks only a URL by the decision rules, and leaves every other picture fault to the API', async () => {
    const { dn, calls } = client([{ status: 201, body: ENROLLED }]);
    const err = (await refusal(() =>
      dn.collections.enroll(COL, { image: Image.fromUrl('plain', 'https://files.example.com:8443/a.jpg'), reference: 'emp-1' }),
    )) as BadRequestError;
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.errorType).toBe('image_url_refused');
    expect(calls).toHaveLength(0);
    // Bytes that are no JPEG, PNG or WebP are sent as given; the API answers its 422.
    const gif = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0));
    await dn.collections.enroll(COL, { image: Image.fromBytes('badge', gif), reference: 'emp-1' });
    expect(calls).toHaveLength(1);
    expect((sent(calls[0]!).body as { image: unknown }).image).toEqual({ id: 'badge', media_type: null, data: btoa(String.fromCharCode(...gif)) });
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

describe('collections: items described, edited and found (suite 1.15)', () => {
  const ITEM_BODY = { id: ITEM, reference: 'emp-1042', label: null, metadata: { department: 'Reception' }, created_at: '2026-10-12T09:00:00Z' };
  const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  async function entries(run: () => Promise<unknown>): Promise<unknown> {
    const err = await refusal(run);
    expect(err).toBeInstanceOf(ValidationError);
    return (err as ValidationError).entries;
  }

  it('sends enroll metadata only when given', async () => {
    const { dn, calls } = client([{ status: 201, body: ENROLLED }, { status: 201, body: ENROLLED }]);
    await dn.collections.enroll(COL, { image: BADGE, reference: 'emp-1042', metadata: { department: 'Reception', badge_level: 2, visitor: false } });
    await dn.collections.enroll(COL, { image: BADGE, reference: 'emp-1042' });
    expect((sent(calls[0]!).body as Record<string, unknown>).metadata).toEqual({ department: 'Reception', badge_level: 2, visitor: false });
    expect(sent(calls[1]!).body).not.toHaveProperty('metadata');
  });

  it('updates only the fields given: a null label clears it, {} empties metadata', async () => {
    const { dn, calls } = client([{ status: 200, body: ITEM_BODY }, { status: 200, body: ITEM_BODY }, { status: 200, body: ITEM_BODY }]);
    expect(await dn.collections.updateItem(COL, ITEM, { label: null })).toEqual(ITEM_BODY);
    await dn.collections.updateItem(COL, ITEM, { metadata: {} });
    await dn.collections.updateItem(COL, ITEM, { reference: 'emp-2001', label: 'Desk' });
    expect(sent(calls[0]!)).toEqual({ method: 'PATCH', path: `/v1/collections/${COL}/items/${ITEM}`, body: { label: null } });
    expect(sent(calls[1]!).body).toEqual({ metadata: {} });
    expect(sent(calls[2]!).body).toEqual({ reference: 'emp-2001', label: 'Desk' });
    expect(calls[0]!.headers['idempotency-key']).toMatch(UUID4);
    expect(calls[0]!.headers['idempotency-key']).not.toBe(calls[1]!.headers['idempotency-key']);
  });

  it('retries an update with its key, on a 5xx and while in progress', async () => {
    const running = { status: 409, headers: { 'retry-after': '1' }, body: { detail: { error_type: 'idempotency_in_progress', message: 'running' } } };
    const { dn, calls } = client([BROKEN, running, { status: 200, body: ITEM_BODY }]);
    await dn.collections.updateItem(COL, ITEM, { label: 'Desk' });
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.headers['idempotency-key'])).size).toBe(1);
  });

  it('refuses an update with no field, and checks reference and label as enroll does', async () => {
    const { dn, calls } = client([]);
    expect(await entries(() => dn.collections.updateItem(COL, ITEM, {}))).toEqual([
      { type: 'missing', loc: ['body'], msg: 'Send reference, label, metadata or any of them', input: null },
    ]);
    expect(await entries(() => dn.collections.updateItem(COL, ITEM, { reference: 'emp 1' }))).toEqual([
      {
        type: 'string_pattern_mismatch',
        loc: ['body', 'reference'],
        msg: "String should match pattern '^[A-Za-z0-9_.:-]{1,64}$'",
        input: 'emp 1',
        ctx: { pattern: '^[A-Za-z0-9_.:-]{1,64}$' },
      },
    ]);
    expect(await entries(() => dn.collections.updateItem(COL, ITEM, { label: 'y'.repeat(129) }))).toEqual([
      {
        type: 'string_too_long',
        loc: ['body', 'label'],
        msg: 'String should have at most 128 characters',
        input: `${'y'.repeat(64)}...`,
        ctx: { max_length: 128 },
      },
    ]);
    expect(calls).toHaveLength(0);
  });

  it('checks metadata as the API does, in key order', async () => {
    const { dn, calls } = client([]);
    const enroll = (metadata: unknown) => dn.collections.enroll(COL, { image: BADGE, reference: 'emp-1042', metadata: metadata as never });
    expect(await entries(() => enroll(['a']))).toEqual([
      { type: 'value_error', loc: ['body', 'metadata'], msg: 'Metadata is an object of keys and values.', input: null },
    ]);
    expect(await entries(() => enroll('text'))).toEqual([
      { type: 'value_error', loc: ['body', 'metadata'], msg: 'Metadata is an object of keys and values.', input: 'text' },
    ]);
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, String(i)]));
    expect(await entries(() => enroll({ ...many, 'Bad Key': 1 }))).toEqual([
      { type: 'value_error', loc: ['body', 'metadata'], msg: 'Metadata holds at most 20 keys.', input: null },
    ]);
    const longKey = `${'a'.repeat(39)}\u0001${'b'.repeat(5)}`;
    expect(await entries(() => enroll({ Department: 'x', [longKey]: 1, note: 'n'.repeat(501), tags: ['a'], ok: 2.5, yes: true }))).toEqual([
      { type: 'value_error', loc: ['body', 'metadata'], msg: 'A metadata key is 1 to 40 characters of a-z, 0-9 and _: "Department".', input: null },
      { type: 'value_error', loc: ['body', 'metadata'], msg: `A metadata key is 1 to 40 characters of a-z, 0-9 and _: "${'a'.repeat(39)}?...".`, input: null },
      { type: 'value_error', loc: ['body', 'metadata', 'note'], msg: 'A metadata text is at most 500 characters.', input: `${'n'.repeat(64)}...` },
      { type: 'value_error', loc: ['body', 'metadata', 'tags'], msg: 'A metadata value is a text, a number or true or false.', input: null },
    ]);
    // 500 characters outside the Basic Multilingual Plane are 500, not 1,000.
    const { dn: ok, calls: sentCalls } = client([{ status: 201, body: ENROLLED }]);
    await ok.collections.enroll(COL, { image: BADGE, reference: 'emp-1042', metadata: { note: '\u{20000}'.repeat(500) } });
    expect(sentCalls).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it('filters items by reference or prefix, sent only when given, never both', async () => {
    const page = { items: [], offset: 0, limit: 50, total: 0, total_capped: false, next_offset: null, reference: null, reference_prefix: 'emp:' };
    const { dn, calls } = client([{ status: 200, body: page }, { status: 200, body: page }]);
    expect(await dn.collections.listItems(COL, { limit: 10, reference_prefix: 'emp:' })).toEqual(page);
    await dn.collections.listItems(COL, { reference: 'emp-1042' });
    expect(sent(calls[0]!).path).toBe(`/v1/collections/${COL}/items?limit=10&reference_prefix=emp%3A`);
    expect(sent(calls[1]!).path).toBe(`/v1/collections/${COL}/items?reference=emp-1042`);
    const both = await refusal(() => dn.collections.listItems(COL, { reference: 'a', reference_prefix: 'b' }));
    expect(both).toBeInstanceOf(BadRequestError);
    expect((both as Error).message).toBe('Send query parameter reference or reference_prefix, not both.');
    const bad = await refusal(() => dn.collections.listItems(COL, { reference_prefix: `emp é\n${'z'.repeat(70)}` }));
    expect((bad as BadRequestError).errorType).toBe('api_usage_error');
    expect((bad as Error).message).toBe(
      `Query parameter reference_prefix must be 1 to 64 characters of A-Z, a-z, 0-9, _, ., : and -, got emp \\u{e9}\\u{a}${'z'.repeat(58)}....`,
    );
    const empty = await refusal(() => dn.collections.listItems(COL, { reference: '' }));
    expect((empty as Error).message).toBe('Query parameter reference must be 1 to 64 characters of A-Z, a-z, 0-9, _, ., : and -, got .');
    expect(calls).toHaveLength(2);
  });

  it('carries details, and never retries an unpriced enrollment while other 529s retry', async () => {
    const unpriced = { status: 529, body: { detail: { error_type: 'overloaded_error', message: 'No price.', details: { reason: 'enrollment_unpriced' } } } };
    const { dn, calls } = client([unpriced]);
    const err = (await refusal(() => dn.collections.enroll(COL, { image: BADGE, reference: 'emp-1042' }))) as DecisionNodeError;
    expect(calls).toHaveLength(1);
    expect(err.details).toEqual({ reason: 'enrollment_unpriced' });
    const modelDown = { status: 529, headers: { 'retry-after-ms': '10' }, body: { detail: { error_type: 'overloaded_error', message: 'x', details: { reason: 'face_model_unavailable' } } } };
    const again = client([modelDown, { status: 201, body: ENROLLED }]);
    await again.dn.collections.enroll(COL, { image: BADGE, reference: 'emp-1042' });
    expect(again.calls).toHaveLength(2);
    const plain = client([{ status: 404, body: { detail: { error_type: 'item_not_found', message: 'gone', details: ['x'] } } }]);
    const nf = (await refusal(() => plain.dn.collections.deleteItem(COL, ITEM))) as DecisionNodeError;
    expect(nf.details).toBeNull();
  });

  it('raises a decide key\'s 403 key_scope_denied as PermissionDeniedError, not retried', async () => {
    const { dn, calls } = client([{ status: 403, body: { detail: { error_type: 'key_scope_denied', message: 'This key may only decide.' } } }]);
    const err = await refusal(() => dn.collections.list());
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect(calls).toHaveLength(1);
  });
});
