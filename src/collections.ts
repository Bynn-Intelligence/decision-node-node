/**
 * Collections: a workspace's collections of faces, which the
 * `face_recognition` booster searches, and the public collections it may use.
 * Every call returns the API's object as sent, wire names as they are.
 */

import { entry, localValidation, type Entry, type HeldLimits } from './checks.js';
import { BadRequestError, localError } from './errors.js';
import type { Transport } from './transport.js';
import type { ImageInput, ImagePlacer } from './uploads.js';

export interface CollectionsContext {
  transport: Transport;
  placer: ImagePlacer;
  /** The model's published limits, when the client holds them. */
  limits: () => HeldLimits;
}

/** A collection, as the API sends it. */
export interface Collection {
  id: string;
  type: string;
  name: string;
  /** `true` for a public collection, which no workspace can change. */
  public: boolean;
  /** How many items it holds. */
  items: number;
  created_at: string;
  [field: string]: unknown;
}

/** An item's metadata: up to 20 keys of `a-z`, `0-9` and `_`, each a text, a number or true or false. */
export type ItemMetadata = Record<string, string | number | boolean>;

/** One enrolled face, as the API sends it. */
export interface CollectionItem {
  id: string;
  reference: string;
  label?: string | null;
  metadata?: ItemMetadata;
  [field: string]: unknown;
}

/** One page of a collection's items. */
export interface CollectionItemPage {
  items: CollectionItem[];
  offset: number;
  limit: number;
  total: number;
  /** The offset of the next page, or `null` on the last. */
  next_offset: number | null;
  /** `true` when `total` stopped counting at its cap. */
  total_capped?: boolean;
  /** The `reference` the page was filtered by, or `null`. */
  reference?: string | null;
  /** The `reference_prefix` the page was filtered by, or `null`. */
  reference_prefix?: string | null;
  [field: string]: unknown;
}

/** The answer to a delete. */
export interface Deleted {
  deleted: boolean;
  [field: string]: unknown;
}

const MAX_NAME_CHARS = 80;
const MAX_REFERENCE_CHARS = 64;
const MAX_LABEL_CHARS = 128;
// Checked after the length, so an empty reference is too short, not off the pattern.
const REFERENCE_PATTERN = '^[A-Za-z0-9_.:-]{1,64}$';
// A collections 422 echoes a string cut to 64 characters, then "...".
const ECHO_CHARS = 64;
const MAX_LIST_LIMIT = 100;
const MAX_METADATA_KEYS = 20;
const MAX_METADATA_KEY_CHARS = 40;
const MAX_METADATA_TEXT_CHARS = 500;
const METADATA_KEY = /^[a-z0-9_]{1,40}$/;
const REFERENCE_QUERY = new RegExp(REFERENCE_PATTERN);

/**
 * An input as a collections 422 entry echoes it, as the API does: a string cut to 64
 * characters (code points) with "..." added when it was longer, an object or an array
 * never (null), anything else as it is.
 */
export function echoed(value: unknown): unknown {
  if (typeof value === 'string') {
    const chars = [...value];
    return chars.length > ECHO_CHARS ? `${chars.slice(0, ECHO_CHARS).join('')}...` : value;
  }
  if (value !== null && typeof value === 'object') return null;
  return value === undefined ? null : value;
}

