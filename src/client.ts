import {
  Answer,
  ChoiceAnswer,
  Decision,
  ModelInfo,
  ScoreAnswer,
  TruthAnswer,
  type AnswersFor,
  type DecisionResult,
} from './answers.js';
import {
  AuthenticationError,
  ConnectionError,
  DecisionNodeError,
  ServerError,
  TimeoutError,
  errorFromResponse,
  retryAfterSeconds,
} from './errors.js';
import { Image, type WireImage } from './image.js';
import { choice, score as scoreQuestion, truth, type Questions } from './questions.js';
import { VERSION } from './version.js';

export const DEFAULT_BASE_URL = 'https://api.decisionnode.com';
export const DEFAULT_MODEL = 'decisionnode-latest';
/** Milliseconds per attempt. */
export const DEFAULT_TIMEOUT = 10_000;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_CONCURRENCY = 8;

const USER_AGENT = `decisionnode-node/${VERSION}`;
const MAX_BACKOFF_SECONDS = 8;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Waits `ms` milliseconds, or rejects when `signal` aborts. */
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface ClientOptions {
  /** Your API key. Default: `DECISIONNODE_API_KEY`. An empty string counts as not given. */
  apiKey?: string | null;
  /**
   * Default: `DECISIONNODE_BASE_URL`, else `https://api.decisionnode.com`.
   * An empty string counts as not given. Must be `https`; `http` is accepted
   * only for `localhost`, `127.0.0.1` and `::1`.
   */
  baseUrl?: string | null;
  /**
   * The model for calls that name none. Default: `DECISIONNODE_MODEL`, else
   * `decisionnode-latest`. An empty string counts as not given.
   */
  model?: string | null;
  /**
   * Milliseconds per attempt, from sending the request to the last byte of the
   * body. Above 0. Default 10000.
   */
  timeout?: number;
  /** Retries after the first attempt, a whole number 0 or more. Default 2. */
  maxRetries?: number;
  /** Extra headers sent on every request. */
  headers?: Record<string, string>;
  /**
   * A `fetch` implementation to send requests with. Default: the global `fetch`.
   *
   * A function cannot be inspected, so the SDK cannot show that it refuses
   * redirects or keeps TLS certificate checks on. It is therefore refused with a
   * `TypeError` when the client is made, unless `fetchHonoursManualRedirect` is
   * `true`. Even then it is called with `redirect: 'manual'`, and a response it
   * reports as redirected, as an opaque redirect, or from another URL is refused
   * with an error, its body never read.
   */
  fetch?: FetchLike;
  /**
   * Set to `true` to confirm that your `fetch` honours `redirect: 'manual'`
   * (it never follows a redirect) and keeps TLS certificate and hostname checks
   * on. Required with `fetch`; ignored without it.
   */
  fetchHonoursManualRedirect?: boolean;
  /**
   * The wait between attempts. Default: a timer. Tests can pass their own to
   * record the waits instead of sleeping.
   */
  sleep?: SleepFn;
  /**
   * Receives one line per attempt: method, path, status, request id and time.
   * Never the state, questions or key. Off by default.
   */
  logger?: (line: string) => void;
}

/** Per-call options. */
export interface RequestOptions {
  /** Cancels the call, retries and waits included. */
  signal?: AbortSignal;
}

export type ImageInput = Image | WireImage;

export interface DecideParams<Q extends Questions = Questions> {
  /** What is judged: a string or any JSON value. Omitted means no state. */
  state?: unknown;
  /** Questions by id. Builders or plain wire-form objects. */
  questions: Q;
  /** Up to 4 images, seen by every question. */
  images?: readonly ImageInput[] | null;
  /** Overrides the client's model for this call. An empty string counts as not given. */
  model?: string | null;
}

export interface CheckParams {
  state?: unknown;
  instructions?: unknown;
  /** What a yes means. */
  ifTrue?: unknown;
  /** What a no means. */
  ifFalse?: unknown;
  images?: readonly ImageInput[] | null;
  model?: string | null;
}

