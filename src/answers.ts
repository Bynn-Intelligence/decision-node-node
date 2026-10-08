import { parseSafety, type Safety } from './safety.js';

type RawAnswer = Record<string, unknown>;

/** The wire name some paths still use for a `truth` answer. */
const LEGACY_TRUTH = 'noul';

/** The base of every answer: its `type` and the answer object as parsed. */
export class Answer {
  /** The answer's type: `truth`, `choice`, `score`, `number`, or a newer one as sent. */
  readonly type: string;
  /** The answer object exactly as parsed from the response. */
  readonly raw: RawAnswer;

  constructor(raw: RawAnswer) {
    this.raw = raw;
    this.type = typeof raw.type === 'string' ? raw.type : '';
  }
}

/**
 * The answer to a `truth` question. `type` is always `truth`; an answer the
 * server sent under its older wire name is read the same way, and `raw` keeps
 * it as sent.
 */
export class TruthAnswer extends Answer {
  declare readonly type: 'truth';
  /** The probability that the statement is true, 0 to 1. */
  readonly truth: number;

  constructor(raw: RawAnswer) {
    super(raw);
    (this as { type: string }).type = 'truth';
    this.truth = (raw.type === 'truth' ? raw.truth : raw[LEGACY_TRUTH]) as number;
  }
}

/** The answer to a `number` question. */
export class NumberAnswer extends Answer {
  declare readonly type: 'number';
  /** The most probable value of the grid, exactly as sent (`7`, `3.5`). */
  readonly number: number;
  /** The probability-weighted mean over the grid, as sent. */
  readonly expected: number;
  /** The probability of `number`. */
  readonly confidence: number;
  /**
   * Probability by grid value, keyed by the value exactly as the server wrote
   * it (`"7"`, `"3.5"`), in the order sent. Sort numerically when you need order.
   */
  readonly probabilities: Record<string, number>;

  constructor(raw: RawAnswer) {
    super(raw);
    this.number = raw.number as number;
    this.expected = raw.expected as number;
    this.confidence = raw.confidence as number;
    this.probabilities = Object.fromEntries(Object.entries((raw.probabilities ?? {}) as Record<string, number>));
  }
}

/** The answer to a `point` question. */
export class PointAnswer extends Answer {
  declare readonly type: 'point';
  /** From the image's left edge: whole pixels, or a fraction of the width when the question asked for `normalized`. */
  readonly x: number;
  /** From the image's top edge, in the same units. */
  readonly y: number;
  /** The probability that what the instructions describe is in the image at all. */
  readonly present: number;
  /** The probability that the point lies on the thing, if it is there. */
  readonly confidence: number;
  /** The id of the image looked in. */
  readonly image: string;
  /** That image's width in pixels. */
  readonly width: number;
  /** That image's height in pixels. */
  readonly height: number;

  constructor(raw: RawAnswer) {
    super(raw);
    this.x = raw.x as number;
    this.y = raw.y as number;
    this.present = raw.present as number;
    this.confidence = raw.confidence as number;
    this.image = raw.image as string;
    this.width = raw.width as number;
    this.height = raw.height as number;
  }
}

/** The answer to a `box` question: the top-left (`x1`, `y1`) and bottom-right (`x2`, `y2`) corners. */
export class BoxAnswer extends Answer {
  declare readonly type: 'box';
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** The probability that what the instructions describe is in the image at all. */
  readonly present: number;
  /** The probability that the box overlaps the true box by at least half (IoU 0.5 or more), if the thing is there. */
  readonly confidence: number;
  /** The id of the image looked in. */
  readonly image: string;
  /** That image's width in pixels. */
  readonly width: number;
  /** That image's height in pixels. */
  readonly height: number;

  constructor(raw: RawAnswer) {
    super(raw);
    this.x1 = raw.x1 as number;
    this.y1 = raw.y1 as number;
    this.x2 = raw.x2 as number;
    this.y2 = raw.y2 as number;
    this.present = raw.present as number;
    this.confidence = raw.confidence as number;
    this.image = raw.image as string;
    this.width = raw.width as number;
    this.height = raw.height as number;
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
    case LEGACY_TRUTH:
      return isNumber(r[LEGACY_TRUTH]);
    case 'number':
      return isNumber(r.number) && isNumber(r.expected) && isNumber(r.confidence) && isNumberMap(r.probabilities);
    case 'point':
      return ['x', 'y', 'present', 'confidence', 'width', 'height'].every((k) => isNumber(r[k])) && typeof r.image === 'string';
    case 'box':
      return ['x1', 'y1', 'x2', 'y2', 'present', 'confidence', 'width', 'height'].every((k) => isNumber(r[k])) && typeof r.image === 'string';
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
    case LEGACY_TRUTH:
      return new TruthAnswer(r);
    case 'number':
      return new NumberAnswer(r);
    case 'point':
      return new PointAnswer(r);
    case 'box':
      return new BoxAnswer(r);
    case 'choice':
      return new ChoiceAnswer(r);
    default:
      return new ScoreAnswer(r);
  }
}

