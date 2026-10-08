import {
  Answer,
  ChoiceAnswer,
  Decision,
  ModelInfo,
  NumberAnswer,
  ScoreAnswer,
  TruthAnswer,
  type AnswersFor,
  type DecisionResult,
} from './answers.js';
import { Batches, type BatchRequest, type BatchRun, type RunBatchOptions } from './batches.js';
import { checkQuestions } from './checks.js';
import { BadRequestError, DecisionNodeError, ServerError } from './errors.js';
import { Image } from './image.js';
import { choice, number as numberQuestion, score as scoreQuestion, truth, type Questions } from './questions.js';
import { checkQuestionMap, prepare, withImages, type Prepared } from './request.js';
import {
  Session,
  supervise as runSupervise,
  type Frame,
  type FrameError,
  type Reply,
  type SessionClosed,
  type SessionParams,
  type SuperviseOptions,
} from './sessions.js';
import {
  Transport,
  checkBaseUrl,
  checkTls,
  readEnv,
  serialise,
  sleep,
  type FetchLike,
  type RawResponse,
  type SleepFn,
} from './transport.js';
import { DEFAULT_INLINE_THRESHOLD, ImagePlacer, STALE_UPLOAD, type ImageInput } from './uploads.js';

export { DEFAULT_INLINE_THRESHOLD };
export type { FetchLike, ImageInput, SleepFn };

export const DEFAULT_BASE_URL = 'https://api.decisionnode.com';
export const DEFAULT_MODEL = 'decisionnode-latest';
/** Milliseconds per attempt. */
export const DEFAULT_TIMEOUT = 10_000;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_CONCURRENCY = 8;

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
  /** Extra headers sent on every API request and on a session's handshake; never to the storage of an upload. */
  headers?: Record<string, string>;
  /**
   * Local images of one request (or session frame, or batch line) that total
   * under this many bytes go inline as base64; at or above it they are
   * uploaded once and named by `upload_id`. A whole number 0 or more.
   * Default `DEFAULT_INLINE_THRESHOLD` (524,288).
   */
  inlineThreshold?: number;
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
   * The wait between attempts, between upload retries, between batch polls and
   * before a session is reopened. Default: a timer. Tests can pass their own to
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

export interface NumberParams {
  state?: unknown;
  /** What to count or read. Required. */
  instructions: unknown;
  /** The lowest value (server default 0). */
  min?: number | null;
  /** The highest value the grid may reach (server default 255). */
  max?: number | null;
  /** The spacing, above 0 (server default 1). */
  step?: number | null;
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

/** The wire type `/v1/systemone` takes for a `truth` question. */
const SYSTEMONE_TRUTH = 'noul';

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

/** The questions with every `truth` written as the wire type `/v1/systemone` takes. */
function systemoneQuestions(questions: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(questions)) {
    out[id] = q && typeof q === 'object' && (q as { type?: unknown }).type === 'truth' ? { ...q, type: SYSTEMONE_TRUTH } : q;
  }
  return out;
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
  readonly inlineThreshold: number;
  /** The Batch API: `create`, `add`, `finalize`, `get`, `list`, `results`, `cancel` and `run`. */
  readonly batches: Batches;
  readonly #transport: Transport;
  readonly #placer: ImagePlacer;

