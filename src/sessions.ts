/**
 * Sessions: open once with the fixed part, then stream frames over one
 * WebSocket and read a reply per frame. The newest frame wins when frames
 * arrive faster than they are answered.
 */
import { parseAnswer, type Answer } from './answers.js';
import { BadRequestError, DecisionNodeError, NotFoundError, TimeoutError, localError } from './errors.js';
import { MAX_NESTING, MAX_SEQ, nestingDepth, type HeldLimits } from './checks.js';
import { Image, type WireImage } from './image.js';
import { USER_AGENT, isLoopbackHost, serialise, type Transport } from './transport.js';
import type { ImagePlacer } from './uploads.js';

/** Close codes after which the session is gone and a new one may be opened with the same body. */
export const REOPEN_CODES: ReadonlySet<number> = new Set([1001, 1006, 1011, 4404, 4408, 4409, 4410]);
/** `1013`: the server was at its socket cap; the session is kept and the client connects to it again. */
export const TRY_AGAIN_LATER = 1013;

/** The safety check's body form: `checked`, `harm`, `self_harm`, `flagged`, or `reason` when it did not run. */
export type SafetyBody = { checked: boolean; [field: string]: unknown };

/**
 * The socket closed. A value in `replies()`, thrown by `connect()` when the
 * handshake is refused. `reopen` is true for the codes after which a new
 * session may be opened with the same body.
 */
export class SessionClosed extends Error {
  readonly code: number;
  readonly reason: string;
  readonly reopen: boolean;

  constructor(code: number, reason = '') {
    super(`the session closed with ${code}${reason ? ` (${reason})` : ''}`);
    this.code = code;
    this.reason = reason;
    this.reopen = REOPEN_CODES.has(code);
  }
}
Object.defineProperty(SessionClosed.prototype, 'name', { value: 'SessionClosed', writable: true, configurable: true });

function answersOf(raw: unknown): Record<string, Answer> {
  const answers = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, parseAnswer(a)]));
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function objectOrNull<T>(v: unknown): T | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as T) : null;
}

/** The answer to one frame. */
export class Reply {
  /** The `seq` of the frame answered. */
  readonly seq: number | null;
  /** Answers by question id, typed as in a `Decision`. */
  readonly answers: Record<string, Answer>;
  /** The `seq` of each frame this one superseded, as received; `null` when none. */
  readonly dropped: number[] | null;
  /** `input_tokens` and `output_tokens` as sent. */
  readonly usage: Record<string, unknown> | null;
  /** The worker's time for this frame. */
  readonly latencyMs: number | null;
  readonly safety: SafetyBody | null;
  readonly raw: Record<string, unknown>;

  constructor(raw: Record<string, unknown>) {
    this.raw = raw;
    this.seq = numberOrNull(raw.seq);
    this.answers = answersOf(raw.answers);
    this.dropped = Array.isArray(raw.dropped) ? (raw.dropped as number[]) : null;
    this.usage = objectOrNull(raw.usage);
    this.latencyMs = numberOrNull(raw.latency_ms);
    this.safety = objectOrNull(raw.safety);
  }
}

/** A frame the server did not answer. A value, never thrown; the session goes on. */
export class FrameError {
  readonly seq: number | null;
  readonly errorType: string | null;
  readonly message: string;
  /** `harm` or `self_harm`, on a refusal. */
  readonly category: string | null;
  /** How long to wait before the next frame, on `rate_limit_error` and `overloaded_error`. */
  readonly retryAfterMs: number | null;
  /** What a refused frame billed. */
  readonly usage: Record<string, unknown> | null;
  readonly safety: SafetyBody | null;
  readonly raw: Record<string, unknown>;

  constructor(raw: Record<string, unknown>) {
    this.raw = raw;
    const err = objectOrNull<Record<string, unknown>>(raw.error) ?? {};
    this.seq = numberOrNull(raw.seq);
    this.errorType = typeof err.error_type === 'string' ? err.error_type : null;
    this.message = typeof err.message === 'string' ? err.message : '';
    this.category = typeof err.category === 'string' ? err.category : null;
    this.retryAfterMs = numberOrNull(raw.retry_after_ms);
    this.usage = objectOrNull(raw.usage);
    this.safety = objectOrNull(raw.safety);
  }
}

