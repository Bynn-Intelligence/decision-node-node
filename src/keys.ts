/**
 * Device keys and per-key usage. `client.keys` makes, lists, changes and
 * revokes Decisions-only keys with a Manage device keys key (`/v1/keys`);
 * `client.usage` reads what each key used and cost over a period
 * (`GET /v1/keys/{key_id}/usage` and `GET /v1/usage`). Every call returns the
 * API's object as sent, wire names as they are.
 */

import { BadRequestError, localError } from './errors.js';
import type { Transport } from './transport.js';

export interface KeysContext {
  transport: Transport;
}

/** A key's own rate limits, a second, wire names as sent. */
export interface KeyLimits {
  requests_per_second?: number | null;
  tokens_per_second?: number | null;
}

/** A Decisions-only key, as the API sends it. */
export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scope: string;
  last4: string;
  device_id: string | null;
  labels: Record<string, string>;
  limits: KeyLimits | null;
  daily_spend_cap: { usd: number } | null;
  spent_today: { usd: number } | null;
  expires_at: string | null;
  may_search_collections: boolean;
  /** `active`, `expired` or `revoked`. */
  status: string;
  created_by_key: { id: string } | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  [field: string]: unknown;
}

/** A key just made: the key, and its secret, shown in this answer only. */
export interface CreatedKey {
  key: ApiKey;
  secret: string;
  [field: string]: unknown;
}

/** One page of keys, newest first. */
export interface KeyPage {
  items: ApiKey[];
  /** Pass it as `cursor` for the next page; `null` on the last. */
  next_cursor: string | null;
  [field: string]: unknown;
}

/** A revoked key. */
export interface RevokedKey {
  id: string;
  revoked: boolean;
  [field: string]: unknown;
}

/** What a revoke by labels did: `revoked`, or with `dryRun` `would_revoke`, and `more` while matching keys are left. */
export interface RevokedByLabels {
  revoked?: number;
  would_revoke?: number;
  more: boolean;
  [field: string]: unknown;
}

/** One key's usage over a period, as the API sends it. */
export interface KeyUsage {
  period: { start: string; end: string };
  as_of: string;
  key: Record<string, unknown>;
  totals: Record<string, unknown>;
  [field: string]: unknown;
}

/** One page of every key's usage over a period. */
export interface UsagePage {
  period: { start: string; end: string };
  as_of: string;
  items: Array<Record<string, unknown>>;
  /** Pass it as `cursor` for the next page; `null` on the last. */
  next_cursor: string | null;
  [field: string]: unknown;
}

export interface UsagePeriod {
  /** RFC 3339; rounded down to the hour by the API. */
  start?: string;
  /** RFC 3339; rounded up to the hour by the API. */
  end?: string;
  /** `none`, `hour`, `day` or `month`: adds `buckets`. */
  granularity?: 'none' | 'hour' | 'day' | 'month' | (string & {});
  /** `model` or `channel`: adds `by_model` or `by_channel`. */
  groupBy?: 'model' | 'channel' | (string & {});
}

export interface UsageListParams extends UsagePeriod {
  start: string;
  end: string;
  /** The keys that have all of these labels. */
  labels?: Record<string, string>;
  deviceId?: string;
  /** At most 100 key ids. */
  keyIds?: string[];
  /** `full`, `decide` or `keys`. */
  scope?: 'full' | 'decide' | 'keys' | (string & {});
  /** `active`, `expired`, `revoked` or `all`. */
  status?: 'active' | 'expired' | 'revoked' | 'all' | (string & {});
  /** Keys with no usage in the period too. */
  includeEmpty?: boolean;
  /** 1 to 1,000. */
  limit?: number;
  cursor?: string;
}

export interface KeyCreateParams {
  /** 1 to 48 letters, digits, spaces, dots, dashes and underscores, unique among the active keys. */
  name: string;
  deviceId?: string;
  labels?: Record<string, string>;
  limits?: KeyLimits;
  dailySpendCap?: { usd: number };
  /** RFC 3339. */
  expiresAt?: string;
  maySearchCollections?: boolean;
  /** One per enrollment, so a retried enrollment gets the same key and secret back; else a new one per call. */
  idempotencyKey?: string;
}

export interface KeyListParams {
  /** The keys that have all of these labels. */
  labels?: Record<string, string>;
  deviceId?: string;
  /** `active` (the API's default), `expired`, `revoked` or `all`. */
  status?: 'active' | 'expired' | 'revoked' | 'all' | (string & {});
  /** 1 to 200. */
  limit?: number;
  cursor?: string;
}

