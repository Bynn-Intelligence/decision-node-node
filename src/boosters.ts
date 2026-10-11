/**
 * Boosters: specialist models that read a request's images before the
 * decision. Their readings are added to what the model sees and come back in
 * the response's `evidence`. The SDK checks nothing about boosters locally:
 * which boosters exist and which a workspace may use is the server's to say.
 */

/**
 * A booster's name. The names this version knows are offered for completion;
 * any other string is sent as given, so a booster added later works without
 * a new SDK.
 */
export type BoosterName = 'age' | 'ai_generated' | 'face_detection' | 'wanted_person' | 'ocr' | (string & {});

/**
 * A booster's own settings, sent as given in `options`; the API checks them.
 * Other keys are sent as given too, for settings a later booster adds.
 */
export interface BoosterSettings {
  /** `ocr`: what to read, an instruction of at most 500 characters ("the invoice total and date"). */
  prompt?: string;
  /** `wanted_person`: its match threshold. */
  threshold?: number;
  [setting: string]: unknown;
}

/** A booster as the API takes it. */
export interface WireBooster {
  name: string;
  images?: readonly string[];
  require?: boolean;
  options?: BoosterSettings;
}

/** A booster's settings; each is left out of the request when not given. */
export interface BoosterOptions {
  /** The ids of the request's images the booster reads. Left out: every image. */
  images?: readonly string[] | null;
  /**
   * `true`: a booster that fails or does not answer in time fails the request
   * with the 529 `booster_unavailable`. Left out or `false`: the decision runs
   * without its reading and `evidence` says why.
   */
  require?: boolean | null;
  /** The booster's own settings. */
  options?: BoosterSettings | null;
}

/**
 * One booster of a request, with its settings.
 *
 * ```ts
 * new Booster('ai_generated', { images: ['c3d4'], require: true });
 * ```
 *
 * A name alone (`'age'`) is the same as `new Booster('age')`.
 */
export class Booster {
  readonly name: BoosterName;
  readonly images: readonly string[] | undefined;
  readonly require: boolean | undefined;
  readonly options: BoosterSettings | undefined;

  constructor(name: BoosterName, options: BoosterOptions = {}) {
    this.name = name;
    this.images = options.images ?? undefined;
    this.require = options.require ?? undefined;
    this.options = options.options ?? undefined;
  }

  /**
   * The booster as it is sent: its name alone when no setting is given, so a
   * list of such boosters is the plain list of names; else the object form,
   * each setting only when given.
   */
  toJSON(): BoosterName | WireBooster {
    if (this.images === undefined && this.require === undefined && this.options === undefined) return this.name;
    const out: WireBooster = { name: this.name };
    if (this.images !== undefined) out.images = this.images;
    if (this.require !== undefined) out.require = this.require;
    if (this.options !== undefined) out.options = this.options;
    return out;
  }
}

/** A booster in a request: a name, a `Booster`, or a wire-form object sent as given. */
export type BoosterInput = BoosterName | Booster | WireBooster;

/**
 * The `boosters` field as sent, or `undefined` to leave it out (none given,
 * or an empty list). A `Booster` becomes its wire form; everything else is
 * sent as given, for the server to judge.
 */
export function boostersWire(boosters: unknown): unknown {
  if (boosters === undefined || boosters === null) return undefined;
  if (Array.isArray(boosters)) {
    if (boosters.length === 0) return undefined;
    return boosters.map((b: unknown) => (b instanceof Booster ? b.toJSON() : b));
  }
  return boosters instanceof Booster ? boosters.toJSON() : boosters;
}

// ---------------------------------------------------------------- readings

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function absent(v: unknown): v is null | undefined {
  return v === undefined || v === null;
}

function isInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/** Sets an own property, so a name such as `__proto__` is a key like any other. */
function put<T>(map: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
}

/** The likeliest image generator, as an `ai_generated` reading names it. */
export interface TopGenerator {
  name: string;
  probability: number;
}

/**
 * An `age` reading of one image. When `faces` is 0 the picture shows no face
 * and the age fields are `null`.
 */
