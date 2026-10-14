import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BadRequestError, DecisionNode, DecisionNodeError, NotFoundError, PermissionDeniedError, RateLimitError, truth } from '../../src/index.js';
import { OK_TRUTH, fakeFetch, type Recorded, type Reply } from './helpers.js';

const ENV = ['DECISIONNODE_API_KEY', 'DECISIONNODE_BASE_URL', 'DECISIONNODE_MODEL'];

beforeEach(() => ENV.forEach((v) => delete process.env[v]));
afterEach(() => ENV.forEach((v) => delete process.env[v]));

const BASE = 'https://api.example.test';
const KEY_ID = 'key_7c2e9a41b0d34f6e8a5c1d2b3e4f5a60';
const KEY = {
  id: KEY_ID,
  name: 'Kiosk 0412',
  prefix: 'dn_live_',
  scope: 'decide',
  last4: '9f3a',
  device_id: 'kiosk-0412',
  labels: { store: '118', fw: '2.4' },
  limits: { requests_per_second: 5, tokens_per_second: 20000 },
  daily_spend_cap: { usd: 2.0 },
  spent_today: { usd: 0.0 },
  expires_at: '2027-10-13T00:00:00Z',
  may_search_collections: false,
  status: 'active',
  created_by_key: { id: 'key_1f0e2d3c4b5a69788796a5b4c3d2e1f0' },
  created_at: '2026-10-20T09:12:04Z',
  last_used_at: null,
  revoked_at: null,
};
const CREATED = { key: KEY, secret: `dn_live_${'0'.repeat(64)}` };
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BROKEN = { status: 500, body: { detail: { error_type: 'api_error', message: 'boom' } } };

function client(replies: Reply[]) {
  const f = fakeFetch(replies);
  const sleeps: number[] = [];
  const dn = new DecisionNode({
    apiKey: 'dn_test',
    baseUrl: BASE,
    fetch: f.fetch,
    fetchHonoursManualRedirect: true,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });
  return { dn, calls: f.calls, sleeps };
}

function sent(call: Recorded): { method: string; path: string; body: unknown } {
  const url = new URL(call.url);
  return { method: call.method, path: url.pathname, body: call.body === undefined ? undefined : JSON.parse(call.body) };
}

function query(call: Recorded): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of new URL(call.url).searchParams) (out[k] ??= []).push(v);
  return out;
}

function idempotencyKeys(calls: Recorded[]): Array<string | undefined> {
  return calls.map((c) => c.headers['idempotency-key']);
}

function errorReply(status: number, errorType: string, message: string, headers: Record<string, string> = {}): Reply {
  return { status, headers, body: { detail: { error_type: errorType, message } } };
}

async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => {
      throw new Error('expected a refusal');
    },
    (err: unknown) => err,
  );
}