/** Only the fields given are sent; `null` clears `labels`, `limits`, `dailySpendCap` or `expiresAt`. */
export interface KeyUpdateParams {
  name?: string;
  labels?: Record<string, string> | null;
  limits?: KeyLimits | null;
  dailySpendCap?: { usd: number } | null;
  expiresAt?: string | null;
  maySearchCollections?: boolean;
}

const GRANULARITIES = ['none', 'hour', 'day', 'month'];
const GROUPS = ['model', 'channel'];
const SCOPES = ['full', 'decide', 'keys'];
const STATUSES = ['active', 'expired', 'revoked', 'all'];
const USAGE_LIMIT_MAX = 1000;
const KEYS_LIMIT_MAX = 200;
const MAX_KEY_ID_FILTERS = 100;
const KEY_ID = /^key_[0-9a-f]{32}$/;
const LABEL_NAME = /^[a-z0-9_.-]{1,32}$/;
const LABEL_VALUE_CHARS = 64;
const DEVICE_ID_CHARS = 128;
const IDEMPOTENCY_KEY_CHARS = 255;

type Query = Array<[string, string]>;

function given(v: unknown): boolean {
  return v !== undefined && v !== null;
}

function printableAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function usageError(message: string): BadRequestError {
  return localError(BadRequestError, message);
}

/** A usage read's period and breakdowns, each sent only when given. */
function periodQuery(p: UsagePeriod): Query {
  if (given(p.granularity) && !GRANULARITIES.includes(p.granularity as string)) {
    throw usageError('granularity is none, hour, day or month.');
  }
  if (given(p.groupBy) && !GROUPS.includes(p.groupBy as string)) throw usageError('group_by is model or channel.');
  const q: Query = [];
  for (const [name, value] of [
    ['start', p.start],
    ['end', p.end],
    ['granularity', p.granularity],
    ['group_by', p.groupBy],
  ] as const) {
    if (given(value)) q.push([name, String(value)]);
  }
  return q;
}

/** Each label as `label=name:value`, sorted by name, so an object sends the same query every time. */
function labelQuery(labels: Record<string, string> | undefined): Query {
  if (!given(labels)) return [];
  if (typeof labels !== 'object' || Array.isArray(labels)) throw new TypeError('labels must be an object of label names to values');
  const q: Query = [];
  for (const name of Object.keys(labels!).sort()) {
    const value: unknown = labels![name];
    if (
      !LABEL_NAME.test(name) ||
      typeof value !== 'string' ||
      [...value].length < 1 ||
      [...value].length > LABEL_VALUE_CHARS ||
      /\p{Cc}/u.test(value)
    ) {
      throw usageError('A label filter is name:value, as labels are written.');
    }
    q.push(['label', `${name}:${value}`]);
  }
  return q;
}

function deviceQuery(deviceId: unknown): Query {
  if (!given(deviceId)) return [];
  if (typeof deviceId !== 'string' || deviceId.length < 1 || deviceId.length > DEVICE_ID_CHARS || !printableAscii(deviceId) || deviceId.startsWith(' ')) {
    throw usageError('device_id is 1 to 128 printable ASCII characters, not starting with a space.');
  }
  return [['device_id', deviceId]];
}

function statusQuery(status: unknown): Query {
  if (!given(status)) return [];
  if (!STATUSES.includes(status as string)) throw usageError('status is active, expired, revoked or all.');
  return [['status', status as string]];
}

function pageQuery(limit: unknown, most: number, cursor: unknown): Query {
  const q: Query = [];
  if (given(limit)) {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > most) {
      throw usageError(`limit is a whole number from 1 to ${most}.`);
    }
    q.push(['limit', String(limit)]);
  }
  if (given(cursor)) q.push(['cursor', String(cursor)]);
  return q;
}

/** `GET /v1/usage`'s query, checked in the API's order; the period's own rules and the cursor are the server's. */
function usageListQuery(p: UsageListParams): Query {
  const q = periodQuery(p);
  q.push(...labelQuery(p.labels));
  q.push(...deviceQuery(p.deviceId));
  (p.keyIds ?? []).forEach((id, i) => {
    if (typeof id !== 'string' || !KEY_ID.test(id)) throw usageError("key_id is a key's id, key_ and 32 hex digits.");
    if (i === MAX_KEY_ID_FILTERS) throw usageError('At most 100 key_id filters.');
    q.push(['key_id', id]);
  });
  if (given(p.scope)) {
    if (!SCOPES.includes(p.scope as string)) throw usageError('scope is full, decide or keys.');
    q.push(['scope', p.scope as string]);
  }
  q.push(...statusQuery(p.status));
  if (given(p.includeEmpty)) {
    if (typeof p.includeEmpty !== 'boolean') throw usageError('include_empty is true or false.');
    q.push(['include_empty', p.includeEmpty ? 'true' : 'false']);
  }
  q.push(...pageQuery(p.limit, USAGE_LIMIT_MAX, p.cursor));
  return q;
}

