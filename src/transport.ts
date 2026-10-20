/**
 * HTTP for every call: one deadline per attempt, retries with the server's
 * wait or capped backoff, no redirects followed, typed errors. Internal: the
 * client, sessions and batches share one `Transport`.
 */
import {
  AuthenticationError,
  ConnectionError,
  DecisionNodeError,
  ServerError,
  TimeoutError,
  detailsOf,
  errorFromResponse,
  retryAfterSeconds,
} from './errors.js';
import { VERSION } from './version.js';

export const USER_AGENT = `decisionnode-node/${VERSION}`;
const MAX_BACKOFF_SECONDS = 8;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** The time in epoch milliseconds that upload URLs and cached uploads are judged by. */
export type ClockFn = () => number | Promise<number>;

/** Waits `ms` milliseconds, or rejects when `signal` aborts. */
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

/**
 * Which failures a call may retry.
 * - `default`: 408, 429, 5xx (529 included), timeouts and connection errors.
 * - `mutation`: only 429 and 529, where the API applied nothing; never after a
 *   timeout, a lost answer or another 5xx, since a repeat could apply twice.
 * - `session_open`: as `default`, except a 429 `session_limit_exceeded`.
 * - `ocr`: as `default`, except a timeout: a decision whose boosters name
 *   `ocr` is never retried after one, since the server finishes the timed-out
 *   attempt and may bill it.
 * - `idempotent`: a call that carries its own Idempotency-Key, the same on
 *   every attempt: as `default`, and also a 409 `idempotency_in_progress`,
 *   after its Retry-After.
 */
export type RetryPolicy = 'default' | 'mutation' | 'session_open' | 'ocr' | 'idempotent';

export interface RawResponse {
  /** True when the answer was a redirect the client did not follow, or one the fetch implementation followed anyway. */
  redirected?: boolean;
  status: number;
  headers: Record<string, string>;
  text: string;
  /** The body, unread, for a `stream` request that succeeded. */
  stream?: ReadableStream<Uint8Array> | null;
  /**
   * The response that owns `stream`. Hold it until the stream is read: some
   * fetch implementations (Node's) cancel the body of a response that is
   * garbage collected, and the stream then ends empty without an error.
   */
  owner?: unknown;
}

export interface RequestSpec {
  method: string;
  path: string;
  body?: string | Uint8Array;
  contentType?: string;
  policy?: RetryPolicy;
  signal?: AbortSignal;
  /** Return a successful body unread, as `stream`. */
  stream?: boolean;
  /** Milliseconds for each attempt of this request, in place of the client's. */
  timeout?: number;
  /** Headers of this request alone, the same on every attempt (an Idempotency-Key). */
  headers?: Record<string, string>;
}

export interface TransportOptions {
  baseUrl: string;
  apiKey: string | undefined;
  timeout: number;
  maxRetries: number;
  headers: Record<string, string>;
  fetch: FetchLike | undefined;
  logger: ((line: string) => void) | undefined;
  sleep: SleepFn;
  clock?: ClockFn;
  /** Milliseconds for one storage PUT attempt. */
  uploadTimeout?: number;
  /** Options merged into the session WebSocket's own (a dispatcher, an agent, TLS settings). */
  webSocketOptions?: Record<string, unknown>;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** True for `localhost`, `127.0.0.1` and `::1`, compared whole. */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

export function readEnv(name: string): string | undefined {
  try {
    const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
    if (value) return value;
  } catch {
    // No process object, or access denied.
  }
  try {
    const deno = (globalThis as { Deno?: { env?: { get(n: string): string | undefined } } }).Deno;
    const value = deno?.env?.get(name);
    if (value) return value;
  } catch {
    // Deno without env permission.
  }
  return undefined;
}

/** The base URL without a trailing slash; a `TypeError` unless it is https, or http on a loopback host. */
export function checkBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`baseUrl is not a URL: ${value}`);
  }
  // URL lowercases the scheme, so `HTTPS:` and `Http:` are checked like `https:` and `http:`.
  const protocol = url.protocol;
  if (protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new TypeError(
      `baseUrl must use https; http is accepted only for localhost, 127.0.0.1 and ::1, got ${url.host}`,
    );
  }
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new TypeError(`baseUrl must use https, got ${protocol.slice(0, -1)}`);
  }
  return value.replace(/\/+$/, '');
}