export type SessionEvent = Reply | FrameError | SessionClosed;

/** One frame. At least `frame` or `image`. */
export interface Frame {
  /** The reading: text or any JSON value. Beside an image, an optional note. */
  frame?: unknown;
  /** One image: local bytes (inline when small, else uploaded) or an upload id. A URL is refused. */
  image?: Image | { media_type: string; data: string } | { upload_id: string } | null;
  /** Ask only these of the session's questions. */
  questions?: readonly string[] | null;
  /** Empty the window before this frame is answered. */
  reset?: boolean | null;
  /** The frame's number. Default: a counter from 1. */
  seq?: number | null;
}

export interface SessionParams {
  questions: Record<string, unknown>;
  state?: unknown;
  instructions?: unknown;
  model?: string | null;
  /** Frames each frame is answered with, itself included (1 to 64). */
  window?: number | null;
  /** The session's lifetime in seconds (1 to 3,600). */
  ttlSeconds?: number | null;
}

interface Socket {
  send(text: string): void;
  close(code?: number): void;
}

type WebSocketCtor = new (url: string, options: { headers: Record<string, string>; [option: string]: unknown }) => {
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  send(text: string): void;
  close(code?: number): void;
};

let wsCtor: Promise<WebSocketCtor> | undefined;

/**
 * A WebSocket that can send an `Authorization` header on the handshake: the
 * runtime's own on Node 22+, Deno and Bun, else the `ws` package on Node 20.
 * Browsers and runtimes whose WebSocket takes no headers cannot hold a session.
 */
function webSocketClass(): Promise<WebSocketCtor> {
  wsCtor ??= (async () => {
    const g = globalThis as {
      WebSocket?: unknown;
      Deno?: unknown;
      Bun?: unknown;
      process?: { versions?: { node?: string } };
    };
    if (g.Deno !== undefined || g.Bun !== undefined) {
      if (typeof g.WebSocket === 'function') return g.WebSocket as WebSocketCtor;
    } else if (g.process?.versions?.node) {
      const major = Number(g.process.versions.node.split('.')[0]);
      if (major >= 22 && typeof g.WebSocket === 'function') return g.WebSocket as WebSocketCtor;
      try {
        const name = 'ws';
        const mod = (await import(/* @vite-ignore */ name)) as { WebSocket?: WebSocketCtor; default?: WebSocketCtor };
        const ctor = mod.WebSocket ?? mod.default;
        if (ctor) return ctor;
      } catch {
        // Not installed.
      }
      throw new TypeError('sessions on this Node version need the ws package: npm install ws');
    }
    throw new TypeError(
      "this runtime's WebSocket cannot send an Authorization header, which a session needs; open sessions from a server (Node, Deno or Bun)",
    );
  })();
  wsCtor.catch(() => {
    wsCtor = undefined;
  });
  return wsCtor;
}

/**
 * On Bun, `fetch` takes its proxy from `HTTPS_PROXY` and `HTTP_PROXY` (and
 * `NO_PROXY`) but the WebSocket does not, so the session's socket is given the
 * same proxy explicitly. Elsewhere `null`: Node's WebSocket shares the global
 * dispatcher with `fetch`, and Deno applies the variables to both itself.
 */