function withQuery(path: string, q: Query): string {
  if (q.length === 0) return path;
  return `${path}?${q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`;
}

function keyPath(keyId: string, suffix = ''): string {
  if (typeof keyId !== 'string' || keyId === '') throw new TypeError(`keyId must be a key id such as key_7c2e..., got ${String(keyId)}`);
  return `/v1/keys/${encodeURIComponent(keyId)}${suffix}`;
}

function nextCursor(page: Record<string, unknown>): string | null {
  return typeof page.next_cursor === 'string' && page.next_cursor !== '' ? page.next_cursor : null;
}

function itemsOf<T>(page: Record<string, unknown>): T[] {
  return (Array.isArray(page.items) ? page.items : []) as T[];
}

/**
 * `client.usage`: what each key used and cost over a period. A Full access key
 * reads every key of its workspace, a Manage device keys key its Decisions-only
 * keys. Every call returns the API's object as sent and retries as any read.
 */
export class PerKeyUsage {
  readonly #ctx: KeysContext;

  constructor(ctx: KeysContext) {
    this.#ctx = ctx;
  }

  /** One key's usage (`GET /v1/keys/{key_id}/usage`); without `start` and `end`, the UTC month so far. */
  async key(keyId: string, params: UsagePeriod = {}, options: { signal?: AbortSignal } = {}): Promise<KeyUsage> {
    const q = periodQuery(params);
    const { body } = await this.#ctx.transport.json({ method: 'GET', path: withQuery(keyPath(keyId, '/usage'), q), signal: options.signal });
    return body as KeyUsage;
  }

  /** One page of every key's usage over a period (`GET /v1/usage`); pass `next_cursor` as `cursor` until it is `null`. */
  async list(params: UsageListParams, options: { signal?: AbortSignal } = {}): Promise<UsagePage> {
    const q = usageListQuery(params);
    const { body } = await this.#ctx.transport.json({ method: 'GET', path: withQuery('/v1/usage', q), signal: options.signal });
    return body as UsagePage;
  }

  /**
   * Every key's usage over the period: `list`'s pages, `next_cursor` followed
   * until it is `null`, their `items` in order. A page can hold fewer keys
   * than `limit`, so only the cursor says when the list is done.
   */
  async all(params: Omit<UsageListParams, 'cursor'>, options: { signal?: AbortSignal } = {}): Promise<Array<Record<string, unknown>>> {
    const items: Array<Record<string, unknown>> = [];
    let cursor: string | null = null;
    for (;;) {
      const page: UsagePage = await this.list(cursor === null ? { ...params } : { ...params, cursor }, options);
      items.push(...itemsOf<Record<string, unknown>>(page));
      cursor = nextCursor(page);
      if (cursor === null) return items;
    }
  }
}

/**
 * `client.keys`: Decisions-only keys for devices, made, listed, changed and
 * revoked with a Manage device keys key. `create` sends an Idempotency-Key:
 * the `idempotencyKey` given (one per enrollment, so a retried enrollment gets
 * the same key and secret back), else a new UUID per call, the same on every
 * attempt; it retries like any call, and also on a 409
 * `idempotency_in_progress` after its Retry-After. The other calls retry as
 * any call.
 */
export class Keys {
  readonly #ctx: KeysContext;

  constructor(ctx: KeysContext) {
    this.#ctx = ctx;
  }