export class AgeReading {
  /** The id of the image read. */
  readonly image: string;
  /** How many faces were found; the largest is read. */
  readonly faces: number;
  readonly ageYears: number | null;
  /** The low end of the age range. */
  readonly low: number | null;
  /** The high end of the age range. */
  readonly high: number | null;
  /** 0 to 1. */
  readonly confidence: number | null;
  /** The reading as received. */
  readonly raw: Record<string, unknown>;

  constructor(raw: Record<string, unknown>) {
    this.raw = raw;
    this.image = raw.image as string;
    this.faces = raw.faces as number;
    this.ageYears = (raw.age_years ?? null) as number | null;
    this.low = (raw.low ?? null) as number | null;
    this.high = (raw.high ?? null) as number | null;
    this.confidence = (raw.confidence ?? null) as number | null;
  }

  static wellFormed(r: Record<string, unknown>): boolean {
    if (typeof r.image !== 'string' || !isInteger(r.faces) || r.faces < 0) return false;
    // With no face the age fields are left out; with one, each is required.
    const face = r.faces > 0;
    const fields: Array<[unknown, (v: unknown) => boolean]> = [
      [r.age_years, isInteger],
      [r.low, isInteger],
      [r.high, isInteger],
      [r.confidence, isNumber],
    ];
    return fields.every(([v, ok]) => (absent(v) ? !face : ok(v)));
  }
}

/** An `ai_generated` reading of one image. */
export class AiGeneratedReading {
  /** The id of the image read. */
  readonly image: string;
  /** The probability that the picture was made by an image generator, 0 to 1. */
  readonly generated: number;
  /** 0 to 1. */
  readonly confidence: number;
  /** `inference` (read from the pixels), `c2pa` (the file's Content Credentials say so), or a newer value as sent. */
  readonly method: 'inference' | 'c2pa' | (string & {});
  /**
   * The likeliest generator, when the reading says the picture is likely
   * generated; `null` otherwise, and always on a `c2pa` reading.
   */
  readonly topGenerator: TopGenerator | null;
  /** Who signed the file's Content Credentials when they are trusted; `null` otherwise. */
  readonly c2paSigner: string | null;
  /**
   * `untrusted` when the file carries Content Credentials that validate but
   * are not trusted (they name no signer and change nothing in the reading),
   * or a newer value as sent; `null` when the reading has none.
   */
  readonly c2pa: 'untrusted' | (string & {}) | null;
  /** The reading as received. */
  readonly raw: Record<string, unknown>;

  constructor(raw: Record<string, unknown>) {
    this.raw = raw;
    this.image = raw.image as string;
    this.generated = raw.generated as number;
    this.confidence = raw.confidence as number;
    this.method = raw.method as string;
    const top = raw.top_generator as Record<string, unknown> | null;
    this.topGenerator = top === null ? null : { name: top.name as string, probability: top.probability as number };
    this.c2paSigner = raw.c2pa_signer as string | null;
    this.c2pa = (raw.c2pa ?? null) as string | null;
  }

  static wellFormed(r: Record<string, unknown>): boolean {
    if (typeof r.image !== 'string' || typeof r.method !== 'string') return false;
    if (!isNumber(r.generated) || !isNumber(r.confidence)) return false;
    // top_generator and c2pa_signer are always sent, null when unset; c2pa only
    // when the file's Content Credentials are not trusted.
    const has = (k: string) => Object.prototype.hasOwnProperty.call(r, k);
    if (!has('top_generator') || !has('c2pa_signer')) return false;
    const top = r.top_generator;
    if (top !== null && !(isObject(top) && typeof top.name === 'string' && isNumber(top.probability))) return false;
    if (r.c2pa_signer !== null && typeof r.c2pa_signer !== 'string') return false;
    return absent(r.c2pa) || typeof r.c2pa === 'string';
  }
}

/**
 * A reading of a booster this SDK version does not know, or one with a field
 * missing or of the wrong type. Every field is in `raw`; the decision does
 * not fail.
 */
export class UnknownReading {
  /** The id of the image read, when the reading names one. */
  readonly image: string | null;
  /** The reading as received; a reading that is not an object is kept as `{ value }`. */
  readonly raw: Record<string, unknown>;

