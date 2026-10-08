/**
 * How a request's images travel: URLs and upload ids as given; local bytes
 * inline as base64 while the request's local images total under the inline
 * threshold, otherwise uploaded once (one presign, the PUTs in parallel) and
 * named by `upload_id`. An in-memory cache keyed by the bytes' SHA-256 reuses
 * an upload until 5 minutes before it expires.
 */
import { BadRequestError, ConnectionError, DecisionNodeError, ServerError, TimeoutError, localError } from './errors.js';
import { hex, md5, sha256 } from './hash.js';
import { Image, MAX_IMAGES, checkImageUrl, toBase64, type LocalImage, type WireImage } from './image.js';
import { backoffSeconds, isLoopbackHost, isSuccess, serialise, type Transport } from './transport.js';

/** Local images of one request totalling under this many bytes go inline as base64; at or above it they are uploaded. */
export const DEFAULT_INLINE_THRESHOLD = 524_288;

/** At most this many uploads are remembered per client, least recently used out first. */
const CACHE_ENTRIES = 256;
/** An upload is reused until this long before it expires. */
const CACHE_MARGIN_MS = 5 * 60 * 1000;

/** Errors of a request naming an upload that is no longer usable; the SDK uploads again once. */
export const STALE_UPLOAD = new Set(['upload_expired', 'upload_consumed', 'upload_not_found', 'upload_incomplete']);

/** An image in a request: an `Image`, or a wire-form object sent as given. */
export type ImageInput = Image | WireImage;

/** A request's images after the local checks: references as wire forms, local bytes still to place. */
export interface ImagePlan {
  slots: Array<{ wire: WireImage } | { local: LocalImage }>;
}

export interface Placed {
  wires: WireImage[];
  /** The upload ids this SDK placed in the request, from its cache or a new upload. */
  placed: Set<string>;
}

interface Presigned {
  upload_id: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  expires_at?: string;
}

export class ImagePlacer {
  readonly #transport: Transport;
  readonly #threshold: number;
  /** `<sha256 hex>:<media type>` to the upload, in least recently used order. */
  readonly #cache = new Map<string, { uploadId: string; expiresAt: number }>();
  readonly #inflight = new Map<string, Promise<string>>();
  readonly #keys = new WeakMap<Image, string>();
  readonly #base64 = new WeakMap<Image, string>();

  constructor(transport: Transport, inlineThreshold: number) {
    this.#transport = transport;
    this.#threshold = inlineThreshold;
  }

  /**
   * The local checks of a request's images, before anything is sent: at most
   * 4, unique ids, URLs `https` and at most 2,048 characters, local bytes of a
   * known format within the size and pixel limits.
   */
  async check(images: readonly ImageInput[] | null | undefined): Promise<ImagePlan | null> {
    if (images === undefined || images === null) return null;
    if (!Array.isArray(images)) throw new TypeError('images must be an array');
    if (images.length === 0) return null;
    if (images.length > MAX_IMAGES) {
      throw localError(BadRequestError, `Too many images. Must have at most ${MAX_IMAGES} images.`);
    }
    const ids = new Set<string>();
    const slots: ImagePlan['slots'] = [];
    for (const img of images) {
      if (img === null || typeof img !== 'object') throw new TypeError('an image must be an Image or a wire-form object');
      const id = (img as { id?: unknown }).id;
      if (typeof id === 'string') {
        if (ids.has(id)) throw localError(BadRequestError, `Image ids must be unique within a request: ${id}`);
        ids.add(id);
      }
      if (!(img instanceof Image)) {
        slots.push({ wire: img });
      } else if (img.url !== undefined) {
        checkImageUrl(img.id, img.url);
        slots.push({ wire: img.referenceWire() });
      } else if (img.uploadId !== undefined) {
        slots.push({ wire: img.referenceWire() });
      } else {
        slots.push({ local: await img.checkLocal() });
      }
    }
    return { slots };
  }