describe('keys.create', () => {
  it('sends only the fields given, under their wire names', async () => {
    const { dn, calls } = client([{ status: 201, body: CREATED }]);
    expect(await dn.keys.create({ name: 'Kiosk 0412', deviceId: 'kiosk-0412', labels: { store: '118' } })).toEqual(CREATED);
    expect(sent(calls[0]!)).toEqual({ method: 'POST', path: '/v1/keys', body: { name: 'Kiosk 0412', device_id: 'kiosk-0412', labels: { store: '118' } } });
  });

  it('sends every field', async () => {
    const { dn, calls } = client([{ status: 201, body: CREATED }]);
    await dn.keys.create({
      name: 'Kiosk 0412',
      deviceId: 'kiosk-0412',
      labels: { store: '118', fw: '2.4' },
      limits: { requests_per_second: 5, tokens_per_second: 20000 },
      dailySpendCap: { usd: 2.0 },
      expiresAt: '2027-10-13T00:00:00Z',
      maySearchCollections: false,
    });
    expect(sent(calls[0]!).body).toEqual({
      name: 'Kiosk 0412',
      device_id: 'kiosk-0412',
      labels: { store: '118', fw: '2.4' },
      limits: { requests_per_second: 5, tokens_per_second: 20000 },
      daily_spend_cap: { usd: 2.0 },
      expires_at: '2027-10-13T00:00:00Z',
      may_search_collections: false,
    });
  });

  it('carries a new Idempotency-Key, the same on every attempt', async () => {
    const { dn, calls } = client([BROKEN, { error: 'network' }, { status: 201, body: CREATED }]);
    await dn.keys.create({ name: 'Kiosk 0412' });
    const keys = idempotencyKeys(calls);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(UUID4);
  });

  it('gives each call a new key', async () => {
    const { dn, calls } = client([{ status: 201, body: CREATED }]);
    await dn.keys.create({ name: 'a' });
    await dn.keys.create({ name: 'b' });
    const [first, second] = idempotencyKeys(calls);
    expect(first).toBeTruthy();
    expect(first).not.toBe(second);
  });

  it("sends the caller's own key on every attempt", async () => {
    const { dn, calls } = client([errorReply(529, 'overloaded_error', 'busy', { 'retry-after': '1' }), { status: 201, body: CREATED }]);
    await dn.keys.create({ name: 'Kiosk 0412', idempotencyKey: 'enroll-kiosk-0412' });
    expect(idempotencyKeys(calls)).toEqual(['enroll-kiosk-0412', 'enroll-kiosk-0412']);
  });

  for (const bad of ['', 'x'.repeat(256), 'café', 'tab\there']) {
    it(`refuses the Idempotency-Key ${JSON.stringify(bad.slice(0, 12))} before sending`, async () => {
      const { dn, calls } = client([{ status: 201, body: CREATED }]);
      const err = (await refusal(() => dn.keys.create({ name: 'Kiosk 0412', idempotencyKey: bad }))) as BadRequestError;
      expect(err).toBeInstanceOf(BadRequestError);
      expect(err.errorType).toBe('api_usage_error');
      expect(err.message).toBe('Idempotency-Key must be sent once, as 1 to 255 printable ASCII characters.');
      expect(calls).toHaveLength(0);
    });
  }

  it('retries a 409 idempotency_in_progress after its Retry-After', async () => {
    const busy = errorReply(409, 'idempotency_in_progress', 'A request with this Idempotency-Key is still running. Try again shortly.', { 'retry-after': '1' });
    const { dn, calls, sleeps } = client([busy, { status: 201, body: CREATED }]);
    expect(await dn.keys.create({ name: 'Kiosk 0412' })).toEqual(CREATED);
    expect(calls).toHaveLength(2);
    expect(new Set(idempotencyKeys(calls)).size).toBe(1);
    expect(sleeps).toEqual([1000]);
  });

  for (const errorType of ['idempotency_key_reused', 'key_not_replayable']) {
    it(`throws a 409 ${errorType} and never retries it`, async () => {
      const { dn, calls, sleeps } = client([errorReply(409, errorType, 'no'), { status: 201, body: CREATED }]);
      const err = (await refusal(() => dn.keys.create({ name: 'Kiosk 0412' }))) as DecisionNodeError;
      expect(err.constructor).toBe(DecisionNodeError);
      expect([err.status, err.errorType]).toEqual([409, errorType]);
      expect(calls).toHaveLength(1);
      expect(sleeps).toEqual([]);
    });
  }
});

