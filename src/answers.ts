import { parseEvidence, type EvidenceByBooster } from './boosters.js';
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

/** One place of a `PointsAnswer`: a point and its own confidence. */
export interface PointPlace {
  x: number;
  y: number;
  /** The probability that this point is right. */
  confidence: number;
}

/** One place of a `BoxesAnswer`: a box's corners and its own confidence. */
export interface BoxPlace {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** The probability that this box is right. */
  confidence: number;
}

/** The answer to a `point` question asked with `max`: up to `max` points, one per thing found. */
export class PointsAnswer extends Answer {
  declare readonly type: 'point';
  /** How many points follow, 0 to `max`. */
  readonly count: number;
  /** The probability that at least one such thing is in the image. */
  readonly present: number;
  /** The probability that nothing was left out: that the true number is not above `max`. */
  readonly complete: number;
  /** The points, left to right by the centre (ties from the top), in the units asked for, as sent. */
  readonly points: PointPlace[];
  /** The id of the image looked in. */
  readonly image: string;
  /** That image's width in pixels. */
  readonly width: number;
  /** That image's height in pixels. */
  readonly height: number;

  constructor(raw: RawAnswer) {
    super(raw);
    this.count = raw.count as number;
    this.present = raw.present as number;
    this.complete = raw.complete as number;
    this.points = (raw.points as Array<Record<string, unknown>>).map((p) => ({
      x: p.x as number,
      y: p.y as number,
      confidence: p.confidence as number,
    }));
    this.image = raw.image as string;
    this.width = raw.width as number;
    this.height = raw.height as number;
  }
}

/** The answer to a `box` question asked with `max`: up to `max` boxes, one per thing found. */
export class BoxesAnswer extends Answer {
  declare readonly type: 'box';
  /** How many boxes follow, 0 to `max`. */
  readonly count: number;
  /** The probability that at least one such thing is in the image. */
  readonly present: number;
  /** The probability that nothing was left out: that the true number is not above `max`. */
  readonly complete: number;
  /** The boxes, left to right by the centre (ties from the top), in the units asked for, as sent. */
  readonly boxes: BoxPlace[];
  /** The id of the image looked in. */
  readonly image: string;
  /** That image's width in pixels. */
  readonly width: number;
  /** That image's height in pixels. */
  readonly height: number;

