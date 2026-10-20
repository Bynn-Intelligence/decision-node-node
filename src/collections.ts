/**
 * Collections: a workspace's collections of faces, which the
 * `face_recognition` booster searches, and the public collections it may use;
 * and its collections of type `text` (knowledge bases), whose documents the
 * `knowledge` booster retrieves passages from. Every call returns the API's
 * object as sent, wire names as they are; a search returns a `KnowledgeReading`.
 */

import { KnowledgeReading } from './boosters.js';
import { entry, localValidation, type Entry, type HeldLimits } from './checks.js';
import { BadRequestError, ServerError, TimeoutError, localError, retryAfterSeconds } from './errors.js';
import { resolveDocument, type DocumentInput, type ResolvedDocument } from './knowledge.js';
import type { Transport } from './transport.js';
import { STALE_UPLOAD, type ImageInput, type ImagePlacer } from './uploads.js';

export interface CollectionsContext {
  transport: Transport;
  placer: ImagePlacer;
  /** The model's published limits, when the client holds them. */
  limits: () => HeldLimits;
  /** Text and Markdown files under this many bytes go inline as the item's text. Default 524,288. */
  inlineThreshold?: number;
  /** Milliseconds one storage PUT attempt of a document may take. Default 120,000. */
  documentUploadTimeout?: number;
  /** Whether the caller set the client's `timeout`, which a call with `wait` then keeps. */
  timeoutGiven?: boolean;
}

/** The items of a text collection by the status of their newest version. */
export interface StatusCounts {
  queued: number;
  processing: number;
  ready: number;
  failed: number;
  [status: string]: number;
}

/** A text collection's pinned load. */
export interface PinnedLoad {
  /** The global pins' tokens plus those of the largest scope value. */
  tokens: number;
  /** The most pinned tokens one scope value may hold. */
  cap: number;
  /** The scope value with the most pinned tokens, or `null`. */
  largest_scope: { value: string; tokens: number } | null;
  [field: string]: unknown;
}

/**
 * A collection, as the API sends it: `type` `face` or `text`. A text
 * collection (a knowledge base) also carries `scope_key`, `chunks`, `tokens`,
 * `version`, `status_counts` and `pinned`; a face collection none of them.
 */
export interface Collection {
  id: string;
  type: 'face' | 'text' | (string & {});
  name: string;
  /** `true` for a public collection, which no workspace can change. */
  public: boolean;
  /** How many items it holds. */
  items: number;
  created_at: string;
  /** A text collection's scope key, the metadata key that scopes an item, or `null`. */
  scope_key?: string | null;
  /** A text collection's searchable chunks. */
  chunks?: number;
  /** A text collection's searchable tokens. */
  tokens?: number;
  /** A text collection's corpus version, raised by every change a search can see. */
  version?: number;
  status_counts?: StatusCounts;
  pinned?: PinnedLoad;
  /** A text collection's delete still purging: `purging`. */
  status?: string;
  [field: string]: unknown;
}

/** An item's metadata: up to 20 keys of `a-z`, `0-9` and `_`, each a text, a number or true or false. */
export type ItemMetadata = Record<string, string | number | boolean>;

/** A document item's file, when it was made from one. */
export interface ItemFile {
  filename: string;
  content_type: string;
  byte_size: number;
  /** A PDF's pages, once known. */
  pages: number | null;
  /** Whether the uploaded original is still kept; it is deleted once its text is extracted. */
  original_held: boolean;
  [field: string]: unknown;
}

/** A document item's progress while `processing`. */
export interface ItemProgress {
  chunks_embedded: number;
  chunks_total: number;
  pages: number | null;
  [field: string]: unknown;
}

/**
 * One item, as the API sends it: an enrolled face, or a document of a text
 * collection with its `title`, `format`, `status` and the rest.
 */
