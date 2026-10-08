/**
 * The Batch API: many decide requests run at half price within 24 hours.
 * Lines go up as JSON Lines; results come back as JSON Lines in upload order.
 */
import { Decision } from './answers.js';
import {
  BadRequestError,
  ConnectionError,
  DecisionNodeError,
  TimeoutError,
  errorFromResponse,
  localError,
  retryAfterSeconds,
  type ErrorFields,
} from './errors.js';
import type { Questions } from './questions.js';
import { heldNumber, type HeldLimits } from './checks.js';
import { prepare, withImages, type Prepared } from './request.js';
import type { VideoInput } from './video.js';
import { abortReason, type RawResponse, type Transport } from './transport.js';
import type { ImageInput, ImagePlacer } from './uploads.js';

/** The most bytes one add call carries; a larger list is split into several calls, in order. */
export const MAX_BATCH_ADD_BYTES = 10_485_760;
/** The shortest `pollInterval` of `runBatch`, in milliseconds. */
export const MIN_POLL_INTERVAL = 10_000;
/** The default `pollInterval` of `runBatch`: 60 seconds. */
export const DEFAULT_POLL_INTERVAL = 60_000;
/** The default `timeout` of `runBatch`: 26 hours, past a batch's 24-hour window. */
export const DEFAULT_BATCH_TIMEOUT = 26 * 3600 * 1000;

const NDJSON = 'application/x-ndjson';

/** One request of a batch: a decide request and its own id, unique in the batch. */
export interface BatchRequest<Q extends Questions = Questions> {
  customId: string;
  state?: unknown;
  questions: Q;
  images?: readonly ImageInput[] | null;
  /** Videos as frames, sent in the line as the live call sends them. */
  videos?: readonly VideoInput[] | null;
  /** Default: the client's model. */
  model?: string | null;
}

export type BatchState = 'draft' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'expired';

export interface BatchCounters {
  requests: number;
  queued: number;
  inProgress: number;
  completed: number;
  failed: number;
  expired: number;
  cancelled: number;
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** A batch: every field of the batch object, and `raw` as sent. */
export class Batch {
  readonly id: string;
  readonly state: BatchState | string;
  readonly counters: BatchCounters;
  readonly createdAt: string;
  readonly finalizedAt: string | null;
  /** The cut-off: lines not run by then expire. */
  readonly expiresAt: string | null;
  readonly endedAt: string | null;
  readonly resultsUrl: string | null;
  readonly resultsExpireAt: string | null;
  readonly priceFactor: number;
  readonly usage: { inputTokens: number; outputTokens: number };
  /** When `failed`: what happened. */
  readonly error: { errorType: string; message: string } | null;
  readonly raw: Record<string, unknown>;

  constructor(raw: Record<string, unknown>) {
    this.raw = raw;
    this.id = raw.id as string;
    this.state = raw.state as string;
    const c = (raw.counters && typeof raw.counters === 'object' ? raw.counters : {}) as Record<string, unknown>;
    this.counters = {
      requests: num(c.requests),
      queued: num(c.queued),
      inProgress: num(c.in_progress),
      completed: num(c.completed),
      failed: num(c.failed),
      expired: num(c.expired),
      cancelled: num(c.cancelled),
    };
    this.createdAt = raw.created_at as string;
    this.finalizedAt = strOrNull(raw.finalized_at);
    this.expiresAt = strOrNull(raw.expires_at);
    this.endedAt = strOrNull(raw.ended_at);
    this.resultsUrl = strOrNull(raw.results_url);
    this.resultsExpireAt = strOrNull(raw.results_expire_at);
    this.priceFactor = raw.price_factor as number;
    const u = (raw.usage && typeof raw.usage === 'object' ? raw.usage : {}) as Record<string, unknown>;
    this.usage = { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens) };
    const e = raw.error && typeof raw.error === 'object' ? (raw.error as Record<string, unknown>) : null;
    this.error = e ? { errorType: String(e.error_type ?? ''), message: String(e.message ?? '') } : null;
  }

  /** True once the batch is `completed`, `failed`, `cancelled` or `expired`. */
  get ended(): boolean {
    return this.endedAt !== null;
  }
}

