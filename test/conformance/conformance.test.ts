/**
 * Runs the DecisionNode conformance suite against this SDK.
 *
 * DECISIONNODE_CONFORMANCE_DIR must point at a checkout of the suite; when it
 * is unset the run fails rather than skipping. The suite's mock server is
 * started on a free port; nothing else is contacted.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, it } from 'vitest';

import {
  Answer,
  Batch,
  BatchResult,
  BatchResults,
  ChoiceAnswer,
  Decision,
  DecisionNode,
  DecisionNodeError,
  FrameError,
  Image,
  NumberAnswer,
  RefusalError,
  Reply,
  ScoreAnswer,
  Session,
  SessionClosed,
  TruthAnswer,
  UnknownAnswer,
  ValidationError,
  Video,
  VideoFrame,
  RateLimitError,
  OverloadedError,
  choice,
  number,
  score,
  truth,
  type ModelInfo,
  type Safety,
} from '../../src/index.js';
import * as sdk from '../../src/index.js';

const SUITE_DIR = process.env.DECISIONNODE_CONFORMANCE_DIR;
if (!SUITE_DIR) {
  throw new Error('DECISIONNODE_CONFORMANCE_DIR is not set: point it at a checkout of the conformance suite');
}
const SUITE = resolve(SUITE_DIR);
const PYTHON = process.env.PYTHON ?? 'python3';
const KINDS = ['requests', 'responses', 'errors', 'behaviour', 'constants'] as const;
const ENV_VARS = ['DECISIONNODE_API_KEY', 'DECISIONNODE_BASE_URL', 'DECISIONNODE_MODEL'];
const EXACT = new Set(['probabilities', 'legend', 'raw', 'entries', 'safety', 'body', 'limits']);

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

if (!existsSync(join(SUITE, 'cases'))) {
  throw new Error(`conformance suite not found at ${SUITE}: set DECISIONNODE_CONFORMANCE_DIR`);
}

function loadCases(kind: string): Json[] {
  const dir = join(SUITE, 'cases', kind);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const c = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (c.id !== f.slice(0, -5)) throw new Error(`${kind}/${f}: id does not match the file name`);
      return c;
    });
}

// ---------------------------------------------------------------- comparison

function same(a: Json, b: Json): boolean {
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return same(ka, kb) && ka.every((k) => same(a[k], b[k]));
  }
  return typeof a === typeof b && a === b;
}

function short(v: Json): string {
  const t = JSON.stringify(v);
  return t === undefined ? String(v) : t.length < 200 ? t : `${t.slice(0, 197)}...`;
}

function match(expected: Json, actual: Json, path: string): void {
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && actual && typeof actual === 'object' && !Array.isArray(actual)) {
    for (const [k, v] of Object.entries(expected)) {
      if (!(k in actual)) throw new Error(`${path}.${k}: missing (expected ${short(v)})`);
      if (EXACT.has(k)) {
        if (!same(v, actual[k])) throw new Error(`${path}.${k}: expected ${short(v)}, got ${short(actual[k])}`);
      } else {
        match(v, actual[k], `${path}.${k}`);
      }
    }
    return;
  }
  if (!same(expected, actual)) throw new Error(`${path}: expected ${short(expected)}, got ${short(actual)}`);
}

function pointer(doc: Json, ptr: string): [boolean, Json] {
  if (ptr === '') return [true, doc];
  let cur = doc;
  for (const raw of ptr.slice(1).split('/')) {
    const part = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur && typeof cur === 'object' && !Array.isArray(cur) && Object.prototype.hasOwnProperty.call(cur, part)) cur = cur[part];
    else if (Array.isArray(cur) && /^\d+$/.test(part) && Number(part) < cur.length) cur = cur[Number(part)];
    else return [false, null];
  }
  return [true, cur];
}

/** Key order of an object at a JSON pointer, read from the raw text. */
function orderedKeys(text: string, ptr: string): string[] {
  const KEYS = Symbol('keys');
  const doc = JSON.parse(text, function (this: Json, _k, v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.defineProperty(v, KEYS, { value: Object.keys(v), enumerable: false });
    }
    return v;
  });
  const [found, node] = pointer(doc, ptr);
  return found && node && typeof node === 'object' ? node[KEYS] : [];
}

const JSON_TYPES: Record<string, (v: Json) => boolean> = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number',
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
};

// ---------------------------------------------------------------- normalisation to neutral names

function normSafety(s: Safety | null): Json {
  if (s === null) return null;
  if (s.checked) return { checked: true, harm: s.harm, self_harm: s.selfHarm, flagged: s.flagged };
  return { checked: false, reason: s.reason };
}

function normAnswer(a: Answer): Json {
  if (a instanceof NumberAnswer) {
    return { kind: 'number', number: a.number, expected: a.expected, confidence: a.confidence, probabilities: a.probabilities };
  }
  if (a instanceof TruthAnswer) return { kind: 'truth', truth: a.truth };
  if (a instanceof ChoiceAnswer) return { kind: 'choice', choice: a.choice, confidence: a.confidence, probabilities: a.probabilities };
  if (a instanceof ScoreAnswer) {
    return { kind: 'score', score: a.score, confidence: a.confidence, probabilities: a.probabilities, legend: a.legend };
  }
  if (a instanceof UnknownAnswer) return { kind: 'unknown', type: a.type, raw: a.raw };
  throw new Error(`an answer of class ${a.constructor.name}`);
}

function normAnswers(answers: Record<string, Answer>): Json {
  return Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, normAnswer(v)]));
}

function normDecision(d: Decision): Json {
  return {
    model: d.model,
    request_id: d.requestId,
    latency_ms: d.latencyMs,
    usage: {
      input_tokens: d.usage.inputTokens,
      output_tokens: d.usage.outputTokens,
      video_frames: d.usage.videoFrames,
      video_seconds: d.usage.videoSeconds,
    },
    warnings: d.warnings,
    safety: normSafety(d.safety),
    answers: normAnswers(d.answers),
    raw: d.raw,
  };
}