  /**
   * The wire forms. Local images with a live cache entry go by `upload_id`;
   * the others go inline while the request's local images total under the
   * threshold, and are uploaded at or above it (or always, with `alwaysUpload`).
   */
  async place(plan: ImagePlan, signal: AbortSignal | undefined, alwaysUpload = false): Promise<Placed> {
    const wires: Array<WireImage | undefined> = new Array(plan.slots.length);
    const placed = new Set<string>();
    const todo: Array<{ index: number; local: LocalImage }> = [];
    let total = 0;
    for (let i = 0; i < plan.slots.length; i++) {
      const slot = plan.slots[i]!;
      if ('wire' in slot) {
        wires[i] = slot.wire;
        continue;
      }
      total += slot.local.bytes.length;
      const hit = this.#cache.size > 0 ? this.#lookup(await this.#key(slot.local)) : undefined;
      if (hit !== undefined) {
        wires[i] = { id: slot.local.id, upload_id: hit };
        placed.add(hit);
      } else {
        todo.push({ index: i, local: slot.local });
      }
    }
    if (todo.length > 0) {
      if (alwaysUpload || total >= this.#threshold) {
        const ids = await this.upload(
          todo.map((t) => t.local),
          signal,
        );
        todo.forEach((t, k) => {
          wires[t.index] = { id: t.local.id, upload_id: ids[k]! };
          placed.add(ids[k]!);
        });
      } else {
        for (const t of todo) {
          wires[t.index] = { id: t.local.id, media_type: t.local.mediaType, data: this.#encode(t.local) };
        }
      }
    }
    return { wires: wires as WireImage[], placed };
  }

  /** Forgets the cache entries of these uploads, so the next request uploads the bytes again. */
  drop(uploadIds: Set<string>): void {
    for (const [key, entry] of this.#cache) {
      if (uploadIds.has(entry.uploadId)) this.#cache.delete(key);
    }
  }

  /** The cached upload id of each image, uploading those without one (one presign, the PUTs in parallel). */
  async upload(locals: readonly LocalImage[], signal: AbortSignal | undefined): Promise<string[]> {
    const keys = await Promise.all(locals.map((l) => this.#key(l)));
    const waits = new Map<string, Promise<string>>();
    const mine: Array<[string, LocalImage]> = [];
    keys.forEach((key, i) => {
      if (waits.has(key)) return;
      const hit = this.#lookup(key);
      if (hit !== undefined) {
        waits.set(key, Promise.resolve(hit));
        return;
      }
      // The same bytes already on their way for another request: wait for that upload.
      const inflight = this.#inflight.get(key);
      if (inflight !== undefined) {
        waits.set(key, inflight);
        return;
      }
      mine.push([key, locals[i]!]);
      waits.set(key, Promise.resolve(''));
    });
    if (mine.length > 0) {
      const job = this.#presignAndPut(mine, signal);
      job.catch(() => {});
      for (const [key] of mine) {
        const one = job.then((ids) => ids.get(key)!);
        one.catch(() => {});
        this.#inflight.set(key, one);
        waits.set(key, one);
      }
      void job
        .finally(() => {
          for (const [key] of mine) this.#inflight.delete(key);
        })
        .catch(() => {});
    }
    const resolved = new Map<string, string>();
    for (const [key, p] of waits) resolved.set(key, await p);
    return keys.map((k) => resolved.get(k)!);
  }

  async #presignAndPut(items: Array<[string, LocalImage]>, signal: AbortSignal | undefined, again = false): Promise<Map<string, string>> {
    const files = await Promise.all(
      items.map(async ([, l]) => ({
        content_type: l.mediaType,
        byte_size: l.bytes.length,
        checksum: toBase64(md5(l.bytes)),
        sha256: toBase64(await sha256(l.bytes)),
      })),
    );
    const presignedAt = Date.now();
    const { body, res } = await this.#transport.json({ method: 'POST', path: '/v1/uploads', body: serialise({ files }), signal });
    const uploads = Array.isArray(body.uploads) ? (body.uploads as Presigned[]) : [];
    if (uploads.length !== items.length || uploads.some((u) => !u || typeof u.upload_id !== 'string' || typeof u.url !== 'string')) {
      throw new ServerError('the upload answer does not hold one upload per file', {
        status: res.status,
        requestId: res.headers['x-request-id'] ?? null,
        body,
        headers: res.headers,
      });
    }
    try {
      await Promise.all(items.map(([, l], i) => this.#put(uploads[i]!, l.bytes, signal)));
    } catch (err) {
      // A storage URL whose 5 minutes passed refuses the PUT with 403: presign once more.
      const expiresIn = typeof body.expires_in === 'number' ? body.expires_in * 1000 : 300_000;
      if (!again && err instanceof DecisionNodeError && err.status === 403 && Date.now() - presignedAt >= expiresIn) {
        return this.#presignAndPut(items, signal, true);
      }
      throw err;
    }
    const out = new Map<string, string>();
    items.forEach(([key], i) => {
      const up = uploads[i]!;
      out.set(key, up.upload_id);
      const expiresAt = typeof up.expires_at === 'string' ? Date.parse(up.expires_at) : NaN;
      if (Number.isFinite(expiresAt)) this.#remember(key, up.upload_id, expiresAt);
    });
    return out;
  }

  /**
   * One PUT to the storage URL with exactly the headers the presign returned
   * and the bytes: no key, none of the client's headers, no redirect followed.
   * Retried on 5xx, timeouts and connection errors; a 412 on a retry means an
   * earlier attempt stored the object, which is written once.
   */
  async #put(up: Presigned, bytes: Uint8Array, signal: AbortSignal | undefined): Promise<void> {
    let url: URL;
    try {
      url = new URL(up.url);
    } catch {
      throw new DecisionNodeError(`the storage URL is not a URL: ${up.url}`);
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
      throw new DecisionNodeError(`the storage URL must be https, got ${url.protocol.slice(0, -1)}`);
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(up.headers ?? {})) if (typeof v === 'string') headers[k] = v;
    const transport = this.#transport;
    for (let attempt = 0; ; attempt++) {
      let status: number;
      let text: string;
      try {
        const res = await transport.send(up.method || 'PUT', up.url, headers, bytes, signal);
        if (res.redirected) {
          throw new DecisionNodeError('the storage answered with a redirect, which is not followed', {
            status: res.status || null,
            errorType: 'upload_failed',
          });
        }
        status = res.status;
        text = res.text;
      } catch (err) {
        if (!(err instanceof ConnectionError || err instanceof TimeoutError) || attempt >= transport.maxRetries) throw err;
        await transport.sleep(backoffSeconds(attempt) * 1000, signal);
        continue;
      }
      if (isSuccess(status)) return;
      if (status === 412 && attempt > 0) return;
      if (status >= 500 && status <= 599 && attempt < transport.maxRetries) {
        await transport.sleep(backoffSeconds(attempt) * 1000, signal);
        continue;
      }
      const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1] ?? null;
      throw new DecisionNodeError(`the upload to storage failed with ${status}`, {
        status,
        errorType: 'upload_failed',
        reason: code,
        body: text,
      });
    }
  }

  #lookup(key: string): string | undefined {
    const entry = this.#cache.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() >= entry.expiresAt - CACHE_MARGIN_MS) {
      this.#cache.delete(key);
      return undefined;
    }
    // Most recently used last.
    this.#cache.delete(key);
    this.#cache.set(key, entry);
    return entry.uploadId;
  }

  #remember(key: string, uploadId: string, expiresAt: number): void {
    this.#cache.delete(key);
    this.#cache.set(key, { uploadId, expiresAt });
    while (this.#cache.size > CACHE_ENTRIES) {
      this.#cache.delete(this.#cache.keys().next().value!);
    }
  }

  async #key(local: LocalImage): Promise<string> {
    if (local.owned) {
      const known = this.#keys.get(local.image);
      if (known !== undefined) return known;
    }
    const key = `${hex(await sha256(local.bytes))}:${local.mediaType}`;
    if (local.owned) this.#keys.set(local.image, key);
    return key;
  }

  #encode(local: LocalImage): string {
    if (!local.owned) return toBase64(local.bytes);
    let text = this.#base64.get(local.image);
    if (text === undefined) {
      text = toBase64(local.bytes);
      this.#base64.set(local.image, text);
    }
    return text;
  }
}