export function bunEnvProxy(url: string, options: Record<string, unknown>): string | null {
  const g = globalThis as { Bun?: unknown; process?: { env?: Record<string, string | undefined> } };
  if (g.Bun === undefined || 'proxy' in options) return null;
  const env = g.process?.env ?? {};
  const target = new URL(url);
  if (isLoopbackHost(target.hostname)) return null;
  const secure = target.protocol === 'wss:';
  const proxy = secure ? env.https_proxy || env.HTTPS_PROXY : env.http_proxy || env.HTTP_PROXY;
  if (!proxy) return null;
  const noProxy = (env.no_proxy || env.NO_PROXY || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const host = target.hostname.toLowerCase();
  for (const rule of noProxy) {
    if (rule === '*') return null;
    const bare = rule.replace(/^\*?\./, '').replace(/:\d+$/, '');
    if (host === bare || host.endsWith(`.${bare}`)) return null;
  }
  return proxy;
}

/** What a session needs from its client. */
export interface SessionContext {
  transport: Transport;
  placer: ImagePlacer;
  /** A model's published limits, when the client holds them. */
  limits: (model?: string | null) => HeldLimits;
}

/**
 * An open session. `connect()`, then `send()` frames and read `replies()`.
 * Every field of the open response is on it; `raw` holds them as sent.
 */
export class Session {
  readonly sessionId: string;
  /** The pinned model version that answers every frame. */
  readonly model: string;
  readonly streamUrl: string;
  readonly window: number;
  readonly ttlSeconds: number;
  readonly expiresAt: string;
  readonly limits: Record<string, unknown>;
  /** The question ids, in order: the names a frame's `questions` list uses. */
  readonly questions: string[];
  readonly prefixTokens: number | null;
  readonly usage: Record<string, unknown> | null;
  /** Every question answered on the fixed part, before any frame. */
  readonly answers: Record<string, Answer>;
  readonly safety: SafetyBody | null;
  readonly raw: Record<string, unknown>;

  readonly #ctx: SessionContext;
  #socket: Socket | null = null;
  #seq = 0;
  #events: SessionEvent[] = [];
  #waiters: Array<(ev: SessionEvent) => void> = [];
  #closed: SessionClosed | null = null;
  #chain: Promise<unknown> = Promise.resolve();
  #pending = 0;

  constructor(ctx: SessionContext, raw: Record<string, unknown>) {
    this.#ctx = ctx;
    this.raw = raw;
    this.sessionId = raw.session_id as string;
    this.model = raw.model as string;
    this.streamUrl = raw.stream_url as string;
    this.window = raw.window as number;
    this.ttlSeconds = raw.ttl_seconds as number;
    this.expiresAt = raw.expires_at as string;
    this.limits = objectOrNull(raw.limits) ?? {};
    this.questions = Array.isArray(raw.questions) ? (raw.questions as string[]) : [];
    this.prefixTokens = numberOrNull(raw.prefix_tokens);
    this.usage = objectOrNull(raw.usage);
    this.answers = answersOf(raw.answers);
    this.safety = objectOrNull(raw.safety);
  }

  /** The close that ended the socket, or `null` while it is open (or not yet connected). */
  get closed(): SessionClosed | null {
    return this.#closed;
  }

  /**
   * Opens the socket, with the key and the client's headers on the handshake
   * (never in the URL). Resolves when it is open; a refused handshake rejects
   * with `SessionClosed`. After a close with `1013`, connect again to the same
   * session.
   */
  async connect(): Promise<this> {
    if (this.#socket !== null && this.#closed === null) return this;
    const transport = this.#ctx.transport;
    const key = transport.apiKey();
    const url = this.#checkedStreamUrl(transport.baseUrl);
    const Ctor = await webSocketClass();
    this.#closed = null;
    this.#events = [];
    const headers: Record<string, string> = { authorization: `Bearer ${key}`, 'user-agent': USER_AGENT, ...transport.customHeaders };
    const socketOptions: Record<string, unknown> = { ...transport.webSocketOptions };
    const envProxy = bunEnvProxy(url, socketOptions);
    if (envProxy !== null) socketOptions.proxy = envProxy;
    await new Promise<void>((resolve, reject) => {
      let opened = false;
      let ws: InstanceType<WebSocketCtor>;
      try {
        ws = new Ctor(url, { ...socketOptions, headers });
      } catch (cause) {
        // A WebSocket that reads the options as subprotocols takes no headers (older Deno, for one).
        reject(
          new TypeError("this runtime's WebSocket cannot send an Authorization header, which a session needs; update the runtime", {
            cause,
          }),
        );
        return;
      }
      ws.binaryType = 'arraybuffer';
      const timer = setTimeout(() => {
        if (opened) return;
        ws.onclose = null;
        ws.close();
        reject(new TimeoutError(`the session's socket did not open within ${transport.timeout} ms`));
      }, transport.timeout);
      ws.onopen = () => {
        opened = true;
        clearTimeout(timer);
        this.#socket = ws;
        resolve();
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        let msg: unknown;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        const raw = objectOrNull<Record<string, unknown>>(msg);
        if (raw === null) return;
        if ('error' in raw) this.#push(new FrameError(raw));
        else this.#push(new Reply(raw));
      };
      ws.onerror = () => {
        // A close event follows with the code.
      };
      ws.onclose = (ev) => {
        clearTimeout(timer);
        const closed = new SessionClosed(typeof ev.code === 'number' ? ev.code : 1006, ev.reason ?? '');
        this.#socket = null;
        this.#closed = closed;
        this.#push(closed);
        if (!opened) reject(closed);
      };
    });
    return this;
  }

  #checkedStreamUrl(baseUrl: string): string {
    let url: URL;
    try {
      url = new URL(this.streamUrl);
    } catch {
      throw new DecisionNodeError(`the session's stream URL is not a URL: ${String(this.streamUrl)}`);
    }
    const base = new URL(baseUrl);
    const secure = url.protocol === 'wss:';
    if (!secure && !(url.protocol === 'ws:' && isLoopbackHost(url.hostname))) {
      throw new DecisionNodeError(`the session's stream URL must be wss, got ${url.protocol.slice(0, -1)}`);
    }
    // The key goes only to the API's own host.
    if (url.host !== base.host) {
      throw new DecisionNodeError(`the session's stream URL is on ${url.host}, not on the API's host ${base.host}`);
    }
    return url.href;
  }

  /**
   * Sends one frame and resolves with its `seq` once it is on the socket,
   * without waiting for the reply. `seq` counts from 1 unless given. A local
   * image is checked first; it goes inline when small and is uploaded when
   * large or already uploaded. Frames go out in the order `send` is called.
   */
  send(frame: Frame = {}): Promise<number> {
    if (this.#socket === null) {
      return Promise.reject(this.#closed ?? new DecisionNodeError('the session is not connected: call connect() first'));
    }
    try {
      this.#checkFrame(frame);
    } catch (err) {
      return Promise.reject(err);
    }
    const message: Record<string, unknown> = { seq: 0 };
    if (frame.frame !== undefined && frame.frame !== null) message.frame = frame.frame;
    const image = frame.image;
    const finish = (wire: unknown): number => {
      // The seq is taken only when the frame goes out, so a refused frame uses none.
      const seq = frame.seq === undefined || frame.seq === null ? ++this.#seq : frame.seq;
      message.seq = seq;
      if (wire !== undefined) message.image = wire;
      if (frame.questions !== undefined && frame.questions !== null) message.questions = [...frame.questions];
      if (frame.reset !== undefined && frame.reset !== null) message.reset = frame.reset;
      const text = serialise(message);
      if (this.#socket === null) throw this.#closed ?? new DecisionNodeError('the session is not connected');
      this.#socket.send(text);
      return seq;
    };
    if (image === undefined || image === null) {
      if (this.#pending === 0) {
        // The hot path: nothing ahead of this frame, so it goes out now.
        try {
          return Promise.resolve(finish(undefined));
        } catch (err) {
          return Promise.reject(err);
        }
      }
      return this.#enqueue(async () => finish(undefined));
    }
    return this.#enqueue(async () => finish(await this.#frameImage(image)));
  }

  /**
   * Runs every check `send` runs before writing a frame, alone: the frame's
   * fixed rules and its image's. Throws the same error; writes nothing,
   * uploads nothing and takes no `seq`. Resolves when `send` would send it.
   */
  async checkFrame(frame: Frame = {}): Promise<void> {
    this.#checkFrame(frame);
    const image = frame.image;
    if (image instanceof Image) await this.#ctx.placer.check([image], this.#ctx.limits(this.model), false);
  }

  /**
   * A frame's fixed rules, before anything is written: `seq` from 0 to 2^53 - 1;
   * a `frame` or an `image`; a `frame` that is a non-empty string, an object or
   * an array; `questions` a non-empty list of the session's ids; `reset` a
   * boolean; the nesting limit; no image URL. A fault is the `BadRequestError`
   * the server's frame error would carry.
   */
  #checkFrame(frame: Frame): void {
    const fault = (message: string) => localError(BadRequestError, message);
    if (frame === null || typeof frame !== 'object') throw new TypeError('send takes a frame object');
    const { seq, image, questions, reset } = frame;
    const value = frame.frame;
    if (seq !== undefined && seq !== null && (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 || seq > MAX_SEQ)) {
      throw fault(`seq: must be an integer from 0 to ${MAX_SEQ}.`);
    }
    const hasFrame = value !== undefined && value !== null;
    if (!hasFrame && (image === undefined || image === null)) throw fault('frame: a frame needs a frame value or an image.');
    if (hasFrame && (value === '' || (typeof value !== 'string' && typeof value !== 'object'))) {
      throw fault('frame: must be a string, an object or an array, not empty.');
    }
    if (questions !== undefined && questions !== null) {
      if (!Array.isArray(questions)) throw new TypeError('questions must be a list of question ids');
      if (questions.length === 0) throw fault("questions: must be a non-empty list of the session's question ids.");
      const known = Array.isArray(this.raw.questions) ? (this.raw.questions as unknown[]) : null;
      for (const id of known === null ? [] : questions) {
        if (!known!.includes(id)) {
          throw fault(`questions: unknown question id ${typeof id === 'string' ? `'${id}'` : JSON.stringify(id)}`);
        }
      }
    }
    if (reset !== undefined && reset !== null && typeof reset !== 'boolean') throw fault('reset: must be true or false.');
    if (hasFrame && nestingDepth(value) + 1 > MAX_NESTING) {
      throw fault(`The frame nests more than ${MAX_NESTING} objects and arrays inside each other.`);
    }
    if (image instanceof Image && image.url !== undefined) {
      throw fault('image: a frame takes bytes or an upload, not a url.');
    }
  }

  #enqueue(job: () => Promise<number>): Promise<number> {
    this.#pending++;
    const run = this.#chain.then(job);
    this.#chain = run.catch(() => {}).finally(() => {
      this.#pending--;
    });
    return run;
  }

  async #frameImage(image: NonNullable<Frame['image']>): Promise<unknown> {
    if (!(image instanceof Image)) return image;
    const plan = await this.#ctx.placer.check([image], this.#ctx.limits(this.model), false);
    if (image.uploadId !== undefined) return { upload_id: image.uploadId };
    const { wires } = await this.#ctx.placer.place(plan!, undefined);
    const { id: _id, ...wire } = wires[0] as WireImage & { id: string };
    return wire;
  }

  /** The next reply, frame error or close. After the close, the same `SessionClosed` again. */
  next(options: { timeout?: number } = {}): Promise<SessionEvent> {
    const ev = this.#events.shift();
    if (ev !== undefined) return Promise.resolve(ev);
    if (this.#closed !== null) return Promise.resolve(this.#closed);
    return new Promise<SessionEvent>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = (e: SessionEvent) => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(e);
      };
      this.#waiters.push(waiter);
      if (options.timeout !== undefined) {
        timer = setTimeout(() => {
          this.#waiters = this.#waiters.filter((w) => w !== waiter);
          reject(new TimeoutError(`no session event within ${options.timeout} ms`));
        }, options.timeout);
      }
    });
  }

  /** Replies and frame errors as they come, ending with the `SessionClosed`. */
  async *replies(): AsyncGenerator<SessionEvent, void, undefined> {
    for (;;) {
      const ev = await this.next();
      yield ev;
      if (ev instanceof SessionClosed) return;
    }
  }

  #push(ev: SessionEvent): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(ev);
    else if (!(ev instanceof SessionClosed)) this.#events.push(ev);
    else if (this.#events.length > 0) this.#events.push(ev);
  }

  /**
   * Ends the session (`DELETE /v1/sessions/{id}`) and closes the socket. A
   * session that has already ended (`404`) counts as ended.
   */
  async end(options: { signal?: AbortSignal } = {}): Promise<void> {
    try {
      await this.#ctx.transport.request({
        method: 'DELETE',
        path: `/v1/sessions/${encodeURIComponent(this.sessionId)}`,
        signal: options.signal,
      });
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
    this.close();
  }

  /** Closes the socket (code 1000) without ending the session on the server. */
  close(code = 1000): void {
    this.#socket?.close(code);
  }
}