describe('keys: list, get, update, revoke', () => {
  it('lists with its filters, labels sorted by name', async () => {
    const { dn, calls } = client([{ status: 200, body: { items: [KEY], next_cursor: null } }]);
    const page = await dn.keys.list({ labels: { store: '118', fw: '2.4' }, deviceId: 'kiosk 0412', status: 'all', limit: 50, cursor: 'c1' });
    expect(page).toEqual({ items: [KEY], next_cursor: null });
    expect(sent(calls[0]!).path).toBe('/v1/keys');
    expect(query(calls[0]!)).toEqual({ label: ['fw:2.4', 'store:118'], device_id: ['kiosk 0412'], status: ['all'], limit: ['50'], cursor: ['c1'] });
  });

  it('lists without a query when no filter is given', async () => {
    const { dn, calls } = client([{ status: 200, body: { items: [], next_cursor: null } }]);
    await dn.keys.list();
    expect(new URL(calls[0]!.url).search).toBe('');
  });

  const checks: Array<[Record<string, unknown>, string]> = [
    [{ limit: 0 }, 'limit is a whole number from 1 to 200.'],
    [{ limit: 201 }, 'limit is a whole number from 1 to 200.'],
    [{ limit: 1.5 }, 'limit is a whole number from 1 to 200.'],
    [{ status: 'gone' }, 'status is active, expired, revoked or all.'],
    [{ labels: { Store: '118' } }, 'A label filter is name:value, as labels are written.'],
    [{ labels: { store: '' } }, 'A label filter is name:value, as labels are written.'],
    [{ labels: { store: 'a\nb' } }, 'A label filter is name:value, as labels are written.'],
    [{ deviceId: ' kiosk' }, 'device_id is 1 to 128 printable ASCII characters, not starting with a space.'],
    [{ deviceId: 'x'.repeat(129) }, 'device_id is 1 to 128 printable ASCII characters, not starting with a space.'],
  ];
  for (const [params, message] of checks) {
    it(`refuses ${JSON.stringify(params).slice(0, 40)} before sending`, async () => {
      const { dn, calls } = client([{ status: 200, body: { items: [], next_cursor: null } }]);
      const err = (await refusal(() => dn.keys.list(params as never))) as BadRequestError;
      expect(err).toBeInstanceOf(BadRequestError);
      expect(err.errorType).toBe('api_usage_error');
      expect(err.message).toBe(message);
      expect(calls).toHaveLength(0);
    });
  }

  it('all follows the cursor through short pages', async () => {
    const second = { ...KEY, id: `key_${'1'.repeat(32)}` };
    const { dn, calls } = client([
      { status: 200, body: { items: [KEY], next_cursor: 'c1' } },
      { status: 200, body: { items: [], next_cursor: 'c2' } },
      { status: 200, body: { items: [second], next_cursor: null } },
    ]);
    expect(await dn.keys.all({ labels: { store: '118' }, limit: 2 })).toEqual([KEY, second]);
    expect(calls.map((c) => query(c).cursor)).toEqual([undefined, ['c1'], ['c2']]);
    for (const c of calls) expect([query(c).limit, query(c).label]).toEqual([['2'], ['store:118']]);
  });

  it('updates and revokes by the id, escaped as a path segment', async () => {
    const { dn, calls } = client([{ status: 200, body: KEY }]);
    await dn.keys.update(KEY_ID, { name: 'x' });
    await dn.keys.revoke('key/../x');
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([`PATCH /v1/keys/${KEY_ID}`, 'DELETE /v1/keys/key%2F..%2Fx']);
  });

  it('refuses an empty id before sending', async () => {
    const { dn, calls } = client([{ status: 200, body: KEY }]);
    expect(await refusal(() => dn.keys.revoke(''))).toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });

  it('updates only the fields given, null clearing', async () => {
    const { dn, calls } = client([{ status: 200, body: KEY }]);
    expect(await dn.keys.update(KEY_ID, { name: 'Kiosk 12', labels: { store: '120' }, dailySpendCap: null })).toEqual(KEY);
    expect(sent(calls[0]!)).toEqual({ method: 'PATCH', path: `/v1/keys/${KEY_ID}`, body: { name: 'Kiosk 12', labels: { store: '120' }, daily_spend_cap: null } });
    expect(calls[0]!.headers['idempotency-key']).toBeUndefined();
  });

  it('refuses an update with nothing to change before sending', async () => {
    const { dn, calls } = client([{ status: 200, body: KEY }]);
    const err = (await refusal(() => dn.keys.update(KEY_ID, {}))) as BadRequestError;
    expect(err).toBeInstanceOf(BadRequestError);
    expect([err.errorType, err.message]).toEqual(['api_usage_error', 'Nothing to change.']);
    expect(calls).toHaveLength(0);
  });

  it('revokes by labels, with device ids and a dry run', async () => {
    const { dn, calls } = client([{ status: 200, body: { would_revoke: 37, more: false } }]);
    expect(await dn.keys.revokeByLabels({ store: '118' }, { deviceIds: ['a', 'b'], dryRun: true })).toEqual({ would_revoke: 37, more: false });
    expect(sent(calls[0]!)).toEqual({ method: 'POST', path: '/v1/keys/revoke', body: { labels: { store: '118' }, device_ids: ['a', 'b'], dry_run: true } });
  });

  it('revokes by labels alone', async () => {
    const { dn, calls } = client([{ status: 200, body: { revoked: 2, more: false } }]);
    await dn.keys.revokeByLabels({ store: '118' });
    expect(sent(calls[0]!).body).toEqual({ labels: { store: '118' } });
  });

  const others: Array<[string, (dn: DecisionNode) => Promise<unknown>]> = [
    ['list', (dn) => dn.keys.list()],
    ['update', (dn) => dn.keys.update(KEY_ID, { name: 'x' })],
    ['revoke', (dn) => dn.keys.revoke(KEY_ID)],
    ['revokeByLabels', (dn) => dn.keys.revokeByLabels({ store: '118' })],
  ];
  for (const [name, call] of others) {
    it(`${name} carries no Idempotency-Key and retries as usual`, async () => {
      const { dn, calls } = client([BROKEN, { status: 200, body: KEY }]);
      await call(dn);
      expect(calls).toHaveLength(2);
      expect(idempotencyKeys(calls)).toEqual([undefined, undefined]);
    });
  }

  const statuses: Array<[number, string, new (...args: never[]) => DecisionNodeError]> = [
    [403, 'key_scope_denied', PermissionDeniedError],
    [404, 'not_found_error', NotFoundError],
    [409, 'already_revoked', DecisionNodeError],
    [409, 'key_expired', DecisionNodeError],
  ];
  for (const [status, errorType, cls] of statuses) {
    it(`a ${status} ${errorType} is a ${cls.name}`, async () => {
      const { dn } = client([errorReply(status, errorType, 'no')]);
      const err = (await refusal(() => dn.keys.revoke(KEY_ID))) as DecisionNodeError;
      expect(err.constructor).toBe(cls);
      expect([err.status, err.errorType]).toEqual([status, errorType]);
    });
  }
});