/** A string field's 422 entries, as the API lists them: missing, not a string, empty, too long, or off its pattern. */
function stringEntries(loc: string[], value: unknown, most: number, pattern?: string): Entry[] {
  if (value === undefined || value === null) return [entry('missing', loc, 'Field required', null)];
  if (typeof value !== 'string') return [entry('string_type', loc, 'Input should be a valid string', echoed(value))];
  // Counted in code points, as the API counts them; the length before the pattern.
  const length = [...value].length;
  if (length === 0) {
    return [entry('string_too_short', loc, 'String should have at least 1 character', value, { min_length: 1 })];
  }
  if (length > most) {
    return [entry('string_too_long', loc, `String should have at most ${most} characters`, echoed(value), { max_length: most })];
  }
  if (pattern !== undefined && !new RegExp(pattern).test(value)) {
    return [entry('string_pattern_mismatch', loc, `String should match pattern '${pattern}'`, value, { pattern })];
  }
  return [];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * An item's metadata's 422 entries, the limits a client may hold, in key order:
 * an object of at most 20 keys (that alone, before any key is read), each key 1
 * to 40 of `a-z`, `0-9` and `_`, each value a text of at most 500 characters, a
 * number or true or false. A text's control characters, a number's range and the
 * 4 KB limit are the server's.
 */
function metadataEntries(metadata: unknown): Entry[] {
  const loc = ['body', 'metadata'];
  if (!isPlainObject(metadata)) return [entry('value_error', loc, 'Metadata is an object of keys and values.', echoed(metadata))];
  const keys = Object.keys(metadata);
  if (keys.length > MAX_METADATA_KEYS) return [entry('value_error', loc, `Metadata holds at most ${MAX_METADATA_KEYS} keys.`, null)];
  const out: Entry[] = [];
  for (const key of keys) {
    const value = metadata[key];
    if (!METADATA_KEY.test(key)) {
      const chars = [...key];
      const shown = chars.slice(0, MAX_METADATA_KEY_CHARS).map((c) => (/\p{Cc}/u.test(c) ? '?' : c)).join('');
      const more = chars.length > MAX_METADATA_KEY_CHARS ? '...' : '';
      out.push(entry('value_error', loc, `A metadata key is 1 to ${MAX_METADATA_KEY_CHARS} characters of a-z, 0-9 and _: "${shown}${more}".`, null));
    } else if (typeof value === 'string') {
      if ([...value].length > MAX_METADATA_TEXT_CHARS) {
        out.push(entry('value_error', [...loc, key], `A metadata text is at most ${MAX_METADATA_TEXT_CHARS} characters.`, echoed(value)));
      }
    } else if (typeof value !== 'number' && typeof value !== 'boolean') {
      out.push(entry('value_error', [...loc, key], 'A metadata value is a text, a number or true or false.', echoed(value)));
    }
  }
  return out;
}

/**
 * A caller's value as an API message echoes it: its first `most` characters,
 * any outside printable ASCII written as `\u{hex}`, then "..." when longer.
 */
function printable(value: string, most: number): string {
  const chars = [...value];
  const shown = chars
    .slice(0, most)
    .map((c) => {
      const code = c.codePointAt(0)!;
      return code >= 0x20 && code <= 0x7e ? c : `\\u{${code.toString(16)}}`;
    })
    .join('');
  return shown + (chars.length > most ? '...' : '');
}

/** A `reference` or `reference_prefix` of the items list, checked as the API checks it. */
function checkReferenceQuery(name: string, value: unknown): void {
  if (typeof value !== 'string' || !REFERENCE_QUERY.test(value)) {
    throw localError(
      BadRequestError,
      `Query parameter ${name} must be 1 to 64 characters of A-Z, a-z, 0-9, _, ., : and -, got ${printable(String(value), MAX_REFERENCE_CHARS)}.`,
    );
  }
}

/** A fresh Idempotency-Key for one call, kept on every attempt of it. */
function idempotencyKey(): Record<string, string> {
  return { 'idempotency-key': globalThis.crypto.randomUUID() };
}

function path(...ids: string[]): string {
  return ids.map((id) => encodeURIComponent(String(id))).join('/');
}

/**
 * `client.collections`: create, list, get and delete collections, and enroll,
 * list and delete their items. `create` and `enroll` send an Idempotency-Key,
 * a new UUID per call and the same on every attempt of it, so the server
 * creates, enrolls and bills once however often the call is tried; they then
 * retry like any call, and also on a 409 `idempotency_in_progress` after its
 * Retry-After. A 409 `idempotency_key_reused` is thrown and never retried.
 * The reads and deletes carry no key and are retried as every call.
 */
export class Collections {
  readonly #ctx: CollectionsContext;

  constructor(ctx: CollectionsContext) {
    this.#ctx = ctx;
  }

  /** Creates a collection (`POST /v1/collections`). `type` is `face`, the one type there is. */
  async create(params: { name: string; type?: string }, options: { signal?: AbortSignal } = {}): Promise<Collection> {
    const type = params.type ?? 'face';
    const entries: Entry[] = [];
    if (type !== 'face') {
      entries.push(entry('literal_error', ['body', 'type'], "Input should be 'face'", echoed(type), { expected: "'face'" }));
    }
    entries.push(...stringEntries(['body', 'name'], params.name, MAX_NAME_CHARS));
    if (entries.length > 0) throw localValidation(entries);
    const { body } = await this.#ctx.transport.json({
      method: 'POST',
      path: '/v1/collections',
      body: JSON.stringify({ type, name: params.name }),
      policy: 'idempotent',
      headers: idempotencyKey(),
      signal: options.signal,
    });
    return body as Collection;
  }

  /** The workspace's collections, then the public ones it may use, in the API's order (`GET /v1/collections`). */
  async list(options: { signal?: AbortSignal } = {}): Promise<Collection[]> {
    const { body } = await this.#ctx.transport.json({ method: 'GET', path: '/v1/collections', signal: options.signal });
    return (Array.isArray(body.collections) ? body.collections : []) as Collection[];
  }

  /** One collection (`GET /v1/collections/{id}`); a public collection's name is its id. */
  async get(collectionId: string, options: { signal?: AbortSignal } = {}): Promise<Collection> {
    const { body } = await this.#ctx.transport.json({ method: 'GET', path: `/v1/collections/${path(collectionId)}`, signal: options.signal });
    return body as Collection;
  }

  /** Deletes a collection and its items (`DELETE /v1/collections/{id}`). */
  async delete(collectionId: string, options: { signal?: AbortSignal } = {}): Promise<Deleted> {
    const { body } = await this.#ctx.transport.json({ method: 'DELETE', path: `/v1/collections/${path(collectionId)}`, signal: options.signal });
    return body as Deleted;
  }

  /**
   * Enrolls one face from one image (`POST /v1/collections/{id}/items`) under
   * `reference`, with an optional `label`. The image is sent as a decision's
   * image is: a URL as given, local bytes inline or uploaded. Only a URL's
   * rules are checked here; every other fault of the picture is the API's 422
   * `image_unreadable`.
   */
  async enroll(
    collectionId: string,
    params: { image: ImageInput; reference: string; label?: string | null; metadata?: ItemMetadata | null },
    options: { signal?: AbortSignal } = {},
  ): Promise<CollectionItem> {
    const { image, reference, label, metadata } = params;
    const entries: Entry[] = [];
    if (image === undefined || image === null) entries.push(entry('missing', ['body', 'image'], 'Field required', null));
    entries.push(...stringEntries(['body', 'reference'], reference, MAX_REFERENCE_CHARS, REFERENCE_PATTERN));
    // A label's own pattern (no control or invisible character) is the server's to judge.
    if (label !== undefined && label !== null) entries.push(...stringEntries(['body', 'label'], label, MAX_LABEL_CHARS));
    if (metadata !== undefined && metadata !== null) entries.push(...metadataEntries(metadata));
    if (entries.length > 0) throw localValidation(entries);
    const plan = await this.#ctx.placer.planUnchecked(image);
    const { wires } = await this.#ctx.placer.place(plan, options.signal);
    const body: Record<string, unknown> = { image: wires[0], reference };
    if (label !== undefined && label !== null) body.label = label;
    if (metadata !== undefined && metadata !== null) body.metadata = metadata;
    const res = await this.#ctx.transport.json({
      method: 'POST',
      path: `/v1/collections/${path(collectionId)}/items`,
      body: JSON.stringify(body),
      policy: 'idempotent',
      headers: idempotencyKey(),
      signal: options.signal,
    });
    return res.body as CollectionItem;
  }

  /**
   * Edits one item (`PATCH /v1/collections/{id}/items/{item_id}`), sending only
   * the fields given: `label: null` clears the label, and `metadata` replaces the
   * item's whole object (`{}` empties it). It carries an Idempotency-Key and
   * retries as `create` and `enroll` do. Returns the item as sent.
   */
  async updateItem(
    collectionId: string,
    itemId: string,
    params: { reference?: string; label?: string | null; metadata?: ItemMetadata },
    options: { signal?: AbortSignal } = {},
  ): Promise<CollectionItem> {
    const entries: Entry[] = [];
    const body: Record<string, unknown> = {};
    if (params.reference !== undefined) {
      entries.push(...stringEntries(['body', 'reference'], params.reference, MAX_REFERENCE_CHARS, REFERENCE_PATTERN));
      body.reference = params.reference;
    }
    if (params.label !== undefined) {
      if (params.label !== null) entries.push(...stringEntries(['body', 'label'], params.label, MAX_LABEL_CHARS));
      body.label = params.label;
    }
    if (params.metadata !== undefined) {
      entries.push(...metadataEntries(params.metadata));
      body.metadata = params.metadata;
    }
    if (Object.keys(body).length === 0) {
      entries.push(entry('missing', ['body'], 'Send reference, label, metadata or any of them', null));
    }
    if (entries.length > 0) throw localValidation(entries);
    const res = await this.#ctx.transport.json({
      method: 'PATCH',
      path: `/v1/collections/${path(collectionId)}/items/${path(itemId)}`,
      body: JSON.stringify(body),
      policy: 'idempotent',
      headers: idempotencyKey(),
      signal: options.signal,
    });
    return res.body as CollectionItem;
  }

  /**
   * One page of a collection's items (`GET /v1/collections/{id}/items`). `offset`,
   * `limit`, and the filters `reference` (exact) or `reference_prefix` (never both)
   * are sent only when given.
   */
  async listItems(
    collectionId: string,
    params: { offset?: number; limit?: number; reference?: string; reference_prefix?: string } = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<CollectionItemPage> {
    const { offset, limit, reference, reference_prefix: referencePrefix } = params;
    if (offset !== undefined && offset !== null && (!Number.isInteger(offset) || offset < 0)) {
      throw localError(BadRequestError, `Query parameter offset must be an integer of 0 or more, got ${String(offset)}.`);
    }
    if (limit !== undefined && limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT)) {
      throw localError(BadRequestError, `Query parameter limit must be an integer from 1 to ${MAX_LIST_LIMIT}, got ${String(limit)}.`);
    }
    const given = (v: unknown): boolean => v !== undefined && v !== null;
    if (given(reference) && given(referencePrefix)) {
      throw localError(BadRequestError, 'Send query parameter reference or reference_prefix, not both.');
    }
    const query: string[] = [];
    if (offset !== undefined && offset !== null) query.push(`offset=${offset}`);
    if (limit !== undefined && limit !== null) query.push(`limit=${limit}`);
    for (const [name, value] of [
      ['reference', reference],
      ['reference_prefix', referencePrefix],
    ] as const) {
      if (!given(value)) continue;
      checkReferenceQuery(name, value);
      query.push(`${name}=${encodeURIComponent(value as string)}`);
    }
    const qs = query.join('&');
    const { body } = await this.#ctx.transport.json({
      method: 'GET',
      path: `/v1/collections/${path(collectionId)}/items${qs ? `?${qs}` : ''}`,
      signal: options.signal,
    });
    return body as CollectionItemPage;
  }

  /** Deletes one item (`DELETE /v1/collections/{id}/items/{item_id}`). */
  async deleteItem(collectionId: string, itemId: string, options: { signal?: AbortSignal } = {}): Promise<Deleted> {
    const { body } = await this.#ctx.transport.json({
      method: 'DELETE',
      path: `/v1/collections/${path(collectionId)}/items/${path(itemId)}`,
      signal: options.signal,
    });
    return body as Deleted;
  }
}
