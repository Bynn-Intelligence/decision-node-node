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

/** One enrolled face, as the API sends it. */
export interface CollectionItem {
  id: string;
  reference: string;
  label?: string | null;
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
const REFERENCE_PATTERN = '^[A-Za-z0-9_.:-]+$';
const MAX_LIST_LIMIT = 100;

/** A string field's 422 entries, as the API lists them: missing, not a string, too short, too long, or off its pattern. */
function stringEntries(loc: string[], value: unknown, least: number, most: number, pattern?: string): Entry[] {
  if (value === undefined || value === null) return least > 0 ? [entry('missing', loc, 'Field required', null)] : [];
  if (typeof value !== 'string') return [entry('string_type', loc, 'Input should be a valid string', value)];
  // Counted in code points, as the API counts them.
  const length = [...value].length;
  if (length < least) {
    return [entry('string_too_short', loc, `String should have at least ${least} character${least === 1 ? '' : 's'}`, value, { min_length: least })];
  }
  if (length > most) {
    return [entry('string_too_long', loc, `String should have at most ${most} characters`, value, { max_length: most })];
  }
  if (pattern !== undefined && !new RegExp(pattern).test(value)) {
    return [entry('string_pattern_mismatch', loc, `String should match pattern '${pattern}'`, value, { pattern })];
  }
  return [];
}

function path(...ids: string[]): string {
  return ids.map((id) => encodeURIComponent(String(id))).join('/');
}

/**
 * `client.collections`: create, list, get and delete collections, and enroll,
 * list and delete their items. `create` and `enroll` are retried only on 429
 * and 529, as a batch's create is: a retried enrollment would enroll the face,
 * and bill it, twice. The reads and deletes are retried as every call.
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
      entries.push(entry('literal_error', ['body', 'type'], "Input should be 'face'", type, { expected: "'face'" }));
    }
    entries.push(...stringEntries(['body', 'name'], params.name, 1, MAX_NAME_CHARS));
    if (entries.length > 0) throw localValidation(entries);
    const { body } = await this.#ctx.transport.json({
      method: 'POST',
      path: '/v1/collections',
      body: JSON.stringify({ type, name: params.name }),
      policy: 'mutation',
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
   * `reference`, with an optional `label`. The image is checked and sent as a
   * decision's image is: a URL as given, local bytes inline or uploaded.
   */
  async enroll(
    collectionId: string,
    params: { image: ImageInput; reference: string; label?: string | null },
    options: { signal?: AbortSignal } = {},
  ): Promise<CollectionItem> {
    const { image, reference, label } = params;
    const entries: Entry[] = [];
    if (image === undefined || image === null) entries.push(entry('missing', ['body', 'image'], 'Field required', { reference }));
    entries.push(...stringEntries(['body', 'reference'], reference, 1, MAX_REFERENCE_CHARS, REFERENCE_PATTERN));
    if (label !== undefined && label !== null) entries.push(...stringEntries(['body', 'label'], label, 0, MAX_LABEL_CHARS));
    if (entries.length > 0) throw localValidation(entries);
    const plan = await this.#ctx.placer.check([image], this.#ctx.limits());
    const { wires } = await this.#ctx.placer.place(plan!, options.signal);
    const body: Record<string, unknown> = { image: wires[0], reference };
    if (label !== undefined && label !== null) body.label = label;
    const res = await this.#ctx.transport.json({
      method: 'POST',
      path: `/v1/collections/${path(collectionId)}/items`,
      body: JSON.stringify(body),
      policy: 'mutation',
      signal: options.signal,
    });
    return res.body as CollectionItem;
  }

  /** One page of a collection's items (`GET /v1/collections/{id}/items`); `offset` and `limit` are sent only when given. */
  async listItems(
    collectionId: string,
    params: { offset?: number; limit?: number } = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<CollectionItemPage> {
    const { offset, limit } = params;
    if (offset !== undefined && offset !== null && (!Number.isInteger(offset) || offset < 0)) {
      throw localError(BadRequestError, `Query parameter offset must be an integer of 0 or more, got ${String(offset)}.`);
    }
    if (limit !== undefined && limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT)) {
      throw localError(BadRequestError, `Query parameter limit must be an integer from 1 to ${MAX_LIST_LIMIT}, got ${String(limit)}.`);
    }
    const query = new URLSearchParams();
    if (offset !== undefined && offset !== null) query.set('offset', String(offset));
    if (limit !== undefined && limit !== null) query.set('limit', String(limit));
    const qs = query.toString();
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