/** `supervise` options. */
export interface SuperviseOptions {
  /** The most sessions opened in one call. Default 10. */
  maxSessions?: number;
  /** How long to wait for the replies still owed when the feed ends, in milliseconds. Default: the client's timeout. */
  drainTimeout?: number;
  signal?: AbortSignal;
}

/**
 * Runs one feed through sessions: opens and connects, sends each reading,
 * hands every reply and frame error to `onReply`, and reopens when the
 * session ends with a reopen code (at once on 4408 and 4410, after a capped
 * backoff with jitter on the others; on 1013 it connects to the same session
 * again). Stops on any other close and returns that `SessionClosed`. When the
 * feed ends it waits for the replies still owed, ends the session, and
 * returns the last `SessionClosed` seen, or `null`.
 */
export async function supervise(
  open: () => Promise<Session>,
  feed: AsyncIterable<Frame> | Iterable<Frame>,
  onReply: (event: Reply | FrameError) => void | Promise<void>,
  sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>,
  options: SuperviseOptions & { timeout: number },
): Promise<SessionClosed | null> {
  const maxSessions = options.maxSessions ?? 10;
  let session: Session | null = null;
  let last: SessionClosed | null = null;
  let failures = 0;
  let opened = 0;
  let answered = 0;
  let owed = 0;
  let stopped: SessionClosed | null = null;
  let wake: (() => void) | null = null;
  const stopWaiter = () =>
    new Promise<void>((resolve) => {
      wake = resolve;
    });

  const pump = async (s: Session) => {
    for await (const ev of s.replies()) {
      if (ev instanceof SessionClosed) {
        last = ev;
        if (session === s) session = null;
        if (!ev.reopen && ev.code !== TRY_AGAIN_LATER) stopped = ev;
        owed = 0;
        wake?.();
        return;
      }
      owed = Math.max(0, owed - 1 - (ev instanceof Reply ? ev.dropped?.length ?? 0 : 0));
      if (ev instanceof Reply) answered++;
      await onReply(ev);
      if (owed === 0) wake?.();
    }
  };

  const iterator = (Symbol.asyncIterator in feed ? (feed as AsyncIterable<Frame>)[Symbol.asyncIterator]() : (feed as Iterable<Frame>)[Symbol.iterator]()) as
    | AsyncIterator<Frame>
    | Iterator<Frame>;
  let previous: Session | null = null;
  try {
    for (;;) {
      const nextReading = Promise.resolve(iterator.next());
      const step = await Promise.race([nextReading, stopWaiter().then(() => null)]);
      if (stopped !== null) return stopped;
      if (step === null) {
        // Woken by a reply or a close while waiting for the feed: wait on.
        const s = await nextReading;
        if (stopped !== null) return stopped;
        if (s.done) break;
        await sendReading(s.value);
        continue;
      }
      if (step.done) break;
      await sendReading(step.value);
    }
  } finally {
    if (stopped !== null) {
      // Not awaited: an async feed finishes its pending step first.
      const done = iterator.return?.();
      if (done instanceof Promise) done.catch(() => {});
    }
  }

  // The feed ended: wait for the replies still owed, then end the session.
  const deadline = Date.now() + (options.drainTimeout ?? options.timeout);
  while (session !== null && owed > 0 && Date.now() < deadline) {
    await Promise.race([stopWaiter(), new Promise((r) => setTimeout(r, Math.max(1, deadline - Date.now())))]);
  }
  const s = session as Session | null;
  if (s !== null) {
    await s.end();
  }
  return last;

  async function sendReading(reading: Frame): Promise<void> {
    while (session === null) {
      if (stopped !== null) return;
      if (opened >= maxSessions) {
        stopped = last ?? new SessionClosed(1000);
        return;
      }
      const code = (last as SessionClosed | null)?.code;
      if (code !== undefined && code !== 4408 && code !== 4410) {
        if (answered > 0) failures = 0;
        const wait = Math.min(30, 2 ** failures) * (0.5 + Math.random() * 0.5) * 1000;
        failures++;
        await sleepFn(wait, options.signal);
      }
      let s: Session;
      if (code === TRY_AGAIN_LATER && previous !== null) {
        s = previous; // the session is kept: connect to it again
      } else {
        s = await open();
        opened++;
      }
      answered = 0;
      owed = 0;
      try {
        await s.connect();
      } catch (err) {
        if (!(err instanceof SessionClosed)) throw err;
        last = err;
        if (!err.reopen && err.code !== TRY_AGAIN_LATER) {
          stopped = err;
          return;
        }
        previous = s;
        continue;
      }
      last = null;
      previous = s;
      session = s;
      void pump(s);
    }
    owed++;
    await session.send(reading);
  }
}
