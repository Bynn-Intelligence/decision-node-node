import { parseSafety, type Safety } from './safety.js';

type RawAnswer = Record<string, unknown>;

/** The base of every answer: its `type` and the answer object as parsed. */
export class Answer {
  /** The answer's type as sent: `truth`, `choice`, `score`, or a newer one. */
  readonly type: string;
  /** The answer object exactly as parsed from the response. */
  readonly raw: RawAnswer;

  constructor(raw: RawAnswer) {
    this.raw = raw;
    this.type = typeof raw.type === 'string' ? raw.type : '';
  }
}

/** The answer to a `truth` question. */
export class TruthAnswer extends Answer {
  declare readonly type: 'truth';
  /** The probability that the statement is true, 0 to 1. */
  readonly truth: number;

  constructor(raw: RawAnswer) {
    super(raw);
    this.truth = raw.truth as number;
  }
}

/** The answer to a `choice` question. `O` is the union of the option names. */
export class ChoiceAnswer<O extends string = string> extends Answer {
  declare readonly type: 'choice';
  /** The chosen option name, byte for byte as sent. */
  readonly choice: O;
  /** 0 is no better than a uniform guess, 1 is certain. */
  readonly confidence: number;
  /** Probability by option name, exactly as sent. */
  readonly probabilities: Record<O, number>;

  constructor(raw: RawAnswer) {
    super(raw);
    this.choice = raw.choice as O;
    this.confidence = raw.confidence as number;
    this.probabilities = Object.fromEntries(Object.entries((raw.probabilities ?? {}) as Record<string, number>)) as Record<O, number>;
  }
}

/** The answer to a `score` question. */
export class ScoreAnswer extends Answer {
  declare readonly type: 'score';
  /** The expected level index, from 0 to levels minus 1. */
  readonly score: number;
  /** 1 when all probability sits on one level, lower as it spreads. */
  readonly confidence: number;
  /** Probability by level index. */
  readonly probabilities: Record<number, number>;
  /** Level index to the level exactly as sent in the request. */
  readonly legend: Record<number, unknown>;

  constructor(raw: RawAnswer) {
    super(raw);
    this.score = raw.score as number;
    this.confidence = raw.confidence as number;
    this.probabilities = indexMap(raw.probabilities) as Record<number, number>;
    this.legend = indexMap(raw.legend);
  }
}

/**
 * An answer of a type this SDK version does not know (a type added to the API
 * later), or of a known type whose fields are missing or of the wrong type.
 * Every field is in `raw`.
 */
export class UnknownAnswer extends Answer {}

function indexMap(value: unknown): Record<number, unknown> {
  const out: Record<number, unknown> = {};
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const n = Number(k);
      if (Number.isInteger(n) && String(n) === k) out[n] = v;
    }
  }
  return out;
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNumberMap(v: unknown): boolean {
  return isObject(v) && Object.values(v).every(isNumber);
}

function isIndexKeyed(v: unknown): boolean {
  return isObject(v) && Object.keys(v).every((k) => /^(0|[1-9][0-9]*)$/.test(k));
}

/** Whether an answer of a known type carries every field of that type, each of the right JSON type. */
function wellFormed(r: RawAnswer): boolean {
  switch (r.type) {
    case 'truth':
      return isNumber(r.truth);
    case 'choice':
      return typeof r.choice === 'string' && isNumber(r.confidence) && isNumberMap(r.probabilities);
    case 'score':
      return (
        isNumber(r.score) &&
        isNumber(r.confidence) &&
        isNumberMap(r.probabilities) &&
        isIndexKeyed(r.probabilities) &&
        isIndexKeyed(r.legend)
      );
    default:
      return false;
  }
}

/**
 * Parses one answer object by its `type`. An answer of an unknown type, or of
 * a known type with a field missing or of the wrong type, is an `UnknownAnswer`
 * with every field in `raw`; the decision does not fail.
 */
export function parseAnswer(raw: unknown): Answer {
  const r = (isObject(raw) ? raw : {}) as RawAnswer;
  if (!wellFormed(r)) return new UnknownAnswer(r);
  switch (r.type) {
    case 'truth':
      return new TruthAnswer(r);
    case 'choice':
      return new ChoiceAnswer(r);
    default:
      return new ScoreAnswer(r);
  }
}

type OptionNames<C> = C extends readonly unknown[] ? string : string extends keyof C ? string : keyof C & string;

/** The answer type a question produces. */
export type AnswerFor<Q> = Q extends { type: 'truth' }
  ? TruthAnswer
  : Q extends { type: 'choice'; criteria: infer C }
    ? ChoiceAnswer<OptionNames<C>>
    : Q extends { type: 'score' }
      ? ScoreAnswer
      : Answer;

/** Answers by question id, typed from the questions. */
export type AnswersFor<Q> = { -readonly [K in keyof Q]: AnswerFor<Q[K]> };

/** Token counts. A count the response did not carry is `null`, never 0. */
export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The result of `decide()`. */
export class Decision<A extends Record<string, Answer> = Record<string, Answer>> {
  /** Answers by question id. */
  readonly answers: A;
  /** The resolved model version that answered. */
  readonly model: string;
  readonly usage: Usage;
  /** The `x-request-id` response header. */
  readonly requestId: string | null;
  /** The server's own time in milliseconds, from `x-decisionnode-latency-ms`; `null` when not sent. */
  readonly latencyMs: number | null;
  /** What the safety check found; `null` on a server without the check. */
  readonly safety: Safety | null;
  /** The response body as parsed. */
  readonly raw: Record<string, unknown>;

  constructor(body: Record<string, unknown>, headers: Record<string, string>) {
    this.raw = body;
    this.model = body.model as string;
    const answers = (body.answers && typeof body.answers === 'object' ? body.answers : {}) as Record<string, unknown>;
    this.answers = Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, parseAnswer(a)])) as A;
    const usage = (body.usage && typeof body.usage === 'object' ? body.usage : {}) as Record<string, unknown>;
    this.usage = { inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens) };
    this.requestId = headers['x-request-id'] ?? null;
    const latency = headers['x-decisionnode-latency-ms'];
    const n = latency === undefined || latency.trim() === '' ? NaN : Number(latency);
    this.latencyMs = Number.isFinite(n) ? n : null;
    this.safety = parseSafety(headers['x-decisionnode-safety']);
  }

  /** The answer to one question, by id. */
  get<K extends keyof A & string>(id: K): A[K] {
    if (!Object.prototype.hasOwnProperty.call(this.answers, id)) {
      throw new RangeError(`no answer with the id '${id}'`);
    }
    return this.answers[id];
  }
}

/**
 * One result of `decideMany()`: the `Decision`, or the error that request
 * ended with.
 */
export type DecisionResult<A extends Record<string, Answer> = Record<string, Answer>> = Decision<A> | Error;

/** One entry of `models()`. */
export class ModelInfo {
  /** The model id to send, for example `decisionnode-latest`. */
  readonly name: string;
  readonly description: string;
  /** `YYYY-MM-DD`. */
  readonly releaseDate: string;
  /** Every other field of the entry: the model's published limits, wire names as sent. */
  readonly limits: Record<string, unknown>;
  /** The entry as parsed. */
  readonly raw: Record<string, unknown>;

  constructor(raw: Record<string, unknown>) {
    this.raw = raw;
    this.name = raw.name as string;
    this.description = raw.description as string;
    this.releaseDate = raw.release_date as string;
    this.limits = Object.fromEntries(
      Object.entries(raw).filter(([k]) => k !== 'name' && k !== 'description' && k !== 'release_date'),
    );
  }
}