type ChoiceOptions = readonly string[] | { readonly [name: string]: unknown };
type OptionsOf<C> = C extends readonly (infer E extends string)[] ? E : keyof C & string;

export interface ClassifyParams<C extends ChoiceOptions = ChoiceOptions> {
  state?: unknown;
  instructions?: unknown;
  /** A map of option name to description, or a list of names. */
  options: C;
  images?: readonly ImageInput[] | null;
  model?: string | null;
}

export interface ScoreParams {
  state?: unknown;
  instructions?: unknown;
  /** Levels, low to high. */
  levels: readonly unknown[];
  images?: readonly ImageInput[] | null;
  model?: string | null;
}

export interface GateParams {
  /** The action about to run, for example a command or a change description. */
  action: unknown;
  /** Anything that helps judge it: environment, requester, target. */
  context?: unknown;
  images?: readonly ImageInput[] | null;
  model?: string | null;
}

export type GateAnswers = {
  risk: ScoreAnswer;
  touches_production: TruthAnswer;
  verdict: ChoiceAnswer<'allow' | 'confirm' | 'block'>;
};

export interface DecideManyOptions extends RequestOptions {
  /** Requests in flight at once, 1 or more. Default 8. */
  concurrency?: number;
}

function readEnv(name: string): string | undefined {
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

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The base URL without a trailing slash; a `TypeError` unless it is https, or http on a loopback host. */
function checkBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`baseUrl is not a URL: ${value}`);
  }
  // URL lowercases the scheme, so `HTTPS:` and `Http:` are checked like `https:` and `http:`.
  const protocol = url.protocol;
  if (protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
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
function checkTls(baseUrl: string): void {
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

function backoffSeconds(attempt: number): number {
  const base = Math.min(MAX_BACKOFF_SECONDS, 0.5 * 2 ** attempt);
  return base * (0.75 + Math.random() * 0.25);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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

/** The request body as JSON text; a `TypeError` when it cannot be serialised. */
function serialise(body: unknown): string {
  let payload: string | undefined;
  try {
    payload = JSON.stringify(body);
  } catch (cause) {
    throw new TypeError('the request cannot be serialised as JSON', { cause });
  }
  if (payload === undefined) throw new TypeError('the request cannot be serialised as JSON');
  return payload;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status <= 299;
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** The gate's three fixed questions. */
function gateQuestions() {
  return {
    risk: scoreQuestion('How much harm could this action cause if it is wrong?', [
      'none',
      'low',
      'moderate',
      'high',
      'severe',
    ]),
    touches_production: truth(
      'Does this action change a production system, production data or anything customers use?',
    ),
    verdict: choice('Should this action run as it is, wait for a person to confirm it, or be blocked?', {
      allow: 'safe to run without asking',
      confirm: 'a person should confirm it first',
      block: 'should not run',
    }),
  };
}

interface RawResponse {
  /** True when the answer was a redirect the client did not follow, or one the fetch implementation followed anyway. */
  redirected?: boolean;
  status: number;
  headers: Record<string, string>;
  text: string;
}

/**
 * The DecisionNode client. Safe to share; reuses connections through `fetch`.
 *
 * ```ts
 * const dn = new DecisionNode(); // reads DECISIONNODE_API_KEY
 * ```
 */
export class DecisionNode {
  readonly baseUrl: string;
  readonly model: string;
  readonly timeout: number;
  readonly maxRetries: number;
  readonly #apiKey: string | undefined;
  readonly #headers: Record<string, string>;
  readonly #fetch: FetchLike | undefined;
  readonly #logger: ((line: string) => void) | undefined;
  readonly #sleep: SleepFn;

  constructor(options: ClientOptions = {}) {
    // An empty string is "not given": the environment, then the default, applies.
    this.#apiKey = options.apiKey || readEnv('DECISIONNODE_API_KEY');
    this.baseUrl = checkBaseUrl(options.baseUrl || readEnv('DECISIONNODE_BASE_URL') || DEFAULT_BASE_URL);
    this.model = options.model || readEnv('DECISIONNODE_MODEL') || DEFAULT_MODEL;
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    if (typeof timeout !== 'number' || !(timeout > 0)) {
      throw new RangeError(`timeout must be above 0 milliseconds, got ${String(timeout)}`);
    }
    this.timeout = timeout;
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (typeof maxRetries !== 'number' || !Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new RangeError(`maxRetries must be a whole number 0 or more, got ${String(maxRetries)}`);
    }
    this.maxRetries = maxRetries;
    this.#headers = { ...(options.headers ?? {}) };
    if (options.fetch !== undefined && options.fetch !== null) {
      if (typeof options.fetch !== 'function') {
        throw new TypeError('fetch must be a function');
      }
      if (options.fetchHonoursManualRedirect !== true) {
        // A function cannot be inspected: it counts as one that follows redirects.
        throw new TypeError(
          "a caller's fetch cannot be shown to refuse redirects: pass fetchHonoursManualRedirect: true to confirm it honours redirect: 'manual' and keeps TLS checks on",
        );
      }
    }
    checkTls(this.baseUrl);
    this.#fetch = options.fetch ?? undefined;
    this.#logger = options.logger;
    this.#sleep = options.sleep ?? sleep;
  }

  /** One decision: sends `POST /v1/decide` and returns typed answers. */
  async decide<const Q extends Questions>(
    params: DecideParams<Q>,
    options: RequestOptions = {},
  ): Promise<Decision<AnswersFor<Q>>> {
    const payload = serialise(await this.#decideBody(params));
    const { decision } = await this.#decidePayload<AnswersFor<Q>>(payload, options.signal);
    return decision;
  }

  async #decidePayload<A extends Record<string, Answer>>(
    payload: string,
    signal: AbortSignal | undefined,
  ): Promise<{ decision: Decision<A>; res: RawResponse }> {
    const res = await this.#request('POST', '/v1/decide', payload, signal);
    return { decision: new Decision<A>(this.#parseObject(res), res.headers), res };
  }

  /**
   * One helper question. The helper promises a typed answer, so an answer that
   * is missing or malformed (an `UnknownAnswer`) is a `ServerError`, with the
   * server's `reason` from `x-decisionnode-error`.
   */
  async #helper<T extends Answer>(
    id: string,
    kind: abstract new (...args: never[]) => T,
    params: DecideParams<Questions>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const payload = serialise(await this.#decideBody(params));
    const { decision, res } = await this.#decidePayload(payload, signal);
    const answer = (decision.answers as Record<string, Answer>)[id];
    if (answer instanceof kind) return answer;
    throw new ServerError(
      answer === undefined ? `the response has no answer for ${id}` : `the answer for ${id} is malformed`,
      {
        status: res.status,
        requestId: res.headers['x-request-id'] ?? null,
        reason: res.headers['x-decisionnode-error'] ?? null,
        body: decision.raw,
        headers: res.headers,
      },
    );
  }

  /**
   * Many decisions, at most `concurrency` in flight at once. Returns one entry
   * per request in input order: the `Decision`, or the error that request
   * ended with. One failure does not stop the others. A `concurrency` below 1,
   * or any invalid request, throws a `TypeError` or `RangeError` before
   * anything is sent: every request is checked first.
   */
  async decideMany<const Q extends Questions>(
    requests: readonly DecideParams<Q>[],
    options: DecideManyOptions = {},
  ): Promise<Array<DecisionResult<AnswersFor<Q>>>> {
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    if (typeof concurrency !== 'number' || !(concurrency >= 1)) {
      throw new RangeError(`concurrency must be 1 or more, got ${String(concurrency)}`);
    }
    if (!Array.isArray(requests)) {
      throw new TypeError('requests must be an array');
    }
    // Every request is checked and serialised before any is sent.
    const payloads: string[] = [];
    for (const request of requests) payloads.push(serialise(await this.#decideBody(request)));
    const limit = Number.isFinite(concurrency) ? Math.floor(concurrency) : requests.length;
    const results: Array<DecisionResult<AnswersFor<Q>>> = new Array(requests.length);
    let next = 0;
    const worker = async () => {
      while (next < payloads.length) {
        const i = next++;
        try {
          results[i] = (await this.#decidePayload<AnswersFor<Q>>(payloads[i]!, options.signal)).decision;
        } catch (err) {
          results[i] = err instanceof Error ? err : new DecisionNodeError(String(err), { cause: err });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, requests.length) }, worker));
    return results;
  }

  /** One `truth` question, sent under the id `check`. */
  async check(params: CheckParams, options: RequestOptions = {}): Promise<TruthAnswer> {
    return this.#helper(
      'check',
      TruthAnswer,
      {
        state: params.state,
        questions: { check: truth(params.instructions, params.ifTrue, params.ifFalse) },
        images: params.images,
        model: params.model,
      },
      options.signal,
    );
  }

  /** One `choice` question, sent under the id `classify`. */
  async classify<const C extends ChoiceOptions>(
    params: ClassifyParams<C>,
    options: RequestOptions = {},
  ): Promise<ChoiceAnswer<OptionsOf<C>>> {
    const question = choice(params.instructions, params.options as { readonly [name: string]: unknown });
    const answer = await this.#helper(
      'classify',
      ChoiceAnswer,
      { state: params.state, questions: { classify: question }, images: params.images, model: params.model },
      options.signal,
    );
    return answer as unknown as ChoiceAnswer<OptionsOf<C>>;
  }

  /** One `score` question, sent under the id `score`. */
  async score(params: ScoreParams, options: RequestOptions = {}): Promise<ScoreAnswer> {
    return this.#helper(
      'score',
      ScoreAnswer,
      {
        state: params.state,
        questions: { score: scoreQuestion(params.instructions, params.levels) },
        images: params.images,
        model: params.model,
      },
      options.signal,
    );
  }

  /**
   * Judges an action before it runs: a `risk` score (none to severe), a
   * `touches_production` truth, and a `verdict` choice of allow, confirm or block.
   */
  async gate(params: GateParams, options: RequestOptions = {}): Promise<Decision<GateAnswers>> {
    const state: Record<string, unknown> = { action: params.action };
    if (params.context !== undefined && params.context !== null) state.context = params.context;
    const d = await this.decide(
      { state, questions: gateQuestions(), images: params.images, model: params.model },
      options,
    );
    return d as unknown as Decision<GateAnswers>;
  }

  /** The models your key may use, with their published limits (`GET /v1/models`). */
  async models(options: RequestOptions = {}): Promise<ModelInfo[]> {
    const res = await this.#request('GET', '/v1/models', undefined, options.signal);
    const body = this.#parseObject(res);
    const list = Array.isArray(body.models) ? body.models : [];
    return list.map((m) => new ModelInfo((m ?? {}) as Record<string, unknown>));
  }

  /**
   * Sends a body exactly as given to `POST /v1/decide` and returns the parsed
   * response body. Use it for an API field this SDK version does not know yet.
   */
  async decideRaw<T = unknown>(body: unknown, options: RequestOptions = {}): Promise<T> {
    const res = await this.#request('POST', '/v1/decide', serialise(body), options.signal);
    return this.#parseJson(res) as T;
  }

  async #decideBody(params: DecideParams<Questions>): Promise<Record<string, unknown>> {
    if (params === null || typeof params !== 'object') {
      throw new TypeError('a request must be an object with questions');
    }
    const questions = params.questions;
    if (questions === null || typeof questions !== 'object' || Array.isArray(questions) || Object.keys(questions).length === 0) {
      throw new TypeError('questions must hold at least one question');
    }
    const body: Record<string, unknown> = {
      model: params.model || this.model,
      state: params.state === undefined || params.state === null ? '' : params.state,
      questions,
    };
    if (params.images && params.images.length > 0) {
      body.images = await Promise.all(params.images.map((img) => (img instanceof Image ? img.toWire() : img)));
    }
    return body;
  }

  #parseJson(res: RawResponse): unknown {
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

  #parseObject(res: RawResponse): Record<string, unknown> {
    const body = this.#parseJson(res);
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

  async #request(method: string, path: string, payload: string | undefined, signal?: AbortSignal): Promise<RawResponse> {
    if (!this.#apiKey) {
      throw new AuthenticationError('no API key: pass apiKey or set DECISIONNODE_API_KEY');
    }
    checkTls(this.baseUrl);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#apiKey}`,
      'user-agent': USER_AGENT,
      accept: 'application/json',
    };
    if (payload !== undefined) headers['content-type'] = 'application/json';
    for (const [k, v] of Object.entries(this.#headers)) headers[k.toLowerCase()] = v;

    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw abortReason(signal);
      const started = nowMs();
      let res: RawResponse;
      try {
        res = await this.#send(method, this.baseUrl + path, headers, payload, signal);
      } catch (err) {
        if (!(err instanceof ConnectionError || err instanceof TimeoutError)) throw err;
        this.#log(method, path, err.name, null, started, attempt);
        if (attempt >= this.maxRetries) throw err;
        await this.#sleep(backoffSeconds(attempt) * 1000, signal);
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
      if (isRetryable(res.status) && attempt < this.maxRetries) {
        const wait = retryAfterSeconds(res.headers) ?? backoffSeconds(attempt);
        await this.#sleep(wait * 1000, signal);
        continue;
      }
      throw errorFromResponse(res.status, res.headers, res.text);
    }
  }

  async #send(
    method: string,
    url: string,
    headers: Record<string, string>,
    payload: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<RawResponse> {
    const fetchImpl: FetchLike = this.#fetch ?? ((input, init) => globalThis.fetch(input, init));
    const controller = new AbortController();
    let timedOut = false;
    let rejectAttempt: (reason: unknown) => void = () => {};
    // One deadline for the whole attempt, from sending to the last byte of the
    // body. The race also ends an attempt whose fetch ignores the signal.
    const deadline = new Promise<never>((_, reject) => {
      rejectAttempt = reject;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectAttempt(new Error('timed out'));
    }, this.timeout);
    const onAbort = () => {
      controller.abort(abortReason(signal!));
      rejectAttempt(abortReason(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const attempt = async (): Promise<RawResponse> => {
        // Redirects are never followed, so the key never goes to another URL or
        // over plain HTTP. A 3xx comes back as itself and becomes an error.
        const response = await fetchImpl(url, {
          method,
          headers,
          body: payload,
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
        const text = await response.text();
        return { status: response.status, headers: out, text };
      };
      const pending = attempt();
      // Once the deadline wins, a late failure of the abandoned attempt is expected.
      pending.catch(() => {});
      return await Promise.race([pending, deadline]);
    } catch (cause) {
      if (signal?.aborted) throw abortReason(signal);
      if (timedOut) {
        throw new TimeoutError(`no response within ${this.timeout} ms`, { cause });
      }
      const detail = cause instanceof Error ? (cause.cause instanceof Error ? cause.cause.message : cause.message) : String(cause);
      throw new ConnectionError(`connection error: ${detail}`, { cause });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  #log(method: string, path: string, status: string, requestId: string | null, started: number, attempt: number): void {
    if (!this.#logger) return;
    const ms = Math.round(nowMs() - started);
    this.#logger(
      `decisionnode ${method} ${path} ${status} ${requestId ?? '-'} ${ms}ms${attempt > 0 ? ` (retry ${attempt})` : ''}`,
    );
  }
}
