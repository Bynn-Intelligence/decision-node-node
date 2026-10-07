/**
 * Runs the DecisionNode conformance suite against this SDK.
 *
 * DECISIONNODE_CONFORMANCE_DIR must point at a checkout of the suite; when it
 * is unset the run fails rather than skipping. The suite's mock server is
 * started on a free port; nothing else is contacted.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  Answer,
  ChoiceAnswer,
  Decision,
  DecisionNode,
  DecisionNodeError,
  Image,
  RefusalError,
  ScoreAnswer,
  TruthAnswer,
  UnknownAnswer,
  ValidationError,
  RateLimitError,
  OverloadedError,
  choice,
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
  if (a instanceof TruthAnswer) return { kind: 'truth', truth: a.truth };
  if (a instanceof ChoiceAnswer) return { kind: 'choice', choice: a.choice, confidence: a.confidence, probabilities: a.probabilities };
  if (a instanceof ScoreAnswer) {
    return { kind: 'score', score: a.score, confidence: a.confidence, probabilities: a.probabilities, legend: a.legend };
  }
  if (a instanceof UnknownAnswer) return { kind: 'unknown', type: a.type, raw: a.raw };
  throw new Error(`an answer of class ${a.constructor.name}`);
}

function normDecision(d: Decision): Json {
  return {
    model: d.model,
    request_id: d.requestId,
    latency_ms: d.latencyMs,
    usage: { input_tokens: d.usage.inputTokens, output_tokens: d.usage.outputTokens },
    safety: normSafety(d.safety),
    answers: Object.fromEntries(Object.entries(d.answers).map(([k, v]) => [k, normAnswer(v)])),
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

function decode(value: Json): Json {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1) {
      const a = value[keys[0]!];
      switch (keys[0]) {
        case '$truth':
          return truth(a.instructions, a.true, a.false);
        case '$choice':
          return choice(a.instructions, a.options);
        case '$score':
          return score(a.instructions, a.levels);
        case '$image':
          if ('path' in a) return Image.fromPath(a.id, join(SUITE, a.path));
          if ('url' in a) return Image.fromUrl(a.id, a.url);
          return Image.fromBytes(a.id, new Uint8Array(Buffer.from(a.data_base64, 'base64')), a.media_type);
      }
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v)]));
  }
  if (Array.isArray(value)) return value.map(decode);
  return value;
}

function decideParams(args: Json): Json {
  const p: Json = { questions: decode(args.questions) };
  if ('state' in args) p.state = decode(args.state);
  if ('images' in args) p.images = decode(args.images);
  if ('model' in args) p.model = args.model;
  return p;
}

async function invoke(client: DecisionNode, call: Json): Promise<Json> {
  const { method, args } = call;
  const common = (p: Json) => {
    if ('state' in args) p.state = decode(args.state);
    if ('images' in args) p.images = decode(args.images);
    if ('model' in args) p.model = args.model;
    return p;
  };
  switch (method) {
    case 'decide':
      return client.decide(decideParams(args));
    case 'decide_many':
      return client.decideMany(
        args.requests.map(decideParams),
        args.concurrency === undefined ? {} : { concurrency: args.concurrency },
      );
    case 'check':
      return client.check(common({ instructions: decode(args.instructions), ifTrue: decode(args.true), ifFalse: decode(args.false) }));
    case 'classify':
      return client.classify(common({ instructions: decode(args.instructions), options: decode(args.options) }));
    case 'score':
      return client.score(common({ instructions: decode(args.instructions), levels: decode(args.levels) }));
    case 'gate':
      return client.gate(common({ action: decode(args.action), context: decode(args.context) }));
    case 'models':
      return client.models();
    case 'decide_raw':
      return client.decideRaw(args.body);
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
  for (const v of ENV_VARS) delete process.env[v];
  for (const [k, v] of Object.entries((c.env ?? {}) as Record<string, string>)) process.env[k] = v.replace('{mock_url}', mockUrl);
  const spec = c.client ?? {};
  const opts: Json = {};
  if (spec.api_key != null) opts.apiKey = spec.api_key;
  if (spec.model != null) opts.model = spec.model;
  if (spec.timeout != null) opts.timeout = spec.timeout * 1000;
  if (spec.max_retries != null) opts.maxRetries = spec.max_retries;
  if ('base_url' in spec) {
    if (spec.base_url != null) {
      opts.baseUrl = spec.base_url.replace('{mock_url}', mockUrl).replace('{mock_port}', new URL(mockUrl).port);
    }
  } else {
    opts.baseUrl = mockUrl;
  }
  opts.headers = { ...(spec.headers ?? {}), ...extra };
  if (sleep) opts.sleep = sleep;
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
  return res.json();
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

// ---------------------------------------------------------------- the five kinds

async function runRequest(c: Json): Promise<void> {
  const session = randomUUID();
  const client = makeClient(c, mockUrl, { 'x-mock-session': session });
  await invoke(client, c.call);
  const log = (await mockLog(session)).requests;
  if (log.length !== 1) throw new Error(`expected 1 request, the mock received ${log.length}`);
  const got = log[0];
  const exp = c.expect.request;
  expect(got.method).toBe(exp.method);
  expect(got.path).toBe(exp.path);
  for (const [name, value] of Object.entries(exp.headers ?? {})) {
    if (got.headers[name.toLowerCase()] !== value) throw new Error(`header ${name}: expected ${short(value)}, got ${short(got.headers[name.toLowerCase()])}`);
  }
  for (const [name, pattern] of Object.entries((exp.header_patterns ?? {}) as Record<string, string>)) {
    const v = got.headers[name.toLowerCase()];
    if (v === undefined || !new RegExp(pattern).test(v)) throw new Error(`header ${name}: ${short(v)} does not match ${pattern}`);
  }
  for (const name of (exp.absent_headers ?? []) as string[]) {
    if (name.toLowerCase() in got.headers) throw new Error(`header ${name} must not be sent`);
  }
  const body = got.body_text ? JSON.parse(got.body_text) : null;
  if ('body' in exp) {
    if (!same(exp.body, body)) throw new Error(`body: expected ${short(exp.body)}, got ${short(body)}`);
  } else if (!('body_checks' in exp) && got.body_text) {
    throw new Error(`expected no body, got ${short(got.body_text)}`);
  }
  for (const check of (exp.body_checks ?? []) as Json[]) {
    const [found, val] = pointer(body, check.pointer);
    if (!found) throw new Error(`body${check.pointer}: missing`);
    if ('equals' in check && !same(check.equals, val)) throw new Error(`body${check.pointer}: expected ${short(check.equals)}, got ${short(val)}`);
    if ('type' in check && !JSON_TYPES[check.type]!(val)) throw new Error(`body${check.pointer}: expected a ${check.type}`);
    if ('keys' in check && !same(check.keys, val && typeof val === 'object' ? Object.keys(val) : val)) {
      throw new Error(`body${check.pointer}: keys expected ${short(check.keys)}, got ${short(Object.keys(val ?? {}))}`);
    }
  }
  for (const ptr of (exp.ordered_keys ?? []) as string[]) {
    const want = orderedKeys(JSON.stringify(exp.body), ptr);
    const order = orderedKeys(got.body_text, ptr);
    if (!same(want, order)) throw new Error(`body${ptr}: key order expected ${short(want)}, got ${short(order)}`);
  }
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
    await invoke(client, c.call);
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

function checkOutcome(spec: Json, result: unknown, path: string): void {
  if (spec.argument_error) {
    if (!isArgumentError(result)) {
      throw new Error(`${path}: expected an argument error, got ${result instanceof Error ? `${result.name}: ${result.message}` : 'a result'}`);
    }
    return;
  }
  if (isArgumentError(result)) throw new Error(`${path}: unexpected argument error: ${(result as Error).message}`);
  if ('result' in spec) {
    if (result instanceof Error) throw new Error(`${path}: expected a decision, got ${result.name}: ${result.message}`);
    if ('decision' in spec) match(spec.decision, normDecision(result as Decision), `${path}.decision`);
  } else {
    if (!(result instanceof Error)) throw new Error(`${path}: expected ${spec.error}, got a result`);
    checkError(spec, result, path);
  }
}

async function runBehaviour(c: Json): Promise<void> {
  const session = randomUUID();
  const extra: Record<string, string> = { 'x-mock-session': session };
  if (c.mock) extra['x-mock-scenario'] = `behaviour/${c.id}`;
  const exp = c.expect;
  // For scheduled_waits_ms the wait between attempts is recorded, not slept,
  // so a capped 60 s wait is checked without the test taking 60 s.
  const scheduled: number[] = [];
  const recorder = 'scheduled_waits_ms' in exp ? async (ms: number) => void scheduled.push(ms) : undefined;
  const started = performance.now();
  let result: unknown;
  try {
    // Constructing the client is inside: a bad argument fails there, before any request.
    const client = makeClient(c, mockUrl, extra, recorder);
    result = await invoke(client, c.call);
  } catch (err) {
    result = err;
  }
  const elapsed = performance.now() - started;
  await new Promise((r) => setTimeout(r, 50)); // let the mock finish recording dropped connections
  const info = await mockLog(session);
  const log = info.requests;
  if ('one_of' in exp) {
    // The rule allows more than one way to comply; one of them must hold whole.
    const reasons: string[] = [];
    const ok = (exp.one_of as Json[]).some((alt, i) => {
      try {
        if (log.length !== alt.attempts) throw new Error(`attempts: expected ${alt.attempts}, the mock received ${log.length}`);
        checkOutcome(alt.outcome, result, 'outcome');
        return true;
      } catch (err) {
        reasons.push(`one_of[${i}]: ${(err as Error).message}`);
        return false;
      }
    });
    if (!ok) throw new Error(reasons.join('; '));
  } else if (log.length !== exp.attempts) {
    throw new Error(`attempts: expected ${exp.attempts}, the mock received ${log.length}`);
  }
  if ('outcome' in exp) checkOutcome(exp.outcome, result, 'outcome');
  if ('results' in exp) {
    if (!Array.isArray(result) || result.length !== exp.results.length) {
      throw new Error(`results: expected ${exp.results.length} results, got ${result instanceof Error ? result.message : short(result)}`);
    }
    exp.results.forEach((spec: Json, i: number) => checkOutcome(spec, result[i], `results[${i}]`));
  }
  if ('gaps_ms' in exp) {
    const times: number[] = log.map((r: Json) => r.time);
    exp.gaps_ms.forEach((r: Json, i: number) => inRange(r, (times[i + 1]! - times[i]!) * 1000, `gap ${i + 1} (ms)`));
  }
  if ('elapsed_ms' in exp) inRange(exp.elapsed_ms, elapsed, 'elapsed (ms)');
  if ('max_in_flight' in exp) inRange(exp.max_in_flight, info.max_in_flight, 'max in flight');
  if ('scheduled_waits_ms' in exp) {
    if (scheduled.length !== exp.scheduled_waits_ms.length) {
      throw new Error(`scheduled waits: expected ${exp.scheduled_waits_ms.length}, the client scheduled ${scheduled.length}`);
    }
    exp.scheduled_waits_ms.forEach((r: Json, i: number) => inRange(r, scheduled[i]!, `scheduled wait ${i + 1} (ms)`));
  }
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
      it(c.id, () => RUNNERS[kind](c), 30_000);
    }
  });
}
