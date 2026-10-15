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
export type BoosterName =
  | 'age'
  | 'ai_generated'
  | 'face_detection'
  | 'face_recognition'
  | 'ocr'
  | 'bynn_depth'
  | 'bynn_segment'
  | (string & {});

/**
 * A booster's own settings, sent as given in `options`; the API checks them.
 * Other keys are sent as given too, for settings a later booster adds.
 */
export interface BoosterSettings {
  /**
   * `ocr`: what to read, at most 2,000 characters: a task, an instruction
   * ("the invoice total and date") or a JSON schema. `bynn_segment`
   * (required): what to find, one phrase as a string or 1 to 4 phrases as an
   * array, each at most 120 characters; a string is always one phrase.
   */
  prompt?: string | readonly string[];
  /** `face_recognition`: the collection to search, its id or a public collection's name. */
  collection?: string;
  /** `face_recognition`: the lowest match score it lists. */
  threshold?: number;
  /** `bynn_depth`: the grid's cells per side, 2 to 16; left out, 8. */
  grid_size?: number;
  /** `bynn_segment`: at most this many found, 1 to 16; left out, 8. */
  max_instances?: number;
  /** `bynn_segment`: a match scored below it is left out, 0 to 1; left out, 0.25. */
  min_score?: number;
  /** `bynn_segment`: the points of each outline, 3 to 64; left out, 24. */
  polygon_points?: number;
  /** `bynn_segment`: distances and sizes in meters; left out, `true`. */
  depth?: boolean;
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

/** Whether a `boosters` field as sent names `ocr`, by its bare name or in the object form. */
export function namesOcr(wire: unknown): boolean {
  if (!Array.isArray(wire)) return false;
  return wire.some((b: unknown) => b === 'ocr' || (isObject(b) && b.name === 'ocr'));
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
 * A face's box: its corners, in pixels of the image as sent (integers), or as
 * fractions when every place question of the request asks for normalized
 * units. The numbers are as sent, never converted.
 */
export interface FaceBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** One face a `face_detection` reading found. */
export interface FaceDetection {
  box: FaceBox;
  /** 0 to 1. */
  confidence: number;
}

/** One face a `face_recognition` reading matched in a collection. */
export interface FaceMatch {
  box: FaceBox;
  /** The match score, 0 to 1. */
  score: number;
  /** The collection searched. */
  collection: string;
  /** The matched item's reference. */
  reference: string;
  /** A public figure's name, for a public collection that names its items; `null` otherwise. */
  name: string | null;
  /** The matched item's label, when it has one; `null` otherwise. */
  label: string | null;
  /**
   * The collection's name: an own collection's display name or its id, a
   * public collection's id; `null` when the answer does not carry it.
   */
  collectionName: string | null;
  /** The matched item's metadata, as sent; `null` when it has none, never `{}`. */
  metadata: Record<string, unknown> | null;
}

function isFaceBox(v: unknown): v is FaceBox {
  return isObject(v) && isNumber(v.x1) && isNumber(v.y1) && isNumber(v.x2) && isNumber(v.y2);
}

function faceBox(v: Record<string, unknown>): FaceBox {
  return { x1: v.x1 as number, y1: v.y1 as number, x2: v.x2 as number, y2: v.y2 as number };
}

function isFaceCount(v: unknown): v is number {
  return isInteger(v) && v >= 0;
}

/**
 * A `face_detection` reading of one image: how many faces it shows and where.
 * `faces` can exceed `detections`, which holds at most 64; a picture with no
 * face is `faces` 0 with no detections, a reading, not a failure.
 */
export class FaceDetectionReading {
  /** The id of the image read. */
  readonly image: string;
  /** How many faces the picture shows. */
  readonly faces: number;
  /** The faces found, by confidence, in the order sent. */
  readonly detections: FaceDetection[];
  /** The reading as received. */
  readonly raw: Record<string, unknown>;

  constructor(raw: Record<string, unknown>) {
    this.raw = raw;
    this.image = raw.image as string;
    this.faces = raw.faces as number;
    this.detections = (raw.detections as Record<string, unknown>[]).map((d) => ({
      box: faceBox(d.box as Record<string, unknown>),
      confidence: d.confidence as number,
    }));
  }

  static wellFormed(r: Record<string, unknown>): boolean {
    if (typeof r.image !== 'string' || !isFaceCount(r.faces) || !Array.isArray(r.detections)) return false;
    return r.detections.every((d: unknown) => isObject(d) && isFaceBox(d.box) && isNumber(d.confidence));
  }
}

/**
 * A `face_recognition` reading of one image: the faces searched in the
 * collection and the ones that match an item of it, each by its box, score,
 * the collection, the item's reference, and its name or label when there is one.
 */
export class FaceRecognitionReading {
  /** The id of the image read. */
  readonly image: string;
  /** How many faces were searched. */
  readonly faces: number;
  /** The faces that match, by score, in the order sent; empty when none does. */
  readonly matches: FaceMatch[];
  /** An own collection's display name; `null` for a public collection or when not sent. */
  readonly collectionName: string | null;
  /** The reading as received. */
  readonly raw: Record<string, unknown>;

  constructor(raw: Record<string, unknown>) {
    this.raw = raw;
    this.image = raw.image as string;
    this.faces = raw.faces as number;
    this.collectionName = (raw.collection_name ?? null) as string | null;
    this.matches = (raw.matches as Record<string, unknown>[]).map((m) => ({
      box: faceBox(m.box as Record<string, unknown>),
      score: m.score as number,
      collection: m.collection as string,
      reference: m.reference as string,
      name: (m.name ?? null) as string | null,
      label: (m.label ?? null) as string | null,
      collectionName: (m.collection_name ?? null) as string | null,
      metadata: (m.metadata ?? null) as Record<string, unknown> | null,
    }));
  }

  static wellFormed(r: Record<string, unknown>): boolean {
    if (typeof r.image !== 'string' || !isFaceCount(r.faces) || !Array.isArray(r.matches)) return false;
    const optionalString = (v: unknown) => absent(v) || typeof v === 'string';
    if (!optionalString(r.collection_name)) return false;
    return r.matches.every(
      (m: unknown) =>
        isObject(m) &&
        isFaceBox(m.box) &&
        isNumber(m.score) &&
        typeof m.collection === 'string' &&
        typeof m.reference === 'string' &&
        optionalString(m.name) &&
        optionalString(m.label) &&
        optionalString(m.collection_name) &&
        (absent(m.metadata) || isObject(m.metadata)),
    );
  }
}

/**
 * An `ocr` reading of one image: the text the picture shows, in reading
 * order, or the answer to the booster's `prompt` option.
 */
export class OcrReading {
  /** The id of the image read. */
  readonly image: string;
  /** The text read; empty when the picture shows none, which is a reading, not a failure. */
  readonly text: string;
  /** `true` when the reading was cut at the model's context limit. */
  readonly truncated: boolean;
  /** The reading as received. */
  readonly raw: Record<string, unknown>;

  constructor(raw: Record<string, unknown>) {
    this.raw = raw;
    this.image = raw.image as string;
    this.text = raw.text as string;
    this.truncated = raw.truncated as boolean;
  }

  static wellFormed(r: Record<string, unknown>): boolean {
    return typeof r.image === 'string' && typeof r.text === 'string' && typeof r.truncated === 'boolean';
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

function has(r: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(r, key);
}

/** A number or `null`, the key present. */
function nullableNumber(r: Record<string, unknown>, key: string): boolean {
  return has(r, key) && (r[key] === null || isNumber(r[key]));
}

function isNumbers(v: unknown, count?: number): v is number[] {
  return Array.isArray(v) && v.every(isNumber) && (count === undefined || v.length === count);
}

function isPoints(v: unknown): v is number[][] {
  return Array.isArray(v) && v.every((p: unknown) => isNumbers(p, 2));
}

/** An object or `null`, the key present. */
function nullableObject(r: Record<string, unknown>, key: string): boolean {
  return has(r, key) && (r[key] === null || isObject(r[key]));
}

/**
 * A `bynn_depth` reading of one image (Depth Vision): how far away things
 * are, in meters. The distances are estimates from one picture, for decisions
 * and planning, never a safety stop.
 */
export class DepthReading {
  /** The id of the image read. */
  readonly image: string;
  /**
   * Meters to the nearest obstacle straight ahead (the middle third of the
   * picture, the floor or ground left out); `null` when none is found.
   */
  readonly ahead: number | null;
  /** The same in 7 equal vertical strips of the picture, left to right, each meters or `null`. */
  readonly directions: Array<number | null>;
  /** `true` when a floor or ground was found and left out of `ahead` and `directions`. */
  readonly ground: boolean;
  readonly gridRows: number;
  readonly gridCols: number;
  /** The grid, row by row from the top left of the picture turned upright, each cell in meters. */
  readonly grid: number[][];
  /** The nearest distance in the picture. */
  readonly depthMin: number;
  /** The farthest distance in the picture. */
  readonly depthMax: number;
  /** The median distance in the picture. */
  readonly depthMedian: number;
  /** The picture's width in pixels, turned upright. */
  readonly width: number;
  /** The picture's height in pixels, turned upright. */
  readonly height: number;
  /** The reading as received. */
  readonly raw: Record<string, unknown>;

  constructor(raw: Record<string, unknown>) {
    this.raw = raw;
    this.image = raw.image as string;
    this.ahead = raw.ahead as number | null;
    this.directions = [...(raw.directions as Array<number | null>)];
    this.ground = raw.ground as boolean;
    this.gridRows = raw.grid_rows as number;
    this.gridCols = raw.grid_cols as number;
    this.grid = (raw.grid as number[][]).map((row) => [...row]);
    this.depthMin = raw.depth_min as number;
    this.depthMax = raw.depth_max as number;
    this.depthMedian = raw.depth_median as number;
    this.width = raw.width as number;
    this.height = raw.height as number;
  }

  static wellFormed(r: Record<string, unknown>): boolean {
    return (
      typeof r.image === 'string' &&
      nullableNumber(r, 'ahead') &&
      Array.isArray(r.directions) &&
      r.directions.every((d: unknown) => d === null || isNumber(d)) &&
      typeof r.ground === 'boolean' &&
      isInteger(r.grid_rows) &&
      isInteger(r.grid_cols) &&
      Array.isArray(r.grid) &&
      r.grid.every((row: unknown) => isNumbers(row)) &&
      isNumber(r.depth_min) &&
      isNumber(r.depth_max) &&
      isNumber(r.depth_median) &&
      isInteger(r.width) &&
      isInteger(r.height)
    );
  }
}

/**
 * The opening a `bynn_segment` instance encloses, such as the hole of a gate,
 * a doorway or a ring. Coordinates are fractions of the picture from its top left.
 */
export interface SegmentOpening {
  /** Its outline, `[x, y]` points. */
  polygon: number[][];
  /** Its centre, `[x, y]`. */
  centroid: number[];
  /** Its width, a fraction of the picture's. */
  width: number;
  /** Its height, a fraction of the picture's. */
  height: number;
  /** `[dx, dy]`, from -1 to 1. */
  offset: number[];
  /** Its area, a fraction of the picture's. */
  area: number;
}

/** How far away a `bynn_segment` instance is, in meters, with depth on. */
export interface SegmentDepth {
  /** The median distance inside its outline. */
  median: number | null;
  /** The median distance seen through its opening. */
  openingMedian: number | null;
  /** The median distance of its opening's rim. */
  openingRimMedian: number | null;
}

/** A width and a height in meters. */
export interface SegmentExtent {
  width: number;
  height: number;
}

/** How large a `bynn_segment` instance is, in meters, with depth on. */
export interface SegmentSize {
  width: number;
  height: number;
  /** Its opening's width and height, or `null`. */
  opening: SegmentExtent | null;
}

/**
 * One thing a `bynn_segment` reading found. Coordinates are fractions of the
 * picture's width and height, from its top left, turned upright.
 */
export interface SegmentInstance {
  /** The phrase it matched. */
  label: string;
  /** How well it matches, 0 to 1. */
  score: number;
  /** `[x1, y1, x2, y2]`, its top left and bottom right corners. */
  box: number[];
  /** Its outline, `[x, y]` points. */
  polygon: number[][];
  /** Its area, a fraction of the picture's. */
  area: number;
  /** Its centre, `[x, y]`. */
  centroid: number[];
  /** The opening it encloses, or `null`. */
  opening: SegmentOpening | null;
  /** Its distances in meters, or `null` with depth off. */
  depth: SegmentDepth | null;
  /** Its size in meters, or `null` with depth off. */
  sizeM: SegmentSize | null;
}

function isSegmentInstance(e: unknown): boolean {
  if (!isObject(e)) return false;
  if (typeof e.label !== 'string' || !isNumber(e.score) || !isNumbers(e.box, 4) || !isPoints(e.polygon)) return false;
  if (!isNumber(e.area) || !isNumbers(e.centroid, 2)) return false;
  if (!nullableObject(e, 'opening') || !nullableObject(e, 'depth') || !nullableObject(e, 'size_m')) return false;
  const o = e.opening as Record<string, unknown> | null;
  if (o !== null && !(isPoints(o.polygon) && isNumbers(o.centroid, 2) && isNumber(o.width) && isNumber(o.height) && isNumbers(o.offset, 2) && isNumber(o.area))) {
    return false;
  }
  const d = e.depth as Record<string, unknown> | null;
  if (d !== null && !(nullableNumber(d, 'median') && nullableNumber(d, 'opening_median') && nullableNumber(d, 'opening_rim_median'))) return false;
  const s = e.size_m as Record<string, unknown> | null;
  if (s === null) return true;
  if (!isNumber(s.width) || !isNumber(s.height) || !nullableObject(s, 'opening')) return false;
  const x = s.opening as Record<string, unknown> | null;
  return x === null || (isNumber(x.width) && isNumber(x.height));
}

function segmentInstance(e: Record<string, unknown>): SegmentInstance {
  const o = e.opening as Record<string, unknown> | null;
  const d = e.depth as Record<string, unknown> | null;
  const s = e.size_m as Record<string, unknown> | null;
  const x = s === null ? null : (s.opening as Record<string, unknown> | null);
  const points = (v: unknown) => (v as number[][]).map((p) => [...p]);
  return {
    label: e.label as string,
    score: e.score as number,
    box: [...(e.box as number[])],
    polygon: points(e.polygon),
    area: e.area as number,
    centroid: [...(e.centroid as number[])],
    opening:
      o === null
        ? null
        : {
            polygon: points(o.polygon),
            centroid: [...(o.centroid as number[])],
            width: o.width as number,
            height: o.height as number,
            offset: [...(o.offset as number[])],
            area: o.area as number,
          },
    depth:
      d === null
        ? null
        : { median: d.median as number | null, openingMedian: d.opening_median as number | null, openingRimMedian: d.opening_rim_median as number | null },
    sizeM:
      s === null
        ? null
        : { width: s.width as number, height: s.height as number, opening: x === null ? null : { width: x.width as number, height: x.height as number } },
  };
}

/**
 * A `bynn_segment` reading of one image (Segment Vision): where the things
 * the request's `prompt` names are in the picture.
 */
export class SegmentReading {
  /** The id of the image read. */
  readonly image: string;
  /** The picture's width in pixels, turned upright. */
  readonly width: number;
  /** The picture's height in pixels, turned upright. */
  readonly height: number;
  /** The phrases searched for, cleaned as the request's `prompt` is. */
  readonly prompts: string[];
  /** What was found, best first; empty when nothing was, which is a reading. */
  readonly instances: SegmentInstance[];
  /** Where the distances come from (`bynn_depth`); `null` with depth off. */
  readonly depthSource: string | null;
  /** The horizontal field of view the sizes in meters assume, in degrees. */
  readonly assumedHfovDeg: number;
  /** The reading as received. */
  readonly raw: Record<string, unknown>;

  constructor(raw: Record<string, unknown>) {
    this.raw = raw;
    this.image = raw.image as string;
    this.width = raw.width as number;
    this.height = raw.height as number;
    this.prompts = [...(raw.prompts as string[])];
    this.instances = (raw.instances as Record<string, unknown>[]).map(segmentInstance);
    this.depthSource = raw.depth_source as string | null;
    this.assumedHfovDeg = raw.assumed_hfov_deg as number;
  }

  static wellFormed(r: Record<string, unknown>): boolean {
    return (
      typeof r.image === 'string' &&
      isInteger(r.width) &&
      isInteger(r.height) &&
      Array.isArray(r.prompts) &&
      r.prompts.every((p: unknown) => typeof p === 'string') &&
      Array.isArray(r.instances) &&
      r.instances.every(isSegmentInstance) &&
      has(r, 'depth_source') &&
      (r.depth_source === null || typeof r.depth_source === 'string') &&
      isNumber(r.assumed_hfov_deg)
    );
  }
}

/** One reading of one image. */
export type Reading =
  | AgeReading
  | AiGeneratedReading
  | FaceDetectionReading
  | FaceRecognitionReading
  | OcrReading
  | DepthReading
  | SegmentReading
  | UnknownReading;

/** Parses one reading by the booster that made it. */
export function parseReading(booster: string, raw: unknown): Reading {
  if (isObject(raw)) {
    if (booster === 'age' && AgeReading.wellFormed(raw)) return new AgeReading(raw);
    if (booster === 'ai_generated' && AiGeneratedReading.wellFormed(raw)) return new AiGeneratedReading(raw);
    if (booster === 'face_detection' && FaceDetectionReading.wellFormed(raw)) return new FaceDetectionReading(raw);
    if (booster === 'face_recognition' && FaceRecognitionReading.wellFormed(raw)) return new FaceRecognitionReading(raw);
    if (booster === 'ocr' && OcrReading.wellFormed(raw)) return new OcrReading(raw);
    if (booster === 'bynn_depth' && DepthReading.wellFormed(raw)) return new DepthReading(raw);
    if (booster === 'bynn_segment' && SegmentReading.wellFormed(raw)) return new SegmentReading(raw);
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
  face_detection?: Evidence<FaceDetectionReading | UnknownReading>;
  face_recognition?: Evidence<FaceRecognitionReading | UnknownReading>;
  ocr?: Evidence<OcrReading | UnknownReading>;
  bynn_depth?: Evidence<DepthReading | UnknownReading>;
  bynn_segment?: Evidence<SegmentReading | UnknownReading>;
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