function normError(e: DecisionNodeError): Json {
  return {
    status: e.status,
    error_type: e.errorType,
    // The error's own message; there is no second field. An empty server message is "".
    message: e.message,
    request_id: e.requestId,
    reason: e.reason,
    category: e instanceof RefusalError ? e.category : null,
    safety: e instanceof RefusalError ? normSafety(e.safety) : null,
    entries: e instanceof ValidationError ? e.entries : null,
    retry_after: e instanceof RateLimitError || e instanceof OverloadedError ? e.retryAfter : null,
  };
}

function normSession(s: Session): Json {
  return { ...s.raw, answers: normAnswers(s.answers) };
}

function normEvent(ev: unknown): Json {
  if (ev instanceof Reply) {
    const out: Json = { seq: ev.seq, answers: normAnswers(ev.answers), usage: ev.usage, latency_ms: ev.latencyMs, safety: ev.safety };
    if (ev.dropped !== null) out.dropped = ev.dropped;
    return { reply: out };
  }
  if (ev instanceof FrameError) {
    const out: Json = { seq: ev.seq, error_type: ev.errorType, message: ev.message };
    if (ev.category !== null) out.category = ev.category;
    if (ev.retryAfterMs !== null) out.retry_after_ms = ev.retryAfterMs;
    if (ev.usage !== null) out.usage = ev.usage;
    if (ev.safety !== null) out.safety = ev.safety;
    return { frame_error: out };
  }
  if (ev instanceof SessionClosed) return { closed: { code: ev.code, reopen: ev.reopen } };
  throw new Error(`unknown session event ${short(ev)}`);
}

function classNames(err: unknown): string[] {
  const names: string[] = [];
  let proto = err && Object.getPrototypeOf(err);
  while (proto && proto !== Object.prototype) {
    names.push(proto.constructor.name);
    proto = Object.getPrototypeOf(proto);
  }
  return names;
}

function checkError(spec: Json, err: unknown, path: string): void {
  const cls = spec.error ?? spec.class;
  const names = classNames(err);
  if (spec.subclass_ok) {
    if (!names.includes(cls)) throw new Error(`${path}: expected ${cls} or a subclass, got ${names[0]}: ${err}`);
  } else if (names[0] !== cls) {
    throw new Error(`${path}: expected ${cls}, got ${names[0]}: ${err}`);
  }
  if (!(err instanceof DecisionNodeError)) throw new Error(`${path}: not a DecisionNodeError`);
  const fields = { ...(spec.fields ?? {}) };
  // An expectation of no message means the empty string: a server message is never null.
  if ('message' in fields && fields.message === null) fields.message = '';
  match(fields, normError(err), `${path}.fields`);
}

// ---------------------------------------------------------------- neutral call to SDK call

function imageBytes(a: Json): Uint8Array {
  let data: Uint8Array = 'path' in a ? new Uint8Array(readFileSync(join(SUITE, a.path))) : new Uint8Array(Buffer.from(a.data_base64, 'base64'));
  if ('pad_to' in a && a.pad_to > data.length) {
    // The image's own bytes, then zero bytes: the header (type, pixels) is unchanged.
    const padded = new Uint8Array(a.pad_to);
    padded.set(data);
    data = padded;
  }
  return data;
}

function resolveRef(path: string, ctx: Json): Json {
  const [name, ...rest] = path.split('.');
  let cur = ctx[name!];
  for (const part of rest) cur = Array.isArray(cur) ? cur[Number(part)] : cur instanceof Batch ? cur.raw[part] : cur[part];
  return cur;
}

function decode(value: Json, ctx: Json = {}): Json {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1) {
      const raw = value[keys[0]!];
      switch (keys[0]) {
        case '$ref':
          return resolveRef(raw, ctx);
        case '$text':
          return String(raw.repeat).repeat(raw.times);
        case '$list':
          // count copies of item, with {i} in its strings replaced by the 0-based index
          return Array.from({ length: raw.count }, (_, i) => decode(withIndex(raw.item, i), ctx));
        case '$nest': {
          // The value inside `depth` arrays: [[[...value...]]]
          let out = decode(raw.value, ctx);
          for (let i = 0; i < raw.depth; i++) out = [out];
          return out;
        }
        case '$truth':
          return truth(raw.instructions, raw.true, raw.false);
        case '$choice':
          return choice(raw.instructions, raw.options);
        case '$score':
          return score(raw.instructions, raw.levels);
        case '$number':
          return number(raw.instructions, raw.min, raw.max, raw.step);
        case '$video': {
          const a = decode(raw, ctx);
          const options: Json = {};
          for (const k of ['fps', 'start', 'end']) if (k in a) options[k] = a[k];
          return new Video(a.id, a.frames, options);
        }
        case '$frame': {
          const a = decode(raw, ctx);
          const data =
            'path' in a
              ? new Uint8Array(readFileSync(join(SUITE, a.path)))
              : 'data_base64' in a
                ? new Uint8Array(Buffer.from(a.data_base64, 'base64'))
                : a.data_text;
          return new VideoFrame(a.t, data, a.media_type ?? undefined);
        }
        case '$image': {
          const a = decode(raw, ctx);
          if ('url' in a) return Image.fromUrl(a.id, a.url);
          if ('upload_id' in a) return Image.fromUploadId(a.id, a.upload_id, a.media_type ?? undefined);
          if ('path' in a && !('pad_to' in a)) return Image.fromPath(a.id, join(SUITE, a.path));
          // Without a media type the SDK is given the bytes alone and must detect the format.
          return Image.fromBytes(a.id, imageBytes(a), a.media_type ?? undefined);
        }
      }
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v, ctx)]));
  }
  if (Array.isArray(value)) return value.map((v) => decode(v, ctx));
  return value;
}