/**
 * A `TypeError` when the process turns off TLS certificate checks
 * (`NODE_TLS_REJECT_UNAUTHORIZED=0`, honoured by Node and Bun) and the base URL
 * is `https`: a key is never sent over a connection whose certificate is unchecked.
 *
 * The scheme is read from the parsed URL, which lowercases it, so `HTTPS://` is
 * checked like `https://`. Only the environment variable can be seen: a
 * process-wide dispatcher installed by the caller that turns off
 * certificate checks is not detectable, and is the caller's responsibility.
 */
export function checkTls(baseUrl: string): void {
  let protocol: string;
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    // Not reachable after checkBaseUrl; refuse rather than skip the check.
    throw new TypeError(`baseUrl is not a URL: ${baseUrl}`);
  }
  if (protocol !== 'https:') return;
  const value = readEnv('NODE_TLS_REJECT_UNAUTHORIZED');
  if (value !== undefined && value.trim() === '0') {
    throw new TypeError(
      'NODE_TLS_REJECT_UNAUTHORIZED=0 turns off TLS certificate checks; the client refuses to send a key to an https base URL without them',
    );
  }
}

/** True when `actual` (a response URL) is set and is not the URL that was requested. */
function isOtherUrl(actual: string, requested: string): boolean {
  if (!actual) return false;
  try {
    return new URL(actual).href !== new URL(requested).href;
  } catch {
    return true;
  }
}

/** Exponential backoff from 0.5 s with jitter, capped at 8 s. */
export function backoffSeconds(attempt: number): number {
  const base = Math.min(MAX_BACKOFF_SECONDS, 0.5 * 2 ** attempt);
  return base * (0.75 + Math.random() * 0.25);
}

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The value as JSON text; a `TypeError` when it cannot be serialised. */
export function serialise(body: unknown): string {
  let payload: string | undefined;
  try {
    payload = JSON.stringify(body);
  } catch (cause) {
    throw new TypeError('the request cannot be serialised as JSON', { cause });
  }
  if (payload === undefined) throw new TypeError('the request cannot be serialised as JSON');
  return payload;
}

export function isSuccess(status: number): boolean {
  return status >= 200 && status <= 299;
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** `detail.details.reason` of an error body, when it has one. */
function detailReasonOf(text: string): string | null {
  try {
    const reason = detailsOf(JSON.parse(text))?.reason;
    return typeof reason === 'string' ? reason : null;
  } catch {
    return null;
  }
}

function errorTypeOf(text: string): string | null {
  try {
    const detail = (JSON.parse(text) as { detail?: unknown })?.detail;
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      const t = (detail as { error_type?: unknown }).error_type;
      return typeof t === 'string' ? t : null;
    }
  } catch {
    // Not JSON.
  }
  return null;
}

export class Transport {
  readonly baseUrl: string;
  readonly timeout: number;
  readonly maxRetries: number;
  readonly sleep: SleepFn;
  readonly uploadTimeout: number;
  readonly webSocketOptions: Record<string, unknown>;
  readonly #clock: ClockFn;
  readonly #apiKey: string | undefined;
  /** The client's custom headers, names lower-cased. */
  readonly customHeaders: Record<string, string>;
  /** Authorization, User-Agent, Accept and the custom headers, built once. */
  readonly #baseHeaders: Record<string, string>;
  readonly #fetch: FetchLike | undefined;
  readonly #logger: ((line: string) => void) | undefined;