type OptionNames<C> = C extends readonly unknown[] ? string : string extends keyof C ? string : keyof C & string;

/** The answer type a question produces. */
export type AnswerFor<Q> = Q extends { type: 'truth' | 'noul' }
  ? TruthAnswer
  : Q extends { type: 'choice'; criteria: infer C }
    ? ChoiceAnswer<OptionNames<C>>
    : Q extends { type: 'score' }
      ? ScoreAnswer
      : Q extends { type: 'number' }
        ? NumberAnswer
        : Q extends { type: 'point' }
          ? PointAnswer
          : Q extends { type: 'box' }
            ? BoxAnswer
            : Answer;

/** Answers by question id, typed from the questions. */
export type AnswersFor<Q> = { -readonly [K in keyof Q]: AnswerFor<Q[K]> };

/** Token counts. A count the response did not carry is `null`, never 0. */
export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  /** For a request with videos: the frames the server read; `null` otherwise. */
  videoFrames: number | null;
  /** For a request with videos: the seconds of video read, as sent; `null` otherwise. */
  videoSeconds: number | null;
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
  /**
   * What the server changed when it read the request's videos (a lower rate or
   * size), as sent; empty when it sent nothing.
   */
  readonly warnings: string[];

  constructor(body: Record<string, unknown>, headers: Record<string, string>) {
    this.raw = body;
    this.model = body.model as string;
    const answers = (body.answers && typeof body.answers === 'object' ? body.answers : {}) as Record<string, unknown>;
    this.answers = Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, parseAnswer(a)])) as A;
    const usage = (body.usage && typeof body.usage === 'object' ? body.usage : {}) as Record<string, unknown>;
    this.usage = {
      inputTokens: count(usage.input_tokens),
      outputTokens: count(usage.output_tokens),
      videoFrames: count(usage.video_frames),
      videoSeconds: count(usage.video_seconds),
    };
    this.warnings = Array.isArray(body.warnings) ? body.warnings.filter((w): w is string => typeof w === 'string') : [];
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

/** Session limits of a model, as `/v1/models` publishes them. */
export interface ModelSessions {
  enabled: boolean;
  max_per_key: number;
  default_window: number;
  max_window: number;
  default_ttl_seconds: number;
  max_ttl_seconds: number;
  idle_timeout_seconds: number;
  max_frame_tokens: number;
  max_frame_images: number;
  window_tokens: number;
  max_prefix_tokens: number;
  [field: string]: unknown;
}

function field<T>(raw: Record<string, unknown>, name: string, check: (v: unknown) => boolean): T | null {
  const v = raw[name];
  return check(v) ? (v as T) : null;
}

/** One entry of `models()`. */
export class ModelInfo {
  /** The model id to send, for example `decisionnode-latest`. */
  readonly name: string;
  readonly description: string;
  /** `YYYY-MM-DD`. */
  readonly releaseDate: string;
  /** Every other field of the entry: the model's published limits, wire names as sent. */
  readonly limits: Record<string, unknown>;
  /** Grid values a `number` question answers as one question. `null` when not published. */
  readonly numberOneQuestionValues: number | null;
  /** The most values a `number` grid may hold. */
  readonly numberMaxGridValues: number | null;
  /** `[min, max]` of a `number` question that sets neither. */
  readonly numberDefaultRange: [number, number] | null;
  /** `step` of a `number` question that sets none. */
  readonly numberDefaultStep: number | null;
  /** The largest image an upload takes, in bytes. */
  readonly uploadMaxBytes: number | null;
  /** How long an upload can be named, in seconds. */
  readonly uploadTtlSeconds: number | null;
  /** The media types an upload takes. */
  readonly uploadMediaTypes: string[] | null;
  /** Session limits, as published. */
  readonly sessions: ModelSessions | null;
  /** Batch limits, wire names as published. */
  readonly batch: Record<string, unknown> | null;
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
    this.numberOneQuestionValues = field(raw, 'number_one_question_values', isNumber);
    this.numberMaxGridValues = field(raw, 'number_max_grid_values', isNumber);
    this.numberDefaultRange = field(raw, 'number_default_range', (v) => Array.isArray(v) && v.length === 2 && v.every(isNumber));
    this.numberDefaultStep = field(raw, 'number_default_step', isNumber);
    this.uploadMaxBytes = field(raw, 'upload_max_bytes', isNumber);
    this.uploadTtlSeconds = field(raw, 'upload_ttl_seconds', isNumber);
    this.uploadMediaTypes = field(raw, 'upload_media_types', (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'));
    this.sessions = field(raw, 'sessions', isObject);
    this.batch = field(raw, 'batch', isObject);
  }
}