  constructor(raw: RawAnswer) {
    super(raw);
    this.count = raw.count as number;
    this.present = raw.present as number;
    this.complete = raw.complete as number;
    this.boxes = (raw.boxes as Array<Record<string, unknown>>).map((b) => ({
      x1: b.x1 as number,
      y1: b.y1 as number,
      x2: b.x2 as number,
      y2: b.y2 as number,
      confidence: b.confidence as number,
    }));
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

/** Whether a several-places answer carries every field, its list's places included, each of the right JSON type. */
function placesWellFormed(r: RawAnswer, list: 'points' | 'boxes', fields: readonly string[]): boolean {
  const places = r[list];
  return (
    typeof r.count === 'number' &&
    Number.isInteger(r.count) &&
    r.count >= 0 &&
    isNumber(r.present) &&
    isNumber(r.complete) &&
    Array.isArray(places) &&
    places.every((p) => isObject(p) && fields.every((k) => isNumber(p[k]))) &&
    typeof r.image === 'string' &&
    isNumber(r.width) &&
    isNumber(r.height)
  );
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
  // Several places, told by the answer's own list, not by the request.
  if ((r.type === 'point' || r.type === 'box') && ('points' in r || 'boxes' in r)) {
    if (r.type === 'point') {
      return 'points' in r && placesWellFormed(r, 'points', ['x', 'y', 'confidence']) ? new PointsAnswer(r) : new UnknownAnswer(r);
    }
    return 'boxes' in r && placesWellFormed(r, 'boxes', ['x1', 'y1', 'x2', 'y2', 'confidence']) ? new BoxesAnswer(r) : new UnknownAnswer(r);
  }
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
        : Q extends { type: 'point'; max: number }
          ? PointsAnswer
          : Q extends { type: 'point' }
            ? PointAnswer
            : Q extends { type: 'box'; max: number }
              ? BoxesAnswer
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
  /** For a request that named boosters: the share of `inputTokens` the readings take; `null` otherwise. */
  boosterTokens: number | null;
  /** For a request that named boosters: the booster calls billed; `null` otherwise. */
  boosters: number | null;
  /** What the answer cost, as the server sent it; `null` when it sent none. */
  cost: Cost | null;
}

/**
 * What one answer cost, in USD, read as sent. `usd` is the server's total:
 * never `modelUsd` plus `boostersUsd` computed here, which floating point
 * would not always give back.
 */
export interface Cost {
  /** What the answer cost in all. */
  usd: number | null;
  /** The model's part. */
  modelUsd: number | null;
  /** The boosters' part. */
  boostersUsd: number | null;
  /** Whether the answer was covered by the free tier. */
  freeTier: boolean | null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseCost(value: unknown): Cost | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const c = value as Record<string, unknown>;
  return {
    usd: count(c.usd),
    modelUsd: count(c.model_usd),
    boostersUsd: count(c.boosters_usd),
    freeTier: typeof c.free_tier === 'boolean' ? c.free_tier : null,
  };
}

/**
 * A fallback answer: the `decisionnode-moe` model asked for had no ready
 * worker, so Flash answered in its place. Each is named by its pinned id.
 */
export interface Fallback {
  /** The model that answered, from `x-decisionnode-fallback`; the same as `Decision.model`. */
  servedModel: string;
  /**
   * The model the request asked for, from `x-decisionnode-requested-model`:
   * the family id for a family id or an older id, the pinned id for a pinned id.
   */
  requestedModel: string | null;
}

/** The result of `decide()`. */
export class Decision<A extends Record<string, Answer> = Record<string, Answer>> {
  /** Answers by question id. */
  readonly answers: A;
  /** The resolved model version that answered; for a fine-tuned model its pinned name (`...@acme/fraud:3`). */
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
  /**
   * What each booster the request named did and read, by booster name in the
   * request's order; `null` when the request named none.
   */
  readonly evidence: EvidenceByBooster | null;
  /**
   * On a fallback answer, the model that answered and the one asked for; `null`
   * on an ordinary answer. `model` stays the model that answered.
   */
  readonly fallback: Fallback | null;

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
      boosterTokens: count(usage.booster_tokens),
      boosters: count(usage.boosters),
      cost: parseCost(usage.cost),
    };
    this.evidence = parseEvidence(body.evidence);
    this.warnings = Array.isArray(body.warnings) ? body.warnings.filter((w): w is string => typeof w === 'string') : [];
    this.requestId = headers['x-request-id'] ?? null;
    const latency = headers['x-decisionnode-latency-ms'];
    const n = latency === undefined || latency.trim() === '' ? NaN : Number(latency);
    this.latencyMs = Number.isFinite(n) ? n : null;
    this.safety = parseSafety(headers['x-decisionnode-safety']);
    const served = headers['x-decisionnode-fallback'];
    this.fallback =
      served === undefined ? null : { servedModel: served, requestedModel: headers['x-decisionnode-requested-model'] ?? null };
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
  /** The model id to send, for example `decisionnode-moe`. */
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
  /** `true` for one of your workspace's fine-tuned models; `null` on a catalogue entry. */
  readonly fineTuned: boolean | null;
  /** A fine-tuned model's base, by its pinned id; `null` on a catalogue entry. */
  readonly base: string | null;
  /** A fine-tuned model's version number (on a plain name, the version it resolves to); `null` on a catalogue entry. */
  readonly adapterVersion: number | null;
  /**
   * A fine-tuned model's state: `deployed` (it answers decisions), `ready`
   * (trained and passed its checks, not deployed), or a newer value as sent;
   * `null` on a catalogue entry.
   */
  readonly status: 'deployed' | 'ready' | (string & {}) | null;
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
    this.fineTuned = field(raw, 'fine_tuned', (v) => typeof v === 'boolean');
    this.base = field(raw, 'base', (v) => typeof v === 'string');
    this.adapterVersion = field(raw, 'adapter_version', (v) => typeof v === 'number' && Number.isInteger(v));
    this.status = field(raw, 'status', (v) => typeof v === 'string');
  }
}