function withIndex(value: Json, i: number): Json {
  if (typeof value === 'string') return value.split('{i}').join(String(i));
  if (Array.isArray(value)) return value.map((v) => withIndex(v, i));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withIndex(v, i)]));
  return value;
}

function decideParams(args: Json, ctx: Json): Json {
  const p: Json = { questions: decode(args.questions, ctx) };
  if ('state' in args) p.state = decode(args.state, ctx);
  if ('images' in args) p.images = decode(args.images, ctx);
  if ('videos' in args) p.videos = decode(args.videos, ctx);
  if ('model' in args) p.model = args.model;
  return p;
}

function batchRequests(list: Json, ctx: Json): Json[] {
  const items: Json[] = Array.isArray(list) ? list : decode(list, ctx);
  return items.map(({ custom_id, ...rest }: Json) => ({ customId: custom_id, ...decideParams(rest, ctx) }));
}

function sessionParams(args: Json, ctx: Json): Json {
  const p: Json = { questions: decode(args.questions, ctx) };
  for (const [from, to] of [
    ['state', 'state'],
    ['instructions', 'instructions'],
    ['model', 'model'],
    ['window', 'window'],
    ['ttl_seconds', 'ttlSeconds'],
  ] as const) {
    if (from in args) p[to] = decode(args[from], ctx);
  }
  return p;
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CHECKED: Record<string, string> = {
  decide: 'decide',
  systemone: 'systemone',
  open_session: 'openSession',
  'batches.create': 'batches.create',
  'batches.add': 'batches.add',
};

async function invoke(client: DecisionNode, call: Json, ctx: Json = {}): Promise<Json> {
  const { method, args } = call;
  if (call.check) {
    // The same request handed to the SDK's check instead of being sent.
    const name = CHECKED[method];
    if (name === undefined) throw new Error(`no check for ${method}`);
    const request =
      method === 'open_session' ? sessionParams(args, ctx) : method.startsWith('batches.') ? batchRequests(args.requests ?? [], ctx) : decideParams(args, ctx);
    return (client.checkRequest as (m: string, r: Json) => Promise<void>)(name, request);
  }
  const common = (p: Json) => {
    if ('state' in args) p.state = decode(args.state, ctx);
    if ('images' in args) p.images = decode(args.images, ctx);
    if ('videos' in args) p.videos = decode(args.videos, ctx);
    if ('model' in args) p.model = args.model;
    return p;
  };
  switch (method) {
    case 'decide':
      return client.decide(decideParams(args, ctx));
    case 'systemone':
      return client.systemone(decideParams(args, ctx));
    case 'decide_many':
      return client.decideMany(
        args.requests.map((r: Json) => decideParams(r, ctx)),
        args.concurrency === undefined ? {} : { concurrency: args.concurrency },
      );
    case 'check':
      return client.check(common({ instructions: decode(args.instructions), ifTrue: decode(args.true), ifFalse: decode(args.false) }));
    case 'classify':
      return client.classify(common({ instructions: decode(args.instructions), options: decode(args.options) }));
    case 'score':
      return client.score(common({ instructions: decode(args.instructions), levels: decode(args.levels) }));
    case 'number':
      return client.number(common({ instructions: decode(args.instructions), min: args.min, max: args.max, step: args.step }));
    case 'gate':
      return client.gate(common({ action: decode(args.action), context: decode(args.context) }));
    case 'models':
      return client.models();
    case 'decide_raw':
      return client.decideRaw(args.body);
    case 'upload':
      return client.upload(decode(args.images, ctx));
    case 'open_session':
      return client.openSession(sessionParams(args, ctx));
    case 'supervise': {
      const replies: unknown[] = [];
      const readings: Json[] = decode(args.feed, ctx);
      const interval = args.feed_interval_ms ?? 0;
      async function* feed() {
        for (const [i, reading] of readings.entries()) {
          if (i > 0) await sleepMs(interval);
          yield reading;
        }
      }
      const closed = await client.supervise(sessionParams(args.body, ctx), feed(), (ev) => void replies.push(ev));
      return { supervised: true, replies, closed };
    }
    case 'run_batch': {
      const opts: Json = {};
      if (args.poll_interval !== undefined) opts.pollInterval = args.poll_interval * 1000;
      if (args.timeout !== undefined) opts.timeout = args.timeout * 1000;
      return client.runBatch(batchRequests(args.requests, ctx), opts);
    }
    case 'batches.create':
      return client.batches.create(batchRequests(args.requests ?? [], ctx));
    case 'batches.add':
      return client.batches.add(decode(args.batch_id, ctx), batchRequests(args.requests, ctx));
    case 'batches.finalize':
      return client.batches.finalize(decode(args.batch_id, ctx));
    case 'batches.get':
      return client.batches.get(decode(args.batch_id, ctx));
    case 'batches.cancel':
      return client.batches.cancel(decode(args.batch_id, ctx));
    case 'batches.list':
      return client.batches.list({ offset: args.offset, limit: args.limit });
    case 'batches.results':
      return client.batches.results(decode(args.batch_id, ctx));
    default:
      throw new Error(`unknown method ${method}`);
  }
}

function makeClient(
  c: Json,
  mockUrl: string,
  extra: Record<string, string>,
  sleep?: (ms: number) => Promise<void>,
): DecisionNode {
  const session = extra['x-mock-session'];
  for (const v of ENV_VARS) delete process.env[v];
  for (const [k, v] of Object.entries((c.env ?? {}) as Record<string, string>)) process.env[k] = v.replace('{mock_url}', mockUrl);
  const spec = c.client ?? {};
  const opts: Json = {};
  if (spec.api_key != null) opts.apiKey = spec.api_key;
  if (spec.model != null) opts.model = spec.model;
  if (spec.timeout != null) opts.timeout = spec.timeout * 1000;
  if (spec.max_retries != null) opts.maxRetries = spec.max_retries;
  if (spec.inline_threshold != null) opts.inlineThreshold = spec.inline_threshold;
  if (spec.upload_timeout != null) opts.uploadTimeout = spec.upload_timeout * 1000;
  if ('base_url' in spec) {
    if (spec.base_url != null) {
      opts.baseUrl = spec.base_url.replace('{mock_url}', mockUrl).replace('{mock_port}', new URL(mockUrl).port);
    }
  } else {
    opts.baseUrl = mockUrl;
  }
  opts.headers = { ...(spec.headers ?? {}), ...extra };
  if (sleep) opts.sleep = sleep;
  if (spec.clock === 'mock' && session !== undefined) {
    // The SDK's clock reads the mock's clock for this session, so a case that moves the mock's time moves the SDK's.
    opts.clock = async () => {
      const res = await fetch(`${mockUrl}/_mock/clock?session=${encodeURIComponent(session)}`);
      return (await res.json()).epoch_seconds * 1000;
    };
  }
  if (spec.http_client === 'caller_following_redirects') {
    // A fetch the caller made, set to follow redirects unless told otherwise:
    // the default of the global fetch and of most wrappers around it.
    opts.fetch = (input: string, init: RequestInit) => fetch(input, { redirect: 'follow', ...init });
  }
  return new DecisionNode(opts);
}

// ---------------------------------------------------------------- the mock

let mock: ChildProcess | undefined;
let mockUrl = '';

async function mockLog(session: string, path?: string): Promise<Json> {
  const q = new URLSearchParams({ session });
  if (path !== undefined) q.set('path', path);
  const res = await fetch(`${mockUrl}/_mock/requests?${q}`);
  const out = await res.json();
  // Pongs on a session's socket are counted for the pong cases, not as requests.
  out.pongs = out.requests.filter((r: Json) => r.method === 'PONG').length;
  out.requests = out.requests.filter((r: Json) => r.method !== 'PONG');
  return out;
}

async function mockClock(session: string, body: Json): Promise<void> {
  await fetch(`${mockUrl}/_mock/clock?session=${encodeURIComponent(session)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  mock = spawn(PYTHON, [join(SUITE, 'mock', 'server.py'), '--port', '0'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const rl = createInterface({ input: mock.stdout! });
  const line: string = await new Promise((ok, fail) => {
    rl.once('line', ok);
    mock!.once('exit', (code) => fail(new Error(`the mock exited with ${code}`)));
  });
  rl.close();
  if (!line.startsWith('listening on ')) throw new Error(`the mock did not start: ${line}`);
  mockUrl = line.slice('listening on '.length).trim();
}, 20_000);

afterAll(() => {
  mock?.kill();
  for (const v of ENV_VARS) delete process.env[v];
});

// ---------------------------------------------------------------- request records

function parseJsonl(text: string): Json[] {
  const t = text.trim();
  if (t === '') return [];
  if (t.startsWith('[')) return JSON.parse(t);
  return text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

function checkValue(check: Json, body: Json, where: string): void {
  const [found, val] = pointer(body, check.pointer);
  if (check.absent) {
    if (found) throw new Error(`${where} body${check.pointer}: must be absent, got ${short(val)}`);
    return;
  }
  if (!found) throw new Error(`${where} body${check.pointer}: missing`);
  if ('equals' in check && !same(check.equals, val)) throw new Error(`${where} body${check.pointer}: expected ${short(check.equals)}, got ${short(val)}`);
  if ('type' in check && !JSON_TYPES[check.type]!(val)) throw new Error(`${where} body${check.pointer}: expected a ${check.type}`);
  if ('pattern' in check && (typeof val !== 'string' || !new RegExp(check.pattern).test(val))) {
    throw new Error(`${where} body${check.pointer}: ${short(val)} does not match ${check.pattern}`);
  }
  if ('keys' in check && !same(check.keys, val && typeof val === 'object' ? Object.keys(val) : val)) {
    throw new Error(`${where} body${check.pointer}: keys expected ${short(check.keys)}, got ${short(Object.keys(val ?? {}))}`);
  }
}

function checkRequest(exp: Json, got: Json, where: string): void {
  if (got.method !== exp.method) throw new Error(`${where} method: expected ${exp.method}, got ${got.method} ${got.path}`);
  if ('path' in exp && got.path !== exp.path) throw new Error(`${where} path: expected ${exp.path}, got ${got.path}`);
  if ('path_pattern' in exp && !new RegExp(exp.path_pattern).test(got.path)) {
    throw new Error(`${where} path: ${got.path} does not match ${exp.path_pattern}`);
  }
  if ('query' in exp) {
    const q = Object.fromEntries(new URLSearchParams(got.query ?? ''));
    if (!same(exp.query, q)) throw new Error(`${where} query: expected ${short(exp.query)}, got ${short(q)}`);
  }
  if ('status' in exp && got.status !== exp.status) throw new Error(`${where} status: the mock answered ${got.status}, expected ${exp.status}`);
  for (const [name, value] of Object.entries(exp.headers ?? {})) {
    if (got.headers[name.toLowerCase()] !== value) throw new Error(`${where} header ${name}: expected ${short(value)}, got ${short(got.headers[name.toLowerCase()])}`);
  }
  for (const [name, pattern] of Object.entries((exp.header_patterns ?? {}) as Record<string, string>)) {
    const v = got.headers[name.toLowerCase()];
    if (v === undefined || !new RegExp(pattern).test(v)) throw new Error(`${where} header ${name}: ${short(v)} does not match ${pattern}`);
  }
  for (const name of (exp.absent_headers ?? []) as string[]) {
    if (name.toLowerCase() in got.headers) throw new Error(`${where} header ${name} must not be sent`);
  }
  if ('body_base64' in exp) {
    if (got.body_base64 !== exp.body_base64) throw new Error(`${where} body: the bytes differ`);
    return;
  }
  if ('body_sha256' in exp) {
    const digest = createHash('sha256').update(Buffer.from(got.body_base64 ?? '', 'base64')).digest('hex');
    if (digest !== exp.body_sha256) throw new Error(`${where} body: sha256 ${digest}, expected ${exp.body_sha256}`);
    return;
  }
  if ('jsonl' in exp) {
    const lines = parseJsonl(got.body_text);
    if (!same(exp.jsonl, lines)) throw new Error(`${where} body lines: expected ${short(exp.jsonl)}, got ${short(lines)}`);
    return;
  }
  if ('jsonl_count' in exp || 'jsonl_checks' in exp) {
    const lines = parseJsonl(got.body_text);
    if ('jsonl_count' in exp && lines.length !== exp.jsonl_count) throw new Error(`${where} body: expected ${exp.jsonl_count} lines, got ${lines.length}`);
    for (const check of (exp.jsonl_checks ?? []) as Json[]) {
      if (check.line >= lines.length) throw new Error(`${where} body: no line ${check.line}`);
      checkValue(check, lines[check.line], `${where} line ${check.line}`);
    }
    return;
  }
  const body = got.body_text ? JSON.parse(got.body_text) : null;
  if ('body' in exp) {
    if (!same(exp.body, body)) throw new Error(`${where} body: expected ${short(exp.body)}, got ${short(body)}`);
  } else if (!('body_checks' in exp) && got.body_text && !exp.any_body) {
    throw new Error(`${where}: expected no body, got ${short(got.body_text)}`);
  }
  for (const check of (exp.body_checks ?? []) as Json[]) checkValue(check, body, where);
  for (const ptr of (exp.ordered_keys ?? []) as string[]) {
    const want = orderedKeys(JSON.stringify(exp.body), ptr);
    const order = orderedKeys(got.body_text, ptr);
    if (!same(want, order)) throw new Error(`${where} body${ptr}: key order expected ${short(want)}, got ${short(order)}`);
  }
}

/**
 * Assigns the expected parallel entries i..j-1 to recorded requests not yet
 * taken, backtracking when a later entry finds none: never every order, since
 * a case may hold sixteen parallel PUTs.
 */
function assignParallel(expected: Json[], log: Json[], i: number, j: number, k: number, used: Set<number>, reasons: string[]): boolean {
  if (k === j) return true;
  for (let g = i; g < j; g++) {
    if (used.has(g)) continue;
    try {
      checkRequest(expected[k], log[g], `requests[${k}]`);
    } catch (err) {
      reasons.push((err as Error).message);
      continue;
    }
    used.add(g);
    if (assignParallel(expected, log, i, j, k + 1, used, reasons)) return true;
    used.delete(g);
  }
  return false;
}

function checkRequestList(expected: Json[], log: Json[]): void {
  if (log.length !== expected.length) {
    throw new Error(`expected ${expected.length} requests, the mock received ${log.length}: ${short(log.map((r) => `${r.method} ${r.path}`))}`);
  }
  let i = 0;
  while (i < expected.length) {
    if (!expected[i].parallel) {
      checkRequest(expected[i], log[i], `requests[${i}]`);
      i++;
      continue;
    }
    let j = i;
    while (j < expected.length && expected[j].parallel) j++;
    // Requests sent in parallel may arrive in any order: one assignment must hold.
    const reasons: string[] = [];
    const ok = assignParallel(expected, log, i, j, i, new Set(), reasons);
    if (!ok) throw new Error(`no order of the parallel requests matches: ${reasons[0]}`);
    i = j;
  }
}

// ---------------------------------------------------------------- the five kinds

async function runRequest(c: Json): Promise<void> {
  const session = randomUUID();
  const extra: Record<string, string> = { 'x-mock-session': session };
  if (c.mock) extra['x-mock-scenario'] = `request/${c.id}`;
  const client = makeClient(c, mockUrl, extra);
  const result = await invoke(client, c.call);
  if (result instanceof BatchResults) await result.toArray();
  await sleepMs(20);
  const log = (await mockLog(session)).requests;
  if ('request' in c.expect) {
    if (log.length !== 1) throw new Error(`expected 1 request, the mock received ${log.length}`);
    checkRequest(c.expect.request, log[0], 'request');
  } else {
    checkRequestList(c.expect.requests, log);
  }
}

async function checkResultsSpec(spec: Json, results: unknown, path: string): Promise<void> {
  if (!(results instanceof BatchResults)) throw new Error(`${path}: expected batch results, got ${short(results)}`);
  const list: BatchResult[] = await results.toArray();
  if ('batch_results' in spec) checkBatchResultList(spec.batch_results, list, `${path}.batch_results`);
  if ('count' in spec && list.length !== spec.count) throw new Error(`${path}: expected ${spec.count} results, got ${list.length}`);
  for (const sample of (spec.batch_results_sample ?? []) as Json[]) {
    const { index, ...rest } = sample;
    if (index >= list.length) throw new Error(`${path}: no result ${index} of ${list.length}`);
    checkBatchResult(rest, list[index]!, `${path}.batch_results[${index}]`);
  }
}

async function checkBatchResults(expected: Json[], results: unknown, path: string): Promise<void> {
  if (!(results instanceof BatchResults)) throw new Error(`${path}: expected batch results, got ${short(results)}`);
  checkBatchResultList(expected, await results.toArray(), path);
}

function checkBatchResultList(expected: Json[], list: BatchResult[], path: string): void {
  if (list.length !== expected.length) throw new Error(`${path}: expected ${expected.length} results, got ${list.length}`);
  expected.forEach((spec, i) => checkBatchResult(spec, list[i]!, `${path}[${i}]`));
}

function checkBatchResult(spec: Json, r: BatchResult, where: string): void {
  if ('custom_id' in spec && !same(spec.custom_id, r.customId)) throw new Error(`${where}.custom_id: expected ${spec.custom_id}, got ${r.customId}`);
  if ('status' in spec && !same(spec.status, r.status)) throw new Error(`${where}.status: expected ${spec.status}, got ${r.status}`);
  if ('headers' in spec) match(spec.headers, r.headers, `${where}.headers`);
  if ('decision' in spec && spec.decision !== null) {
    if (r.decision === null) throw new Error(`${where}: expected a decision, got none`);
    match(spec.decision, normDecision(r.decision), `${where}.decision`);
  }
  if ('error' in spec) {
    if (r.error === null) throw new Error(`${where}: expected an error value, got none`);
    checkError(spec.error, r.error, `${where}.error`);
  }
  if (spec.no_decision && r.decision !== null) throw new Error(`${where}: expected no decision`);
}

async function runResponse(c: Json): Promise<void> {
  const session = randomUUID();
  const client = makeClient({ client: { api_key: 'dn_test_conformance' } }, mockUrl, {
    'x-mock-session': session,
    'x-mock-scenario': `response/${c.id}`,
  });
  const result = await invoke(client, c.call);
  const exp = c.expect;
  if ('decision' in exp) match(exp.decision, normDecision(result), 'decision');
  else if ('answer' in exp) match(exp.answer, normAnswer(result), 'answer');
  else if ('models' in exp) {
    const got = (result as ModelInfo[]).map((m) => ({ name: m.name, description: m.description, release_date: m.releaseDate, limits: m.limits }));
    if (!same(exp.models, got)) throw new Error(`models: expected ${short(exp.models)}, got ${short(got)}`);
  } else if ('raw' in exp) {
    if (!same(exp.raw, result)) throw new Error(`raw: expected ${short(exp.raw)}, got ${short(result)}`);
  } else if ('batch' in exp) {
    match(exp.batch, (result as Batch).raw, 'batch');
  } else if ('batch_page' in exp) {
    match(exp.batch_page, result.raw, 'batch_page');
  } else if ('batch_results' in exp) {
    await checkBatchResults(exp.batch_results, result, 'batch_results');
  } else if ('session' in exp) {
    match(exp.session, normSession(result), 'session');
  } else if ('upload_ids' in exp) {
    if (!same(exp.upload_ids, result)) throw new Error(`upload_ids: expected ${short(exp.upload_ids)}, got ${short(result)}`);
  } else {
    throw new Error(`no known expectation in ${short(Object.keys(exp))}`);
  }
}

async function runError(c: Json): Promise<void> {
  const session = randomUUID();
  const catchAs: string | undefined = c.expect.error.catch_as;
  if (catchAs !== undefined && catchAs !== 'DecisionNodeError') throw new Error(`catch_as ${catchAs} is not known to this harness`);
  let caught: unknown;
  let caughtByName = false;
  try {
    const client = makeClient(c, mockUrl, { 'x-mock-session': session, 'x-mock-scenario': `error/${c.id}` });
    const result = await invoke(client, c.call);
    if (result instanceof BatchResults) await result.toArray();
  } catch (err) {
    caught = err;
    // Caught against the exported name DecisionNodeError, imported by that name above.
    if (err instanceof DecisionNodeError) caughtByName = true;
  }
  if (caught === undefined) throw new Error('no error was thrown');
  if (catchAs !== undefined && !caughtByName) throw new Error(`the error was not caught as ${catchAs}`);
  checkError(c.expect.error, caught, 'error');
  const log = (await mockLog(session)).requests;
  if (log.length !== 1) throw new Error(`expected 1 attempt with max_retries 0, got ${log.length}`);
}

function inRange(r: Json, value: number, what: string): void {
  if ('min' in r && value < r.min) throw new Error(`${what} ${value.toFixed(0)} is below ${r.min}`);
  if ('max' in r && value > r.max) throw new Error(`${what} ${value.toFixed(0)} is above ${r.max}`);
}

function isArgumentError(err: unknown): boolean {
  return (err instanceof RangeError || err instanceof TypeError) && !(err instanceof DecisionNodeError);
}

const UPLOAD_ID = /^upl_[0-9a-f]{32}$/;

async function checkOutcome(spec: Json, result: unknown, path: string): Promise<void> {
  if (result instanceof SessionClosed && !('closed' in spec)) throw new Error(`${path}: the call raised SessionClosed(${result.code})`);
  if (spec.argument_error) {
    if (!isArgumentError(result)) {
      throw new Error(`${path}: expected an argument error, got ${result instanceof Error ? `${result.name}: ${result.message}` : 'a result'}`);
    }
    return;
  }
  if (isArgumentError(result)) throw new Error(`${path}: unexpected argument error: ${(result as Error).message}`);
  if (!('result' in spec)) {
    if (!(result instanceof Error)) throw new Error(`${path}: expected ${spec.error}, got a result`);
    checkError(spec, result, path);
    return;
  }
  if (result instanceof Error) throw new Error(`${path}: expected ${spec.result}, got ${result.name}: ${result.message}`);
  const r = result as Json;
  switch (spec.result) {
    case 'decision':
      if (!(r instanceof Decision)) throw new Error(`${path}: expected a Decision, got ${short(r)}`);
      if ('decision' in spec) match(spec.decision, normDecision(r), `${path}.decision`);
      return;
    case 'answer':
      match(spec.answer ?? {}, normAnswer(r), `${path}.answer`);
      return;
    case 'batch':
      if (!(r instanceof Batch)) throw new Error(`${path}: expected a Batch, got ${short(r)}`);
      match(spec.batch ?? {}, r.raw, `${path}.batch`);
      return;
    case 'batch_page':
      match(spec.batch_page ?? {}, r.raw, `${path}.batch_page`);
      return;
    case 'batch_results':
      await checkResultsSpec(spec, r, path);
      return;
    case 'batch_run':
      match(spec.batch ?? {}, r.batch.raw, `${path}.batch`);
      await checkResultsSpec(spec, r.results, path);
      return;
    case 'checked':
      if (r !== undefined && r !== null) throw new Error(`${path}: the check returned ${short(r)}; a request that passes returns nothing`);
      return;
    case 'session':
      if (!(r instanceof Session)) throw new Error(`${path}: expected a Session, got ${short(r)}`);
      match(spec.session ?? {}, normSession(r), `${path}.session`);
      return;
    case 'upload_ids': {
      if (!Array.isArray(r) || ('count' in spec && r.length !== spec.count)) throw new Error(`${path}: expected ${spec.count} upload ids, got ${short(r)}`);
      for (const id of r) if (typeof id !== 'string' || !UPLOAD_ID.test(id)) throw new Error(`${path}: ${short(id)} is not an upload id`);
      if (spec.distinct !== undefined && (new Set(r).size === r.length) !== spec.distinct) throw new Error(`${path}: upload ids ${short(r)}`);
      return;
    }
    case 'supervised': {
      if (!r || r.supervised !== true) throw new Error(`${path}: expected supervise to return`);
      const replies = r.replies.filter((ev: unknown) => ev instanceof Reply).length;
      inRange(spec.replies ?? {}, replies, 'replies');
      if ('closed' in spec) {
        const got = r.closed === null ? null : { code: r.closed.code, reopen: r.closed.reopen };
        if (!same(spec.closed, got)) throw new Error(`${path}.closed: expected ${short(spec.closed)}, got ${short(got)}`);
      }
      return;
    }
    default:
      throw new Error(`${path}: unknown result kind ${spec.result}`);
  }
}

async function runSteps(c: Json, client: DecisionNode, session: string, events: Json[]): Promise<void> {
  const ctx: Json = {};
  const recorded = new Set<unknown>();
  for (const [i, step] of (c.steps as Json[]).entries()) {
    const where = `steps[${i}]`;
    if ('call' in step) {
      let result: unknown;
      try {
        result = await invoke(client, step.call, ctx);
      } catch (err) {
        result = err;
      }
      if ('outcome' in step) await checkOutcome(step.outcome, result, `${where}.outcome`);
      else if (result instanceof Error) throw new Error(`${where}: the call raised ${result.name}: ${result.message}`);
      if ('save_as' in step) ctx[step.save_as] = result;
    } else if ('connect' in step) {
      try {
        await (ctx[step.connect] as Session).connect();
      } catch (err) {
        if (!(err instanceof SessionClosed)) throw err;
        // A refused handshake may surface here or as the first event: both count once.
        events.push(normEvent(err));
        recorded.add(err);
      }
    } else if ('send' in step) {
      const { session: name, ...args } = step.send;
      const s = ctx[name] as Session;
      let refused: unknown;
      let checked: unknown;
      try {
        if (step.check) checked = await s.checkFrame(decode(args, ctx));
        else await s.send(decode(args, ctx));
      } catch (err) {
        // A frame that breaks a fixed rule is refused locally and nothing is sent.
        if (!('outcome' in step)) throw err;
        refused = err;
      }
      if ('outcome' in step) {
        if (refused !== undefined) await checkOutcome(step.outcome, refused, `${where}.outcome`);
        else if (step.check) await checkOutcome(step.outcome, checked, `${where}.outcome`);
        else throw new Error(`${where}: expected ${short(step.outcome)}, the frame was sent`);
      }
    } else if ('read' in step) {
      const s = ctx[step.read.session] as Session;
      let count: number | undefined = step.read.count;
      for (;;) {
        let ev: unknown;
        try {
          ev = await s.next({ timeout: step.read.timeout_ms ?? 10_000 });
        } catch {
          throw new Error(`${where}: no session event arrived in time (${events.length} read so far)`);
        }
        if (ev instanceof SessionClosed && recorded.has(ev)) break;
        events.push(normEvent(ev));
        if (ev instanceof SessionClosed) break;
        if (count !== undefined && --count === 0) break;
      }
    } else if ('end' in step) {
      try {
        await (ctx[step.end] as Session).end();
        events.push({ ended: true });
      } catch (err) {
        events.push({ end_error: { class: (err as Error).name, status: (err as DecisionNodeError).status } });
      }
    } else if ('close' in step) {
      (ctx[step.close] as Session).close();
    } else if ('mock_clock' in step) {
      await mockClock(session, step.mock_clock);
    } else if ('sleep_ms' in step) {
      await sleepMs(step.sleep_ms);
    } else {
      throw new Error(`${where}: unknown step ${short(Object.keys(step))}`);
    }
  }
}

function checkSequence(expected: Json[], log: Json[]): void {
  const got = log.map((r) => `${r.method} ${r.path}`);
  if (expected.length !== log.length) throw new Error(`request sequence: expected ${expected.length} requests, the mock received ${log.length}: ${short(got)}`);
  expected.forEach((spec, i) => {
    const rec = log[i];
    if (rec.method !== spec.method) throw new Error(`request sequence[${i}]: expected ${spec.method}, got ${got[i]}`);
    if ('path' in spec && rec.path !== spec.path) throw new Error(`request sequence[${i}]: expected ${spec.method} ${spec.path}, got ${got[i]}`);
    if ('path_pattern' in spec && !new RegExp(spec.path_pattern).test(rec.path)) throw new Error(`request sequence[${i}]: ${got[i]} does not match ${spec.path_pattern}`);
    if ('status' in spec && rec.status !== spec.status) throw new Error(`request sequence[${i}]: ${got[i]} answered ${rec.status}, expected ${spec.status}`);
    const keys = ['headers', 'header_patterns', 'absent_headers', 'body_checks', 'jsonl_count', 'jsonl_checks', 'body_base64', 'body_sha256', 'query'];
    const checks = Object.fromEntries(Object.entries(spec).filter(([k]) => keys.includes(k)));
    if (Object.keys(checks).length > 0) checkRequest({ ...checks, method: spec.method, any_body: true }, rec, `request sequence[${i}]`);
  });
}

function checkCounts(expected: Json[], log: Json[]): void {
  for (const spec of expected) {
    const n = log.filter(
      (r) =>
        r.method === spec.method &&
        (!('path' in spec) || r.path === spec.path) &&
        (!('path_pattern' in spec) || new RegExp(spec.path_pattern).test(r.path)),
    ).length;
    const what = `${spec.method} ${spec.path ?? spec.path_pattern}`;
    if ('count' in spec && n !== spec.count) throw new Error(`${what}: expected ${spec.count} requests, got ${n}`);
    inRange(Object.fromEntries(Object.entries(spec).filter(([k]) => k === 'min' || k === 'max')), n, what);
  }
}

function checkEvents(expected: Json[], events: Json[]): void {
  if (expected.length !== events.length) throw new Error(`session events: expected ${expected.length}, got ${events.length}: ${short(events)}`);
  expected.forEach((spec, i) => {
    const ev = events[i];
    if (!same(Object.keys(spec), Object.keys(ev))) throw new Error(`session events[${i}]: expected ${Object.keys(spec)[0]}, got ${short(ev)}`);
    const key = Object.keys(spec)[0]!;
    if (spec[key] && typeof spec[key] === 'object') match(spec[key], ev[key], `session events[${i}].${key}`);
    else if (!same(spec[key], ev[key])) throw new Error(`session events[${i}]: expected ${short(spec)}, got ${short(ev)}`);
  });
}

async function runBehaviour(c: Json): Promise<void> {
  const session = randomUUID();
  const extra: Record<string, string> = { 'x-mock-session': session };
  if (c.mock) extra['x-mock-scenario'] = `behaviour/${c.id}`;
  const exp = c.expect;
  // For scheduled_waits_ms the client's waits are recorded, not slept,
  // so a capped 60 s wait is checked without the test taking 60 s.
  const scheduled: number[] = [];
  const recorder = 'scheduled_waits_ms' in exp ? async (ms: number) => void scheduled.push(ms) : undefined;
  const events: Json[] = [];
  const started = performance.now();
  let result: unknown;
  try {
    // Constructing the client is inside: a bad argument fails there, before any request.
    const client = makeClient(c, mockUrl, extra, recorder);
    if ('steps' in c) {
      await runSteps(c, client, session, events);
      result = null;
    } else {
      result = await invoke(client, c.call);
    }
  } catch (err) {
    result = err;
  }
  const elapsed = performance.now() - started;
  await sleepMs(50); // let the mock finish recording dropped connections
  const info = await mockLog(session);
  const log = info.requests;
  if ('one_of' in exp) {
    // The rule allows more than one way to comply; one of them must hold whole.
    const reasons: string[] = [];
    let ok = false;
    for (const [i, alt] of (exp.one_of as Json[]).entries()) {
      try {
        if (log.length !== alt.attempts) throw new Error(`attempts: expected ${alt.attempts}, the mock received ${log.length}`);
        await checkOutcome(alt.outcome, result, 'outcome');
        ok = true;
        break;
      } catch (err) {
        reasons.push(`one_of[${i}]: ${(err as Error).message}`);
      }
    }
    if (!ok) throw new Error(reasons.join('; '));
  } else if ('attempts' in exp && log.length !== exp.attempts) {
    throw new Error(`attempts: expected ${exp.attempts}, the mock received ${log.length}: ${short(log.map((r: Json) => `${r.method} ${r.path}`))}`);
  }
  if ('request_sequence' in exp) checkSequence(exp.request_sequence, log);
  if ('request_counts' in exp) checkCounts(exp.request_counts, log);
  if ('session_events' in exp) checkEvents(exp.session_events, events);
  if ('pongs' in exp) inRange(exp.pongs, info.pongs, 'pongs');
  if ('outcome' in exp) await checkOutcome(exp.outcome, result, 'outcome');
  if ('results' in exp) {
    if (!Array.isArray(result) || result.length !== exp.results.length) {
      throw new Error(`results: expected ${exp.results.length} results, got ${result instanceof Error ? result.message : short(result)}`);
    }
    for (const [i, spec] of (exp.results as Json[]).entries()) await checkOutcome(spec, result[i], `results[${i}]`);
  }
  if ('gaps_ms' in exp) {
    const times: number[] = log.map((r: Json) => r.time);
    exp.gaps_ms.forEach((r: Json, i: number) => inRange(r, (times[i + 1]! - times[i]!) * 1000, `gap ${i + 1} (ms)`));
  }
  if ('elapsed_ms' in exp) inRange(exp.elapsed_ms, elapsed, 'elapsed (ms)');
  if ('max_in_flight' in exp) inRange(exp.max_in_flight, info.max_in_flight, 'max in flight');
  if ('scheduled_waits_ms' in exp) {
    if (scheduled.length !== exp.scheduled_waits_ms.length) {
      throw new Error(`scheduled waits: expected ${exp.scheduled_waits_ms.length}, the client scheduled ${scheduled.length}: ${short(scheduled)}`);
    }
    exp.scheduled_waits_ms.forEach((r: Json, i: number) => inRange(r, scheduled[i]!, `scheduled wait ${i + 1} (ms)`));
  }
  if ('steps' in c && result instanceof Error) throw new Error(`the steps raised ${result.name}: ${result.message}`);
  for (const path of (exp.unrequested_paths ?? []) as string[]) {
    const hits = (await mockLog('*', path)).requests;
    if (hits.length) throw new Error(`${path} was requested ${hits.length} time(s); it must not be requested at all`);
  }
}

async function runConstant(c: Json): Promise<void> {
  const name: string = c.names?.node ?? c.constant;
  if (!(name in sdk)) throw new Error(`the package exports no constant ${name}`);
  const value = (sdk as Record<string, unknown>)[name];
  if (!same(c.equals, value)) throw new Error(`${name}: expected ${short(c.equals)}, got ${short(value)}`);
}

const RUNNERS = { requests: runRequest, responses: runResponse, errors: runError, behaviour: runBehaviour, constants: runConstant };

for (const kind of KINDS) {
  describe(`conformance: ${kind}`, () => {
    for (const c of loadCases(kind)) {
      it(c.id, () => RUNNERS[kind](c), 60_000);
    }
  });
}