/** One page of `batches.list()`, newest first. */
export interface BatchPage {
  batches: Batch[];
  offset: number;
  limit: number;
  total: number;
  /** The offset of the next page, or `null` on the last. */
  nextOffset: number | null;
  raw: Record<string, unknown>;
}

/**
 * One line of a batch's results. `decision` for a `200` line, parsed as
 * `decide` parses it; `error` for any other status, the error that status
 * and body give, as a value; neither for a line that never ran (`expired`,
 * `cancelled`).
 */
export class BatchResult {
  readonly customId: string;
  /** The HTTP status of the line, or `expired` or `cancelled`. */
  readonly status: number | 'expired' | 'cancelled';
  /** The line's headers, names lower-cased. */
  readonly headers: Record<string, string>;
  readonly decision: Decision | null;
  readonly error: DecisionNodeError | null;
  readonly raw: Record<string, unknown>;

  constructor(raw: Record<string, unknown>) {
    this.raw = raw;
    this.customId = raw.custom_id as string;
    this.status = raw.status as number | 'expired' | 'cancelled';
    const headers: Record<string, string> = {};
    if (raw.headers && typeof raw.headers === 'object') {
      for (const [k, v] of Object.entries(raw.headers as Record<string, unknown>)) headers[k.toLowerCase()] = String(v);
    }
    this.headers = headers;
    const body = raw.body;
    if (this.status === 200 && body !== null && typeof body === 'object' && !Array.isArray(body)) {
      this.decision = new Decision(body as Record<string, unknown>, headers);
      this.error = null;
    } else if (typeof this.status === 'number') {
      this.decision = null;
      this.error = errorFromResponse(this.status, headers, body === undefined ? '' : JSON.stringify(body));
    } else {
      this.decision = null;
      this.error = null;
    }
  }
}

/**
 * A batch's results, read line by line as they download, in upload order.
 * Iterate once with `for await`, or collect them with `toArray()`.
 */
export class BatchResults implements AsyncIterable<BatchResult> {
  readonly #stream: ReadableStream<Uint8Array> | null | undefined;
  readonly #timeout: number;
  readonly #signal: AbortSignal | undefined;
  #used = false;