  constructor(options: TransportOptions) {
    this.baseUrl = options.baseUrl;
    this.timeout = options.timeout;
    this.maxRetries = options.maxRetries;
    this.sleep = options.sleep;
    this.#clock = options.clock ?? Date.now;
    this.uploadTimeout = options.uploadTimeout ?? 60_000;
    this.webSocketOptions = options.webSocketOptions ?? {};
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch;
    this.#logger = options.logger;
    this.customHeaders = {};
    for (const [k, v] of Object.entries(options.headers)) this.customHeaders[k.toLowerCase()] = v;
    this.#baseHeaders = {
      authorization: `Bearer ${this.#apiKey ?? ''}`,
      'user-agent': USER_AGENT,
      accept: 'application/json',
      ...this.customHeaders,
    };
  }

  /** The client's clock, in epoch milliseconds. */
  async now(): Promise<number> {
    return this.#clock();
  }

  /** The key, or an `AuthenticationError` when none is configured. */
  apiKey(): string {
    if (!this.#apiKey) {
      throw new AuthenticationError('no API key: pass apiKey or set DECISIONNODE_API_KEY');
    }
    return this.#apiKey;
  }

  /** A successful response, after the retries the policy allows; otherwise the typed error. */
  async request(spec: RequestSpec): Promise<RawResponse> {
    this.apiKey();
    checkTls(this.baseUrl);
    const { method, path, body, signal } = spec;
    const policy = spec.policy ?? 'default';
    const headers: Record<string, string> =
      body === undefined ? this.#baseHeaders : { ...this.#baseHeaders, 'content-type': spec.contentType ?? 'application/json' };
    // The caller's own headers win, as they always have; content-type included.
    if (body !== undefined && this.customHeaders['content-type'] !== undefined) {
      headers['content-type'] = this.customHeaders['content-type'];
    }
    const sent = spec.headers === undefined ? headers : { ...headers, ...spec.headers };

    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw abortReason(signal);
      const started = nowMs();
      let res: RawResponse;
      try {
        res = await this.send(method, this.baseUrl + path, sent, body, signal, spec.stream === true, spec.timeout ?? this.timeout);
      } catch (err) {
        if (!(err instanceof ConnectionError || err instanceof TimeoutError)) throw err;
        this.#log(method, path, err.name, null, started, attempt);
        if (policy === 'mutation' || (policy === 'ocr' && err instanceof TimeoutError) || attempt >= this.maxRetries) throw err;
        await this.sleep(backoffSeconds(attempt) * 1000, signal);
        continue;
      }
      this.#log(method, path, String(res.status), res.headers['x-request-id'] ?? null, started, attempt);
      if (res.redirected) {
        throw new DecisionNodeError('the server answered with a redirect, which is not followed', {
          status: res.status >= 300 && res.status <= 399 ? res.status : null,
          requestId: res.headers['x-request-id'] ?? null,
          headers: res.headers,
        });
      }
      if (isSuccess(res.status)) return res;
      let retryable = policy === 'mutation' ? res.status === 429 || res.status === 529 : isRetryable(res.status);
      if (policy === 'session_open' && res.status === 429 && errorTypeOf(res.text) === 'session_limit_exceeded') {
        retryable = false;
      }
      if (policy === 'idempotent' && res.status === 409 && errorTypeOf(res.text) === 'idempotency_in_progress') {
        retryable = true;
      }
      // An enrollment with no price set: a retry never cures it, and it sends no Retry-After.
      if (res.status === 529 && detailReasonOf(res.text) === 'enrollment_unpriced') retryable = false;
      // Knowledge waiting on an ingestion outage: the wait is the caller's to decide.
      if (res.status === 529 && detailReasonOf(res.text) === 'ingestion_delayed') retryable = false;
      // A key past its daily spend cap: its Retry-After runs to the cap's reset at 00:00 UTC.
      if (res.status === 429 && errorTypeOf(res.text) === 'key_spend_cap_reached') retryable = false;
      if (retryable && attempt < this.maxRetries) {
        const wait = retryAfterSeconds(res.headers) ?? backoffSeconds(attempt);
        await this.sleep(wait * 1000, signal);
        continue;
      }
      throw errorFromResponse(res.status, res.headers, res.text);
    }
  }

  /**
   * One attempt with one deadline, from sending to the last byte of the body
   * (or to the headers, for a successful `stream` request). Redirects are never
   * followed. Used for the API and, with only the storage's headers, for uploads.
   */
  async send(
    method: string,
    url: string,
    headers: Record<string, string>,
    payload: string | Uint8Array | undefined,
    signal: AbortSignal | undefined,
    stream = false,
    timeout: number = this.timeout,
  ): Promise<RawResponse> {
    const fetchImpl: FetchLike = this.#fetch ?? ((input, init) => globalThis.fetch(input, init));
    const controller = new AbortController();
    let timedOut = false;
    let rejectAttempt: (reason: unknown) => void = () => {};
    // One deadline for the whole attempt. The race also ends an attempt whose fetch ignores the signal.
    const deadline = new Promise<never>((_, reject) => {
      rejectAttempt = reject;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectAttempt(new Error('timed out'));
    }, timeout);
    const onAbort = () => {
      controller.abort(abortReason(signal!));
      rejectAttempt(abortReason(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    let handedOver = false;
    try {
      const attempt = async (): Promise<RawResponse> => {
        // Redirects are never followed, so the key never goes to another URL or
        // over plain HTTP. A 3xx comes back as itself and becomes an error.
        const response = await fetchImpl(url, {
          method,
          headers,
          body: payload as BodyInit | undefined,
          signal: controller.signal,
          redirect: 'manual',
        });
        if (response.type === 'opaqueredirect') {
          // Browsers hide a redirect's status and headers behind status 0.
          return { redirected: true, status: 0, headers: {}, text: '' };
        }
        const out: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          out[name.toLowerCase()] = value;
        });
        if (response.redirected || isOtherUrl(response.url, url)) {
          // A fetch implementation that followed a redirect despite
          // `redirect: 'manual'`, or answered from another URL: the answer is
          // refused, its body never read.
          void response.body?.cancel().catch(() => {});
          return { redirected: true, status: response.status, headers: out, text: '' };
        }
        if (stream && isSuccess(response.status)) {
          handedOver = true;
          return { status: response.status, headers: out, text: '', stream: response.body, owner: response };
        }
        const text = await response.text();
        return { status: response.status, headers: out, text };
      };
      const pending = attempt();
      // Once the deadline wins, a late failure of the abandoned attempt is expected.
      pending.catch(() => {});
      return await Promise.race([pending, deadline]);
    } catch (cause) {
      handedOver = false;
      if (signal?.aborted) throw abortReason(signal);
      if (timedOut) {
        throw new TimeoutError(`no response within ${timeout} ms`, { cause });
      }
      const detail = cause instanceof Error ? (cause.cause instanceof Error ? cause.cause.message : cause.message) : String(cause);
      throw new ConnectionError(`connection error: ${detail}`, { cause });
    } finally {
      clearTimeout(timer);
      // A streamed body keeps the caller's signal: aborting it cancels the read.
      if (!handedOver) signal?.removeEventListener('abort', onAbort);
    }
  }

  parseJson(res: RawResponse): unknown {
    try {
      return JSON.parse(res.text);
    } catch (cause) {
      throw new ServerError('the response is not JSON', {
        status: res.status,
        requestId: res.headers['x-request-id'] ?? null,
        body: res.text,
        headers: res.headers,
        cause,
      });
    }
  }

  parseObject(res: RawResponse): Record<string, unknown> {
    const body = this.parseJson(res);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new ServerError('the response is not a JSON object', {
        status: res.status,
        requestId: res.headers['x-request-id'] ?? null,
        body,
        headers: res.headers,
      });
    }
    return body as Record<string, unknown>;
  }

  /** `request` and the body as a JSON object. */
  async json(spec: RequestSpec): Promise<{ body: Record<string, unknown>; res: RawResponse }> {
    const res = await this.request(spec);
    return { body: this.parseObject(res), res };
  }

  #log(method: string, path: string, status: string, requestId: string | null, started: number, attempt: number): void {
    if (!this.#logger) return;
    const ms = Math.round(nowMs() - started);
    this.#logger(
      `decisionnode ${method} ${path} ${status} ${requestId ?? '-'} ${ms}ms${attempt > 0 ? ` (retry ${attempt})` : ''}`,
    );
  }
}