  /**
   * Makes a Decisions-only key (`POST /v1/keys`): `{ key, secret }`. The secret
   * is shown in this answer only (and again to a retry with the same
   * `idempotencyKey` within 24 hours); hand it to the device and never log it.
   * Each field is sent only when given.
   */
  async create(params: KeyCreateParams, options: { signal?: AbortSignal } = {}): Promise<CreatedKey> {
    const key = params.idempotencyKey;
    if (given(key) && (typeof key !== 'string' || key.length < 1 || key.length > IDEMPOTENCY_KEY_CHARS || !printableAscii(key))) {
      throw usageError('Idempotency-Key must be sent once, as 1 to 255 printable ASCII characters.');
    }
    const body: Record<string, unknown> = { name: params.name };
    for (const [wire, value] of [
      ['device_id', params.deviceId],
      ['labels', params.labels],
      ['limits', params.limits],
      ['daily_spend_cap', params.dailySpendCap],
      ['expires_at', params.expiresAt],
      ['may_search_collections', params.maySearchCollections],
    ] as const) {
      if (given(value)) body[wire] = value;
    }
    const res = await this.#ctx.transport.json({
      method: 'POST',
      path: '/v1/keys',
      body: JSON.stringify(body),
      policy: 'idempotent',
      headers: { 'idempotency-key': given(key) ? (key as string) : globalThis.crypto.randomUUID() },
      signal: options.signal,
    });
    return res.body as CreatedKey;
  }

  /** One page of the workspace's Decisions-only keys, newest first (`GET /v1/keys`); pass `next_cursor` as `cursor` until it is `null`. */
  async list(params: KeyListParams = {}, options: { signal?: AbortSignal } = {}): Promise<KeyPage> {
    const q = [...labelQuery(params.labels), ...deviceQuery(params.deviceId), ...statusQuery(params.status), ...pageQuery(params.limit, KEYS_LIMIT_MAX, params.cursor)];
    const { body } = await this.#ctx.transport.json({ method: 'GET', path: withQuery('/v1/keys', q), signal: options.signal });
    return body as KeyPage;
  }

  /** Every key `list` finds: its pages, `next_cursor` followed until it is `null`, their `items` in order. */
  async all(params: Omit<KeyListParams, 'cursor'> = {}, options: { signal?: AbortSignal } = {}): Promise<ApiKey[]> {
    const items: ApiKey[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: KeyPage = await this.list(cursor === null ? { ...params } : { ...params, cursor }, options);
      items.push(...itemsOf<ApiKey>(page));
      cursor = nextCursor(page);
      if (cursor === null) return items;
    }
  }

  /**
   * Changes a key (`PATCH /v1/keys/{id}`), sending only the fields given:
   * `labels` replaces the key's whole set, and `null` clears `labels`,
   * `limits`, `dailySpendCap` or `expiresAt`. A key's device id never changes.
   * Returns the key.
   */
  async update(keyId: string, params: KeyUpdateParams, options: { signal?: AbortSignal } = {}): Promise<ApiKey> {
    const body: Record<string, unknown> = {};
    for (const [wire, value] of [
      ['name', params.name],
      ['labels', params.labels],
      ['limits', params.limits],
      ['daily_spend_cap', params.dailySpendCap],
      ['expires_at', params.expiresAt],
      ['may_search_collections', params.maySearchCollections],
    ] as const) {
      if (value !== undefined) body[wire] = value;
    }
    if (Object.keys(body).length === 0) throw usageError('Nothing to change.');
    const path = keyPath(keyId);
    const { body: key } = await this.#ctx.transport.json({ method: 'PATCH', path, body: JSON.stringify(body), signal: options.signal });
    return key as ApiKey;
  }

  /** Revokes a key at once (`DELETE /v1/keys/{id}`): the next call with it gets a 401, and it cannot be undone. */
  async revoke(keyId: string, options: { signal?: AbortSignal } = {}): Promise<RevokedKey> {
    const { body } = await this.#ctx.transport.json({ method: 'DELETE', path: keyPath(keyId), signal: options.signal });
    return body as RevokedKey;
  }

  /**
   * Revokes every active key that has all of `labels` (and, with `deviceIds`,
   * is one of those devices), at most 10,000 a call (`POST /v1/keys/revoke`):
   * `{ revoked, more }`. Call it again while `more` is true. With
   * `dryRun: true` it revokes nothing and answers `{ would_revoke, more }`.
   */
  async revokeByLabels(
    labels: Record<string, string>,
    params: { deviceIds?: string[]; dryRun?: boolean } = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<RevokedByLabels> {
    const body: Record<string, unknown> = { labels };
    if (given(params.deviceIds)) body.device_ids = [...params.deviceIds!];
    if (given(params.dryRun)) body.dry_run = params.dryRun;
    const { body: out } = await this.#ctx.transport.json({ method: 'POST', path: '/v1/keys/revoke', body: JSON.stringify(body), signal: options.signal });
    return out as RevokedByLabels;
  }
}