  constructor(stream: ReadableStream<Uint8Array> | null | undefined, timeout: number, signal: AbortSignal | undefined) {
    this.#stream = stream;
    this.#timeout = timeout;
    this.#signal = signal;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<BatchResult, void, undefined> {
    if (this.#used) throw new TypeError('batch results can be read once; call results() again for another pass');
    this.#used = true;
    if (!this.#stream) return;
    const reader = this.#stream.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    try {
      for (;;) {
        const { done, value } = await this.#read(reader);
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffered.indexOf('\n')) !== -1) {
          const line = buffered.slice(0, nl);
          buffered = buffered.slice(nl + 1);
          if (line.trim() !== '') yield parseLine(line);
        }
      }
      buffered += decoder.decode();
      if (buffered.trim() !== '') yield parseLine(buffered);
    } finally {
      reader.releaseLock();
    }
  }

  /** Every result, in upload order. */
  async toArray(): Promise<BatchResult[]> {
    const out: BatchResult[] = [];
    for await (const r of this) out.push(r);
    return out;
  }

  /** One read, which must bring bytes within the client's timeout. */
  async #read(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>> {
    const signal = this.#signal;
    if (signal?.aborted) {
      void reader.cancel().catch(() => {});
      throw abortReason(signal);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const stop = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void reader.cancel().catch(() => {});
        reject(new TimeoutError(`no results data within ${this.#timeout} ms`));
      }, this.#timeout);
      onAbort = () => {
        void reader.cancel().catch(() => {});
        reject(abortReason(signal!));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([reader.read(), stop]);
    } catch (err) {
      if (err instanceof DecisionNodeError || signal?.aborted) throw err;
      throw new ConnectionError(`connection error while reading results: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }
}

function parseLine(line: string): BatchResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    throw new DecisionNodeError('a results line is not JSON', { body: line, cause } as ErrorFields);
  }
  return new BatchResult((parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>);
}

/** What the Batch API needs from its client. */
export interface BatchContext {
  transport: Transport;
  placer: ImagePlacer;
  model: string;
  /** A model's published limits, when the client holds them. */
  limits: (model?: string | null) => HeldLimits;
}

/** The longest `custom_id` the API documents. */
const MAX_CUSTOM_ID_CHARS = 512;
const MAX_LIST_LIMIT = 100;

export interface RunBatchOptions {
  /** Milliseconds between polls, at least 10,000. Default 60,000. A longer `Retry-After` from the server wins. */
  pollInterval?: number;
  /** Milliseconds to wait for the batch to end before a `TimeoutError`. Default 26 hours. */
  timeout?: number;
  signal?: AbortSignal;
}

export interface BatchRun {
  batch: Batch;
  results: BatchResults;
}

interface Line {
  prepared: Prepared;
}

/** The batch requests' local checks, for the client's `checkRequest`. */
export const CHECK_REQUESTS: unique symbol = Symbol('checkRequests');

/** `client.batches`: the seven calls of the Batch API. */
export class Batches {
  readonly #ctx: BatchContext;

  constructor(ctx: BatchContext) {
    this.#ctx = ctx;
  }

  /**
   * Creates a batch from requests (`POST /v1/batches`, JSON Lines). With no
   * requests it creates an empty draft. Every request is checked before
   * anything is sent. Retried only on 429 and 529.
   */
  async create(requests: readonly BatchRequest[] = [], options: { signal?: AbortSignal } = {}): Promise<Batch> {
    const lines = await this.#prepareLines(requests, true);
    const body = (await this.#placeLines(lines, options.signal)).join('');
    return this.#batchCall('POST', '/v1/batches', body, options.signal);
  }

  /**
   * Adds requests to a draft (`POST /v1/batches/{id}/requests`), in calls of
   * at most 10 MiB, in order. Returns the batch after the last call.
   */
  async add(batchId: string, requests: readonly BatchRequest[], options: { signal?: AbortSignal } = {}): Promise<Batch> {
    const lines = await this.#prepareLines(requests, false);
    return this.#addPrepared(batchId, lines, options.signal);
  }

  async #addPrepared(batchId: string, lines: Line[], signal: AbortSignal | undefined): Promise<Batch> {
    const texts = await this.#placeLines(lines, signal);
    const encoder = new TextEncoder();
    const chunks: string[][] = [];
    let current: string[] = [];
    let size = 0;
    for (const text of texts) {
      const n = encoder.encode(text).length;
      if (current.length > 0 && size + n > MAX_BATCH_ADD_BYTES) {
        chunks.push(current);
        current = [];
        size = 0;
      }
      current.push(text);
      size += n;
    }
    chunks.push(current);
    let batch: Batch | undefined;
    for (const chunk of chunks) {
      batch = await this.#batchCall('POST', `/v1/batches/${encodeURIComponent(batchId)}/requests`, chunk.join(''), signal);
    }
    return batch!;
  }

  /**
   * Queues a draft to run (`POST /v1/batches/{id}/finalize`). A `409` from a
   * finalize that went through on an earlier, lost attempt is resolved by
   * reading the batch: when it is no longer a draft, it is returned.
   */
  async finalize(batchId: string, options: { signal?: AbortSignal } = {}): Promise<Batch> {
    try {
      return await this.#batchCall('POST', `/v1/batches/${encodeURIComponent(batchId)}/finalize`, undefined, options.signal);
    } catch (err) {
      if (err instanceof DecisionNodeError && err.status === 409 && err.errorType === 'invalid_batch_state') {
        const batch = await this.get(batchId, options);
        if (batch.state !== 'draft') return batch;
      }
      throw err;
    }
  }

  /** `GET /v1/batches/{id}`. */
  async get(batchId: string, options: { signal?: AbortSignal } = {}): Promise<Batch> {
    return (await this.#getWithHeaders(batchId, options.signal)).batch;
  }

  async #getWithHeaders(batchId: string, signal: AbortSignal | undefined): Promise<{ batch: Batch; res: RawResponse }> {
    const { body, res } = await this.#ctx.transport.json({
      method: 'GET',
      path: `/v1/batches/${encodeURIComponent(batchId)}`,
      signal,
    });
    return { batch: new Batch(body), res };
  }

  /** The key's batches, newest first (`GET /v1/batches`). */
  async list(params: { offset?: number; limit?: number } = {}, options: { signal?: AbortSignal } = {}): Promise<BatchPage> {
    const { offset, limit } = params;
    if (offset !== undefined && offset !== null && (!Number.isInteger(offset) || offset < 0)) {
      throw localError(BadRequestError, `Query parameter offset must be an integer of 0 or more, got ${String(offset)}.`);
    }
    if (limit !== undefined && limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT)) {
      throw localError(BadRequestError, `Query parameter limit must be an integer from 1 to ${MAX_LIST_LIMIT}, got ${String(limit)}.`);
    }
    const query = new URLSearchParams();
    if (params.offset !== undefined && params.offset !== null) query.set('offset', String(params.offset));
    if (params.limit !== undefined && params.limit !== null) query.set('limit', String(params.limit));
    const qs = query.toString();
    const { body } = await this.#ctx.transport.json({ method: 'GET', path: `/v1/batches${qs ? `?${qs}` : ''}`, signal: options.signal });
    const list = Array.isArray(body.batches) ? body.batches : [];
    return {
      batches: list.map((b) => new Batch((b ?? {}) as Record<string, unknown>)),
      offset: num(body.offset),
      limit: num(body.limit),
      total: num(body.total),
      nextOffset: typeof body.next_offset === 'number' ? body.next_offset : null,
      raw: body,
    };
  }

  /**
   * An ended batch's results (`GET /v1/batches/{id}/results`), read line by
   * line as they download. Resolves once the server answers; a batch that has
   * not ended raises its `409`.
   */
  async results(batchId: string, options: { signal?: AbortSignal } = {}): Promise<BatchResults> {
    const transport = this.#ctx.transport;
    const res = await transport.request({
      method: 'GET',
      path: `/v1/batches/${encodeURIComponent(batchId)}/results`,
      signal: options.signal,
      stream: true,
    });
    return new BatchResults(res.stream, transport.timeout, options.signal);
  }

  /** Cancels a batch (`POST /v1/batches/{id}/cancel`); lines already running finish. */
  async cancel(batchId: string, options: { signal?: AbortSignal } = {}): Promise<Batch> {
    const { body } = await this.#ctx.transport.json({
      method: 'POST',
      path: `/v1/batches/${encodeURIComponent(batchId)}/cancel`,
      signal: options.signal,
    });
    return new Batch(body);
  }

  /**
   * The whole lifecycle: an empty draft, the requests added, finalize, a
   * poll every `pollInterval` (the server's `Retry-After` when longer) until
   * the batch ends, then its results. If adding fails, the draft is cancelled
   * and the error raised. Past `timeout` it raises `TimeoutError`.
   */
  async run(requests: readonly BatchRequest[], options: RunBatchOptions = {}): Promise<BatchRun> {
    const pollInterval = options.pollInterval ?? DEFAULT_POLL_INTERVAL;
    if (typeof pollInterval !== 'number' || !(pollInterval >= MIN_POLL_INTERVAL)) {
      throw new RangeError(`pollInterval must be at least ${MIN_POLL_INTERVAL} ms, got ${String(pollInterval)}`);
    }
    const timeout = options.timeout ?? DEFAULT_BATCH_TIMEOUT;
    if (typeof timeout !== 'number' || !(timeout > 0)) {
      throw new RangeError(`timeout must be above 0 milliseconds, got ${String(timeout)}`);
    }
    const signal = options.signal;
    const lines = await this.#prepareLines(requests, true);
    const draft = await this.create([], { signal });
    if (lines.length > 0) {
      try {
        await this.#addPrepared(draft.id, lines, signal);
      } catch (err) {
        try {
          await this.cancel(draft.id, { signal });
        } catch {
          // The add's error is the one to raise.
        }
        throw err;
      }
    }
    let batch = await this.finalize(draft.id, { signal });
    let headers: Record<string, string> = {};
    let waited = 0;
    const sleep = this.#ctx.transport.sleep;
    while (!batch.ended) {
      if (waited >= timeout) {
        throw new TimeoutError(`batch ${batch.id} did not end within ${timeout} ms`);
      }
      const server = retryAfterSeconds(headers);
      const wait = server !== null ? Math.max(pollInterval, server * 1000) : pollInterval;
      await sleep(wait, signal);
      waited += wait;
      const got = await this.#getWithHeaders(batch.id, signal);
      batch = got.batch;
      headers = got.res.headers;
    }
    return { batch, results: await this.results(batch.id, { signal }) };
  }

  async #batchCall(method: string, path: string, body: string | undefined, signal: AbortSignal | undefined): Promise<Batch> {
    const res = await this.#ctx.transport.json({
      method,
      path,
      body,
      contentType: body === undefined ? undefined : NDJSON,
      policy: 'mutation',
      signal,
    });
    return new Batch(res.body);
  }

  /**
   * Every request checked before anything is sent: the argument shape, the
   * `custom_id` rules (lines numbered from 1 within the call), an empty add,
   * the limits the client holds for batches, then each line as a decide request.
   */
  /** The checks `create` (or `add`, with `allowEmpty` false) runs before sending, alone. */
  async [CHECK_REQUESTS](requests: readonly BatchRequest[], allowEmpty: boolean): Promise<void> {
    await this.#prepareLines(requests, allowEmpty);
  }

  async #prepareLines(requests: readonly BatchRequest[], allowEmpty: boolean): Promise<Line[]> {
    if (!Array.isArray(requests)) throw new TypeError('requests must be an array');
    if (requests.length === 0 && !allowEmpty) throw localError(BadRequestError, 'The call holds no requests.');
    const held = this.#ctx.limits().batch;
    const batch = held !== null && typeof held === 'object' ? (held as Record<string, unknown>) : {};
    const most = typeof batch.requests_per_batch === 'number' ? batch.requests_per_batch : null;
    if (most !== null && requests.length > most) {
      throw localError(BadRequestError, `The batch would hold ${requests.length} requests. The limit is ${most}.`);
    }
    const longest = heldNumber(batch, 'max_custom_id_chars', MAX_CUSTOM_ID_CHARS);
    const seen = new Set<string>();
    const lines: Line[] = [];
    for (const [i, req] of requests.entries()) {
      const n = i + 1;
      if (req === null || typeof req !== 'object') throw new TypeError(`request ${n} must be an object`);
      const id: unknown = req.customId;
      if (id === undefined || id === null) throw localError(BadRequestError, `Line ${n} has no custom_id.`);
      if (typeof id !== 'string' || id.length < 1 || id.length > longest) {
        throw localError(BadRequestError, `Line ${n}: custom_id must be a string of 1 to ${longest} characters.`);
      }
      if (seen.has(id)) {
        const shown = JSON.stringify(id);
        throw localError(BadRequestError, `Line ${n}: custom_id ${shown.length <= 64 ? shown : `${shown.slice(0, 64)}...`} is already in the batch.`);
      }
      seen.add(id);
    }
    for (const req of requests) {
      const model = req.model || this.#ctx.model;
      const fields = {
        custom_id: req.customId,
        model,
        state: req.state === undefined || req.state === null ? '' : req.state,
        questions: req.questions,
      };
      lines.push({
        prepared: await prepare(this.#ctx.placer, fields, req.images, 'decide', this.#ctx.limits(model), req.videos),
      });
    }
    return lines;
  }

  /** Each line as JSON text with its newline; local images inline or uploaded by the threshold, per line. */
  async #placeLines(lines: Line[], signal: AbortSignal | undefined): Promise<string[]> {
    const out: string[] = [];
    for (const { prepared } of lines) {
      const wires = prepared.plan ? (await this.#ctx.placer.place(prepared.plan, signal)).wires : null;
      out.push(`${withImages(prepared.head, wires)}\n`);
    }
    return out;
  }
}