export interface CollectionItem {
  id: string;
  reference: string;
  label?: string | null;
  metadata?: ItemMetadata;
  title?: string;
  format?: 'markdown' | 'text' | (string & {});
  pinned?: boolean;
  pin_rank?: number;
  /** `article` (written as text) or `file` (made from a file). */
  source?: 'article' | 'file' | (string & {});
  /** The file it was made from; `null` for an article. */
  file?: ItemFile | null;
  /** The newest version's: `queued`, `processing`, `ready`, `failed`, or a newer value as sent. */
  status?: 'queued' | 'processing' | 'ready' | 'failed' | (string & {});
  /** While `processing`: `extracting`, `chunking` or `embedding`; else `null`. */
  stage?: string | null;
  progress?: ItemProgress | null;
  /** `current` (the newest version is searchable), `previous` (an older one serves) or `none`. */
  serving?: 'current' | 'previous' | 'none' | (string & {});
  /** Why the newest version failed, or `null`. */
  error?: string | null;
  /** `true` when it has waited past 15 minutes for ingestion; never a failure. */
  delayed?: boolean;
  warnings?: string[];
  chunks?: number;
  tokens?: number;
  content_sha256?: string;
  version?: number;
  queued_at?: string | null;
  ready_at?: string | null;
  /** The stored text, from `getItem` with `includeText`; `null` while nothing serves. */
  text?: string | null;
  [field: string]: unknown;
}

/** One chunk of a document item. */
export interface ItemChunk {
  chunk: number;
  /** The heading path. */
  heading: string | null;
  /** UTF-8 byte offsets into the stored text, end exclusive. */
  byte_start: number;
  byte_end: number;
  page_start: number | null;
  page_end: number | null;
  tokens: number;
  text: string;
  [field: string]: unknown;
}

/** One page of a document item's chunks. */
export interface ItemChunkPage {
  chunks: ItemChunk[];
  offset: number;
  limit: number;
  total: number;
  /** The offset of the next page, or `null` on the last. */
  next_offset: number | null;
  [field: string]: unknown;
}

/** The fields of a document item, each sent only when given. */
export interface DocumentFields {
  /** 1 to 200 characters. Required for a text; for a file, its name's stem by default. */
  title?: string;
  /** 1 to 64 of `A-Z a-z 0-9 _ . : -`, unique in the collection; left out, the item's id. */
  reference?: string;
  /** `true`: always given to a request that names the collection. */
  pinned?: boolean;
  /** 0 to 1,000: the order of pinned items, lowest first. */
  pinRank?: number;
  /** At most 128 characters. */
  label?: string | null;
  /** Up to 20 keys; the collection's scope key's value scopes the item. */
  metadata?: ItemMetadata;
  /**
   * `true`: the server holds the call up to 10 s and answers once the document
   * is ready, else as it stands. The call then waits 20 s per attempt unless
   * the client's `timeout` is set.
   */
  wait?: boolean;
}

/** The parameters of `addDocument` and `replaceDocument`. */
export interface DocumentParams extends DocumentFields {
  document: DocumentInput;
}

/** The parameters of `search`, each sent only when given and as given; the API checks them. */
export interface SearchParams {
  query: string;
  scope?: string;
  match?: Record<string, unknown>;
  filter?: Record<string, unknown>;
  topK?: number;
  pinned?: boolean;
  maxTokens?: number | 'auto';
}