describe('usage', () => {
  it('key escapes the id and sends what is given', async () => {
    const { dn, calls } = client([{ status: 200, body: { key: { id: KEY_ID } } }]);
    await dn.usage.key('key/x', { start: '2026-10-01T00:00:00Z', granularity: 'day' });
    expect(new URL(calls[0]!.url).pathname).toBe('/v1/keys/key%2Fx/usage');
    expect(query(calls[0]!)).toEqual({ start: ['2026-10-01T00:00:00Z'], granularity: ['day'] });
  });

  it('all follows the cursor', async () => {
    const { dn, calls } = client([
      { status: 200, body: { items: [{ key: { id: 'a' } }], next_cursor: 'c1' } },
      { status: 200, body: { items: [{ key: { id: 'b' } }], next_cursor: null } },
    ]);
    const items = await dn.usage.all({ start: '2026-10-01T00:00:00Z', end: '2026-10-14T00:00:00Z', includeEmpty: true });
    expect(items).toEqual([{ key: { id: 'a' } }, { key: { id: 'b' } }]);
    expect(calls.map((c) => query(c).cursor)).toEqual([undefined, ['c1']]);
    expect(query(calls[0]!).include_empty).toEqual(['true']);
  });
});

describe('the spend cap', () => {
  const capReached = {
    detail: {
      error_type: 'key_spend_cap_reached',
      message: "This key's daily spend cap of USD 2.00 is reached. It resets at 00:00 UTC.",
      details: { resets_at: '2026-10-21T00:00:00Z', cap: { usd: 2.0 }, spent: { usd: 2.01 } },
    },
  };

  it('throws the 429 key_spend_cap_reached at once, never retried', async () => {
    const { dn, calls, sleeps } = client([{ status: 429, headers: { 'retry-after': '3600' }, body: capReached }, OK_TRUTH]);
    const err = (await refusal(() => dn.decide({ state: 's', questions: { q: truth('q?') } }))) as RateLimitError;
    expect(err).toBeInstanceOf(RateLimitError);
    expect([err.status, err.errorType]).toEqual([429, 'key_spend_cap_reached']);
    expect(err.details).toEqual(capReached.detail.details);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('still retries a rate 429', async () => {
    const rate = errorReply(429, 'rate_limit_error', 'Rate limit reached. Retry after 1 s.', { 'retry-after': '1' });
    const { dn, calls, sleeps } = client([rate, OK_TRUTH]);
    await dn.decide({ state: 's', questions: { q: truth('q?') } });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
  });
});