  constructor(options: ClientOptions = {}) {
    // An empty string is "not given": the environment, then the default, applies.
    const apiKey = options.apiKey || readEnv('DECISIONNODE_API_KEY');
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
    const inlineThreshold = options.inlineThreshold ?? DEFAULT_INLINE_THRESHOLD;
    if (typeof inlineThreshold !== 'number' || !Number.isInteger(inlineThreshold) || inlineThreshold < 0) {
      throw new RangeError(`inlineThreshold must be a whole number 0 or more, got ${String(inlineThreshold)}`);
    }
    this.inlineThreshold = inlineThreshold;
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
    this.#transport = new Transport({
      baseUrl: this.baseUrl,
      apiKey,
      timeout,
      maxRetries,
      headers: { ...(options.headers ?? {}) },
      fetch: options.fetch ?? undefined,
      logger: options.logger,
      sleep: options.sleep ?? sleep,
    });
    this.#placer = new ImagePlacer(this.#transport, inlineThreshold);
    this.batches = new Batches({ transport: this.#transport, placer: this.#placer, model: this.model });
  }

  /** One decision: sends `POST /v1/decide` and returns typed answers. */
  async decide<const Q extends Questions>(
    params: DecideParams<Q>,
    options: RequestOptions = {},
  ): Promise<Decision<AnswersFor<Q>>> {
    const prepared = await this.#prepareDecide(params);
    const { decision } = await this.#send<AnswersFor<Q>>('/v1/decide', prepared, options.signal);
    return decision;
  }

  /**
   * One decision on `POST /v1/systemone`. The model is always sent (the
   * argument's, else the client's) and a `truth` question is written with the
   * wire type that path takes; every answer reads as on `decide`.
   */
  async systemone<const Q extends Questions>(
    params: DecideParams<Q>,
    options: RequestOptions = {},
  ): Promise<Decision<AnswersFor<Q>>> {
    const prepared = await this.#prepareDecide(params, systemoneQuestions);
    const { decision } = await this.#send<AnswersFor<Q>>('/v1/systemone', prepared, options.signal);
    return decision;
  }

  /** The local checks and the body without images, before anything is sent. */
  async #prepareDecide(
    params: DecideParams<Questions>,
    transform?: (questions: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<Prepared> {
    if (params === null || typeof params !== 'object') {
      throw new TypeError('a request must be an object with questions');
    }
    const questions = checkQuestionMap(params.questions);
    const fields = {
      model: params.model || this.model,
      state: params.state === undefined || params.state === null ? '' : params.state,
      questions: transform ? transform(questions) : questions,
    };
    return prepare(this.#placer, fields, params.images);
  }

  /**
   * Places the images and sends. A request naming an upload this client placed
   * that the API reports as stale (expired, consumed, not found, incomplete)
   * drops those uploads from the cache, uploads again and is sent once more;
   * that resend is not a retry.
   */
  async #send<A extends Record<string, Answer>>(
    path: string,
    prepared: Prepared,
    signal: AbortSignal | undefined,
  ): Promise<{ decision: Decision<A>; res: RawResponse }> {
    for (let resend = 0; ; resend++) {
      let payload = prepared.head;
      let placed: Set<string> | null = null;
      if (prepared.plan !== null) {
        const p = await this.#placer.place(prepared.plan, signal);
        payload = withImages(prepared.head, p.wires);
        placed = p.placed;
      }
      try {
        const res = await this.#transport.request({ method: 'POST', path, body: payload, signal });
        return { decision: new Decision<A>(this.#transport.parseObject(res), res.headers), res };
      } catch (err) {
        if (
          resend === 0 &&
          placed !== null &&
          placed.size > 0 &&
          err instanceof BadRequestError &&
          err.errorType !== null &&
          STALE_UPLOAD.has(err.errorType)
        ) {
          this.#placer.drop(placed);
          continue;
        }
        throw err;
      }
    }
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
    const prepared = await this.#prepareDecide(params);
    const { decision, res } = await this.#send('/v1/decide', prepared, signal);
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
   * ended with. One failure does not stop the others. Every request is checked
   * before anything is sent: a `concurrency` below 1 or a malformed request
   * throws a `RangeError` or `TypeError`, and a request the API would refuse
   * (an image, a question's limits) throws the API's own error class, for the
   * whole call. Requests with the same image bytes share one upload.
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
    const prepared: Prepared[] = [];
    for (const request of requests) prepared.push(await this.#prepareDecide(request));
    const limit = Number.isFinite(concurrency) ? Math.floor(concurrency) : requests.length;
    const results: Array<DecisionResult<AnswersFor<Q>>> = new Array(requests.length);
    let next = 0;
    const worker = async () => {
      while (next < prepared.length) {
        const i = next++;
        try {
          results[i] = (await this.#send<AnswersFor<Q>>('/v1/decide', prepared[i]!, options.signal)).decision;
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

  /** One `number` question, sent under the id `number`. */
  async number(params: NumberParams, options: RequestOptions = {}): Promise<NumberAnswer> {
    return this.#helper(
      'number',
      NumberAnswer,
      {
        state: params.state,
        questions: { number: numberQuestion(params.instructions, params.min, params.max, params.step) },
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
    const { body } = await this.#transport.json({ method: 'GET', path: '/v1/models', signal: options.signal });
    const list = Array.isArray(body.models) ? body.models : [];
    return list.map((m) => new ModelInfo((m ?? {}) as Record<string, unknown>));
  }

  /**
   * Uploads images whatever their size and returns the `upload_id` of each,
   * in order: from the cache when this client uploaded the same bytes before,
   * else from one presign and one `PUT` per image. Name an id later with
   * `Image.fromUploadId`.
   */
  async upload(images: readonly Image[], options: RequestOptions = {}): Promise<string[]> {
    if (!Array.isArray(images)) throw new TypeError('images must be an array');
    for (const img of images) {
      if (!(img instanceof Image) || !img.isLocal) {
        throw new TypeError('upload takes images of local bytes: a path, bytes or base64');
      }
    }
    const plan = await this.#placer.check(images);
    if (plan === null) return [];
    const locals = plan.slots.flatMap((s) => ('local' in s ? [s.local] : []));
    return this.#placer.upload(locals, options.signal);
  }

  /**
   * Opens a session (`POST /v1/sessions`) with its fixed part: the questions,
   * and optionally state, instructions, window and lifetime. The model is
   * always sent. A `429` `session_limit_exceeded` is never retried and raises
   * `SessionLimitError`. Then `connect()` the returned session.
   */
  async openSession(params: SessionParams, options: RequestOptions = {}): Promise<Session> {
    if (params === null || typeof params !== 'object') throw new TypeError('openSession takes an object with questions');
    const questions = checkQuestionMap(params.questions);
    checkQuestions(questions);
    const body: Record<string, unknown> = { model: params.model || this.model };
    if (params.instructions !== undefined && params.instructions !== null) body.instructions = params.instructions;
    if (params.state !== undefined && params.state !== null) body.state = params.state;
    body.questions = questions;
    if (params.window !== undefined && params.window !== null) body.window = params.window;
    if (params.ttlSeconds !== undefined && params.ttlSeconds !== null) body.ttl_seconds = params.ttlSeconds;
    const { body: raw } = await this.#transport.json({
      method: 'POST',
      path: '/v1/sessions',
      body: serialise(body),
      policy: 'session_open',
      signal: options.signal,
    });
    return new Session({ transport: this.#transport, placer: this.#placer }, raw);
  }

  /**
   * Runs a feed of frames through sessions opened with `body`, handing every
   * reply and frame error to `onReply`, reopening when a session ends with a
   * reopen code. Returns the last `SessionClosed`, or `null` when none was seen.
   */
  async supervise(
    body: SessionParams,
    feed: AsyncIterable<Frame> | Iterable<Frame>,
    onReply: (event: Reply | FrameError) => void | Promise<void>,
    options: SuperviseOptions = {},
  ): Promise<SessionClosed | null> {
    if (body === null || typeof body !== 'object') throw new TypeError('supervise takes the session body as an object');
    checkQuestions(checkQuestionMap(body.questions));
    return runSupervise(
      () => this.openSession(body, { signal: options.signal }),
      feed,
      onReply,
      this.#transport.sleep,
      { ...options, timeout: this.timeout },
    );
  }

  /**
   * A whole batch: create a draft, add the requests, finalize, poll until it
   * ends, and return it with its results. See `batches.run`.
   */
  async runBatch(requests: readonly BatchRequest[], options: RunBatchOptions = {}): Promise<BatchRun> {
    return this.batches.run(requests, options);
  }

  /**
   * Sends a body exactly as given to `POST /v1/decide` and returns the parsed
   * response body. Use it for an API field this SDK version does not know yet.
   * Nothing in the body is checked or changed.
   */
  async decideRaw<T = unknown>(body: unknown, options: RequestOptions = {}): Promise<T> {
    const res = await this.#transport.request({
      method: 'POST',
      path: '/v1/decide',
      body: serialise(body),
      signal: options.signal,
    });
    return this.#transport.parseJson(res) as T;
  }
}