/** The parameters of `waitUntilReady`. */
export interface WaitParams {
  /** The item to wait for; left out, every item of the collection. */
  itemId?: string;
  /** Milliseconds to wait in all, above 0. Default 300,000. */
  timeout?: number;
  /** Milliseconds before the second read, at least 100; then 1.5 times longer each read, up to 10,000. Default 1,000. */
  pollInterval?: number;
  signal?: AbortSignal;
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

/** The default `timeout` of `waitUntilReady`: 5 minutes. */
export const DEFAULT_WAIT_TIMEOUT = 300_000;
/** The default first `pollInterval` of `waitUntilReady`: 1 second. */
export const DEFAULT_WAIT_POLL_INTERVAL = 1_000;
/** The shortest `pollInterval` of `waitUntilReady`. */
export const MIN_WAIT_POLL_INTERVAL = 100;
/** The longest wait between two reads of `waitUntilReady`. */
const MAX_WAIT_POLL_INTERVAL = 10_000;
/** Milliseconds per attempt of a call with `wait`, unless the client's `timeout` is set. */
const WAIT_TIMEOUT = 20_000;

const MAX_NAME_CHARS = 80;
const SCOPE_KEY_PATTERN = '^[a-z0-9_]{1,40}$';
const SCOPE_KEY = new RegExp(SCOPE_KEY_PATTERN);
const MAX_TITLE_CHARS = 200;
const MAX_PIN_RANK = 1000;
const FORMATS = new Set(['markdown', 'text']);
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

function given(v: unknown): boolean {
  return v !== undefined && v !== null;
}

/** `offset` and `limit` of a list, checked as the API checks them, as query parameters. */
function pageQuery(offset: number | undefined | null, limit: number | undefined | null): string[] {
  if (given(offset) && (!Number.isInteger(offset) || (offset as number) < 0)) {
    throw localError(BadRequestError, `Query parameter offset must be an integer of 0 or more, got ${String(offset)}.`);
  }
  if (given(limit) && (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_LIST_LIMIT)) {
    throw localError(BadRequestError, `Query parameter limit must be an integer from 1 to ${MAX_LIST_LIMIT}, got ${String(limit)}.`);
  }
  const query: string[] = [];
  if (given(offset)) query.push(`offset=${offset}`);
  if (given(limit)) query.push(`limit=${limit}`);
  return query;
}

/** A title's entry: 1 to 200 characters once trimmed, counted in code points. */
function titleEntries(title: unknown): Entry[] {
  if (typeof title === 'string') {
    const n = [...title.trim()].length;
    if (n >= 1 && n <= MAX_TITLE_CHARS) return [];
  }
  return [entry('string_too_long', ['body', 'title'], 'A title is 1 to 200 characters', echoed(title))];
}

/**
 * A document item's field entries, in the API's order: `reference`, `pin_rank`,
 * `label` and `metadata` as every collection item's, then `pinned`.
 */
function documentFieldEntries(f: { reference?: unknown; pinned?: unknown; pinRank?: unknown; label?: unknown; metadata?: unknown }): Entry[] {
  const out: Entry[] = [];
  if (f.reference !== undefined) out.push(...stringEntries(['body', 'reference'], f.reference, MAX_REFERENCE_CHARS, REFERENCE_PATTERN));
  if (f.pinRank !== undefined && !(Number.isInteger(f.pinRank) && (f.pinRank as number) >= 0 && (f.pinRank as number) <= MAX_PIN_RANK)) {
    out.push(entry('int_range', ['body', 'pin_rank'], 'Input should be an integer from 0 to 1000', echoed(f.pinRank)));
  }
  if (given(f.label)) out.push(...stringEntries(['body', 'label'], f.label, MAX_LABEL_CHARS));
  if (f.metadata !== undefined) out.push(...metadataEntries(f.metadata));
  if (f.pinned !== undefined && typeof f.pinned !== 'boolean') {
    out.push(entry('bool_type', ['body', 'pinned'], 'Input should be a valid boolean', echoed(f.pinned)));
  }
  return out;
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

  /**
   * Creates a collection (`POST /v1/collections`): `type` `face` (the default)
   * or `text`, a knowledge base. `scopeKey`, for a text collection, names the
   * one metadata key whose value scopes an item (`^[a-z0-9_]{1,40}$`), fixed
   * for the collection's life; sent only when given.
   */
  async create(
    params: { name: string; type?: 'face' | 'text' | (string & {}); scopeKey?: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<Collection> {
    const type = params.type ?? 'face';
    const entries: Entry[] = [];
    if (type !== 'face' && type !== 'text') {
      entries.push(entry('literal_error', ['body', 'type'], "Input should be 'face' or 'text'", echoed(type), { expected: "'face' or 'text'" }));
    }
    entries.push(...stringEntries(['body', 'name'], params.name, MAX_NAME_CHARS));
    const scopeKey = params.scopeKey;
    if (given(scopeKey) && (typeof scopeKey !== 'string' || !SCOPE_KEY.test(scopeKey))) {
      entries.push(entry('string_pattern_mismatch', ['body', 'scope_key'], `String should match pattern '${SCOPE_KEY_PATTERN}'`, echoed(scopeKey)));
    }
    if (entries.length > 0) throw localValidation(entries);
    const body: Record<string, unknown> = { type, name: params.name };
    if (given(scopeKey)) body.scope_key = scopeKey;
    const res = await this.#ctx.transport.json({
      method: 'POST',
      path: '/v1/collections',
      body: JSON.stringify(body),
      policy: 'idempotent',
      headers: idempotencyKey(),
      signal: options.signal,
    });
    return res.body as Collection;
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

  /**
   * Deletes a collection and its items (`DELETE /v1/collections/{id}`). A text
   * collection answers `{ id, deleted: true }` once purged within 10 s, else
   * `{ id, status: 'purging' }` while the purge finishes in the background;
   * both are success, returned as sent.
   */
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
   * item's whole object (`{}` empties it). A document also takes `pinned`,
   * `pinRank` and `title`: the fields apply at once, never re-embedded or
   * billed (200), while a new `title` makes a new version (202). It carries an
   * Idempotency-Key and retries as `create` and `enroll` do. Returns the item as sent.
   */
  async updateItem(
    collectionId: string,
    itemId: string,
    params: { reference?: string; label?: string | null; metadata?: ItemMetadata; pinned?: boolean; pinRank?: number; title?: string },
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
    // A document's own fields.
    if (params.pinned !== undefined && typeof params.pinned !== 'boolean') {
      entries.push(entry('bool_type', ['body', 'pinned'], 'Input should be a valid boolean', echoed(params.pinned)));
    }
    if (params.pinRank !== undefined && !(Number.isInteger(params.pinRank) && params.pinRank >= 0 && params.pinRank <= MAX_PIN_RANK)) {
      entries.push(entry('int_range', ['body', 'pin_rank'], 'Input should be an integer from 0 to 1000', echoed(params.pinRank)));
    }
    if (params.title !== undefined) entries.push(...titleEntries(params.title));
    if (params.pinned !== undefined) body.pinned = params.pinned;
    if (params.pinRank !== undefined) body.pin_rank = params.pinRank;
    if (params.title !== undefined) body.title = params.title;
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
    const query = pageQuery(offset, limit);
    if (given(reference) && given(referencePrefix)) {
      throw localError(BadRequestError, 'Send query parameter reference or reference_prefix, not both.');
    }
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

  /**
   * Adds a document to a text collection (`POST /v1/collections/{id}/items`).
   * A text, and a text or Markdown file under the client's `inlineThreshold`,
   * go inline as the item's text; every other file is uploaded first (one
   * presign with the knowledge purpose, one PUT) and named by its upload id.
   * Ingestion is asynchronous: the item comes back `queued` (202), or with
   * `wait` once `ready` (201) or as it stands after the server's 10 s. Carries
   * an Idempotency-Key, a new UUID per call, the same on every attempt.
   */
  async addDocument(collectionId: string, params: DocumentParams, options: { signal?: AbortSignal } = {}): Promise<CollectionItem> {
    return this.#writeDocument('POST', `/v1/collections/${path(collectionId)}/items`, params, options.signal);
  }

  /**
   * Replaces a document whole (`PUT /v1/collections/{id}/items/{item_id}`): a
   * new text, format or title is a new version, the old one serving until the
   * swap; the same text again is a no-op (200). As `addDocument` otherwise.
   */
  async replaceDocument(
    collectionId: string,
    itemId: string,
    params: DocumentParams,
    options: { signal?: AbortSignal } = {},
  ): Promise<CollectionItem> {
    return this.#writeDocument('PUT', `/v1/collections/${path(collectionId)}/items/${path(itemId)}`, params, options.signal);
  }

  async #writeDocument(method: string, at: string, params: DocumentParams, signal: AbortSignal | undefined): Promise<CollectionItem> {
    if (params === null || typeof params !== 'object') throw new TypeError('a document call takes an object with a document');
    const ctx = this.#ctx;
    const doc = await resolveDocument(params.document, ctx.inlineThreshold ?? 524_288);
    const head = documentHead(doc, params);
    const fields: Record<string, unknown> = {};
    if (params.reference !== undefined) fields.reference = params.reference;
    if (params.pinned !== undefined) fields.pinned = params.pinned;
    if (params.pinRank !== undefined) fields.pin_rank = params.pinRank;
    if (params.label !== undefined && params.label !== null) fields.label = params.label;
    if (params.metadata !== undefined) fields.metadata = params.metadata;
    const entries = [
      ...head.entries,
      ...documentFieldEntries({ reference: params.reference, pinned: params.pinned, pinRank: params.pinRank, label: params.label, metadata: params.metadata }),
    ];
    if (entries.length > 0) throw localValidation(entries);
    const query = params.wait === true ? '?wait=true' : '';
    const timeout = params.wait === true && !ctx.timeoutGiven ? WAIT_TIMEOUT : undefined;
    for (let resend = 0; ; resend++) {
      let body = head.body;
      if (doc.kind === 'file') {
        const [uploadId] = await ctx.placer.uploadKnowledge(
          [{ bytes: doc.bytes, contentType: doc.contentType, filename: doc.filename }],
          signal,
          ctx.documentUploadTimeout ?? 120_000,
        );
        body = withUpload(uploadId!, params.title);
      }
      try {
        // A new key on a resend: its body changed.
        const res = await ctx.transport.json({
          method,
          path: at + query,
          body: JSON.stringify({ ...body, ...fields }),
          policy: 'idempotent',
          headers: idempotencyKey(),
          signal,
          timeout,
        });
        return res.body as CollectionItem;
      } catch (err) {
        // An upload this call placed that went stale is placed again, once; that resend is not a retry.
        if (resend === 0 && doc.kind === 'file' && err instanceof BadRequestError && err.errorType !== null && STALE_UPLOAD.has(err.errorType)) {
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * One item (`GET /v1/collections/{id}/items/{item_id}`). With `includeText`,
   * a document's stored text too (`?include=text`), the text its passages'
   * byte offsets index; `null` while nothing serves.
   */
  async getItem(
    collectionId: string,
    itemId: string,
    params: { includeText?: boolean } = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<CollectionItem> {
    const query = params.includeText === true ? '?include=text' : '';
    const { body } = await this.#ctx.transport.json({
      method: 'GET',
      path: `/v1/collections/${path(collectionId)}/items/${path(itemId)}${query}`,
      signal: options.signal,
    });
    return body as CollectionItem;
  }

  /**
   * One page of a document item's live chunks
   * (`GET /v1/collections/{id}/items/{item_id}/chunks`), `offset` and `limit`
   * sent only when given.
   */
  async listChunks(
    collectionId: string,
    itemId: string,
    params: { offset?: number; limit?: number } = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<ItemChunkPage> {
    const qs = pageQuery(params.offset, params.limit).join('&');
    const { body } = await this.#ctx.transport.json({
      method: 'GET',
      path: `/v1/collections/${path(collectionId)}/items/${path(itemId)}/chunks${qs ? `?${qs}` : ''}`,
      signal: options.signal,
    });
    return body as ItemChunkPage;
  }

  /**
   * Deletes every failed document of a text collection
   * (`DELETE /v1/collections/{id}/items?status=failed`), and answers how many
   * were deleted, as sent.
   */
  async deleteFailedItems(collectionId: string, options: { signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
    const { body } = await this.#ctx.transport.json({
      method: 'DELETE',
      path: `/v1/collections/${path(collectionId)}/items?status=failed`,
      signal: options.signal,
    });
    return body;
  }

  /**
   * Waits for ingestion. With `itemId`, reads the item until its `status` is
   * `ready` or `failed` and returns it, whichever it is (a failed item's
   * `error` says why). Without, reads the collection until no item is
   * `queued` or `processing` and returns it. The first read is made at once;
   * then it waits `pollInterval`, 1.5 times longer after each read up to 10 s,
   * or the server's `Retry-After` when longer. Past `timeout` it throws
   * `TimeoutError`.
   */
  waitUntilReady(collectionId: string, params: WaitParams & { itemId: string }): Promise<CollectionItem>;
  waitUntilReady(collectionId: string, params?: WaitParams & { itemId?: undefined }): Promise<Collection>;
  waitUntilReady(collectionId: string, params?: WaitParams): Promise<CollectionItem | Collection>;
  async waitUntilReady(collectionId: string, params: WaitParams = {}): Promise<CollectionItem | Collection> {
    const timeout = params.timeout ?? DEFAULT_WAIT_TIMEOUT;
    if (typeof timeout !== 'number' || !(timeout > 0)) {
      throw new RangeError(`timeout must be above 0 milliseconds, got ${String(timeout)}`);
    }
    let interval = params.pollInterval ?? DEFAULT_WAIT_POLL_INTERVAL;
    if (typeof interval !== 'number' || !(interval >= MIN_WAIT_POLL_INTERVAL)) {
      throw new RangeError(`pollInterval must be at least ${MIN_WAIT_POLL_INTERVAL} ms, got ${String(interval)}`);
    }
    const { itemId, signal } = params;
    const at =
      itemId === undefined || itemId === null
        ? `/v1/collections/${path(collectionId)}`
        : `/v1/collections/${path(collectionId)}/items/${path(itemId)}`;
    const transport = this.#ctx.transport;
    let waited = 0;
    for (;;) {
      const { body, res } = await transport.json({ method: 'GET', path: at, signal });
      if (itemId === undefined || itemId === null ? settled(body) : body.status === 'ready' || body.status === 'failed') {
        return body as CollectionItem | Collection;
      }
      if (waited >= timeout) {
        throw new TimeoutError(
          itemId === undefined || itemId === null
            ? `collection ${collectionId} was not ready within ${timeout} ms`
            : `item ${itemId} was not ready within ${timeout} ms`,
        );
      }
      const server = retryAfterSeconds(res.headers);
      // Never past the timeout: the last read is made when it runs out.
      const wait = Math.min(server !== null ? Math.max(interval, server * 1000) : interval, timeout - waited);
      await transport.sleep(wait, signal);
      waited += wait;
      interval = Math.min(interval * 1.5, MAX_WAIT_POLL_INTERVAL);
    }
  }

  /**
   * Retrieves passages without a decision (`POST /v1/collections/{id}/search`),
   * each with its text. Every parameter is sent only when given and as given;
   * the API checks them. Billed as one knowledge call; needs a full-scope key.
   */
  async search(collectionId: string, params: SearchParams, options: { signal?: AbortSignal } = {}): Promise<KnowledgeReading> {
    if (params === null || typeof params !== 'object') throw new TypeError('search takes an object with a query');
    const body: Record<string, unknown> = {};
    const fields: Array<[string, unknown]> = [
      ['query', params.query],
      ['scope', params.scope],
      ['match', params.match],
      ['filter', params.filter],
      ['top_k', params.topK],
      ['pinned', params.pinned],
      ['max_tokens', params.maxTokens],
    ];
    for (const [key, value] of fields) if (value !== undefined) body[key] = value;
    const { body: raw, res } = await this.#ctx.transport.json({
      method: 'POST',
      path: `/v1/collections/${path(collectionId)}/search`,
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (!KnowledgeReading.wellFormed(raw)) {
      throw new ServerError('the search answer is not a knowledge reading', {
        status: res.status,
        requestId: res.headers['x-request-id'] ?? null,
        body: raw,
        headers: res.headers,
      });
    }
    return new KnowledgeReading(raw);
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

/** Whether no item of a collection is `queued` or `processing` (each 0 or absent). */
function settled(collection: Record<string, unknown>): boolean {
  const counts = collection.status_counts;
  if (counts === null || typeof counts !== 'object') return true;
  const c = counts as Record<string, unknown>;
  return !c.queued && !c.processing;
}

/**
 * The item body's head for a document, before its fields: `title`, `text` and
 * `format` for a text sent inline, `upload_id` and `title` when given for an
 * upload made before; with the entries of what is wrong with them. A file to
 * upload has its body made once its upload id is known.
 */
function documentHead(doc: ResolvedDocument, params: DocumentFields): { body: Record<string, unknown>; entries: Entry[] } {
  const entries: Entry[] = [];
  if (doc.kind === 'text' || doc.kind === 'inline') {
    const title = params.title ?? (doc.kind === 'inline' ? doc.stem ?? undefined : undefined);
    if (title === undefined || title === null) entries.push(entry('missing', ['body', 'title'], 'Field required', null));
    else entries.push(...titleEntries(title));
    if (doc.text === '') entries.push(entry('string_too_short', ['body', 'text'], 'The text is empty', ''));
    if (doc.kind === 'text' && doc.format !== undefined && !FORMATS.has(doc.format)) {
      entries.push(entry('literal_error', ['body', 'format'], "Input should be 'markdown' or 'text'", echoed(doc.format)));
    }
    const body: Record<string, unknown> = { title, text: doc.text };
    if (doc.format !== undefined) body.format = doc.format;
    return { body, entries };
  }
  if (params.title !== undefined) entries.push(...titleEntries(params.title));
  return { body: doc.kind === 'upload' ? withUpload(doc.uploadId, params.title) : {}, entries };
}

function withUpload(uploadId: string, title: string | undefined): Record<string, unknown> {
  const body: Record<string, unknown> = { upload_id: uploadId };
  if (title !== undefined) body.title = title;
  return body;
}