  constructor(raw: unknown) {
    this.raw = isObject(raw) ? raw : { value: raw };
    this.image = isObject(raw) && typeof raw.image === 'string' ? raw.image : null;
  }
}

/** One reading of one image. */
export type Reading = AgeReading | AiGeneratedReading | UnknownReading;

/** Parses one reading by the booster that made it. */
export function parseReading(booster: string, raw: unknown): Reading {
  if (isObject(raw)) {
    if (booster === 'age' && AgeReading.wellFormed(raw)) return new AgeReading(raw);
    if (booster === 'ai_generated' && AiGeneratedReading.wellFormed(raw)) return new AiGeneratedReading(raw);
  }
  return new UnknownReading(raw);
}

/** What one booster of the request did, and what it read. */
export class Evidence<R extends Reading = Reading> {
  /** The version of the booster that read, `<name>-v<n>`. */
  readonly version: string | null;
  /**
   * `ok`; `timeout` (no answer in time); `error`; `skipped` (none of the
   * request's images is one it reads); or a newer value as sent.
   */
  readonly status: 'ok' | 'timeout' | 'error' | 'skipped' | (string & {}) | null;
  /** How long the booster took, in milliseconds. */
  readonly latencyMs: number | null;
  /** The calls of this booster billed on this request; `null` when the server did not send it. */
  readonly billedCalls: number | null;
  /**
   * One reading per image the booster was to read. A picture it did not read
   * (it timed out or failed) or could not decode (`readable` false) is an
   * `UnknownReading` holding those fields; `status` says why.
   */
  readonly results: R[];
  /** The entry as received. */
  readonly raw: unknown;

  constructor(booster: string, raw: unknown) {
    this.raw = raw;
    const r = isObject(raw) ? raw : {};
    this.version = typeof r.version === 'string' ? r.version : null;
    this.status = typeof r.status === 'string' ? r.status : null;
    this.latencyMs = isNumber(r.latency_ms) ? r.latency_ms : null;
    this.billedCalls = isInteger(r.billed_calls) ? r.billed_calls : null;
    this.results = (Array.isArray(r.results) ? r.results : []).map((x: unknown) => parseReading(booster, x)) as R[];
  }
}

/** The evidence of a decision, by booster name in the request's order. */
export interface EvidenceByBooster {
  age?: Evidence<AgeReading | UnknownReading>;
  ai_generated?: Evidence<AiGeneratedReading | UnknownReading>;
  [booster: string]: Evidence | undefined;
}

/** The body's `evidence`, or `null` when it has none. */
export function parseEvidence(value: unknown): EvidenceByBooster | null {
  if (!isObject(value)) return null;
  const out: EvidenceByBooster = {};
  for (const [name, entry] of Object.entries(value)) put(out, name, new Evidence(name, entry));
  return out;
}

// ---------------------------------------------------------------- the response header

/** One booster's outcome, from the `x-decisionnode-boosters` header. */
export interface BoosterStatus {
  /** `ok`, `timeout`, `error`, `skipped`, or a newer value as sent. */
  status: string;
  /** How long the booster took, in milliseconds; `null` when not sent. */
  latencyMs: number | null;
}

/**
 * The `x-decisionnode-boosters` header (`age=ok:212,ai_generated=timeout:800`)
 * by booster name, in its order. Empty when the header is absent; an item
 * that cannot be read is skipped. Never throws.
 */
export function parseBoostersHeader(header: string | null | undefined): Record<string, BoosterStatus> {
  const out: Record<string, BoosterStatus> = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(',')) {
    const item = part.trim();
    const eq = item.indexOf('=');
    if (eq <= 0) continue;
    const name = item.slice(0, eq);
    const value = item.slice(eq + 1);
    const colon = value.indexOf(':');
    const status = colon === -1 ? value : value.slice(0, colon);
    const ms = colon === -1 ? '' : value.slice(colon + 1);
    put(out, name, { status, latencyMs: /^[0-9]+$/.test(ms) ? Number(ms) : null });
  }
  return out;
}
