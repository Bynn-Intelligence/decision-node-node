/**
 * The API's fixed request rules, checked before anything is sent, so a request
 * the server would refuse never leaves the process. A fault raises what the
 * server would answer: the same class, `error_type` and message, and for a 422
 * the server's own `entries`. Token limits depend on the model version and
 * stay the server's to judge.
 */
import { BadRequestError, ValidationError, localError } from './errors.js';

/** The most options a `choice` question takes. */
export const MAX_CHOICE_OPTIONS = 255;
/** The most levels a `score` question takes. */
export const MAX_SCORE_LEVELS = 10;
/** The most values a `number` grid may hold. */
export const MAX_GRID_VALUES = 4096;
/** The most objects and arrays a request may hold inside each other, its own object included. */
export const MAX_NESTING = 128;
/** The largest `window` of a session. */
export const MAX_WINDOW = 64;
/** The longest `ttl_seconds` of a session. */
export const MAX_TTL_SECONDS = 3600;
/** The largest frame `seq`. */
export const MAX_SEQ = Number.MAX_SAFE_INTEGER;

const TWO_53 = 2 ** 53;
const MAX_NUMBER_DECIMALS = 6;
const LEGACY_TRUTH = 'noul';
const DECIDE_TYPES = new Set(['truth', LEGACY_TRUTH, 'choice', 'score', 'number', 'point', 'box']);
const PLACE_TYPES = new Set(['point', 'box']);
const UNITS = new Set(['pixels', 'normalized']);
const SYSTEMONE_TYPES = new Set([LEGACY_TRUTH, 'choice', 'score']);

/** Which path a request goes to: `/v1/systemone` takes fewer question types, and score levels only as a list. */
export type Profile = 'decide' | 'systemone';

/**
 * Limits a model publishes at `/v1/models`, held once the client has read them.
 * A rule whose value only `/v1/models` states is checked when it is held and
 * left to the server when it is not.
 */
export type HeldLimits = Record<string, unknown> & { model?: string };

/** One entry of the API's 422 `detail` list. */
export interface Entry {
  type: string;
  loc: Array<string | number>;
  msg: string;
  input: unknown;
  ctx?: Record<string, unknown>;
}

function entry(type: string, loc: Array<string | number>, msg: string, input: unknown, ctx?: Record<string, unknown>): Entry {
  const e: Entry = { type, loc: [...loc], msg, input };
  if (ctx !== undefined) e.ctx = ctx;
  return e;
}

/** The API's 422, raised before any request, with the entries the server would list. */
export function localValidation(entries: Entry[]): ValidationError {
  return new ValidationError('', { errorType: null, entries });
}

function withReason<E extends Error>(err: E, reason: string): E {
  (err as unknown as { reason: string | null }).reason = reason;
  return err;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** A string, an object or an array: what `state`, `instructions`, descriptions and levels take. */
function isSdl(v: unknown): boolean {
  return typeof v === 'string' || (v !== null && typeof v === 'object');
}

function sdlEntries(loc: Array<string | number>, value: unknown): Entry[] {
  return [
    entry('string_type', [...loc, 'str'], 'Input should be a valid string', value),
    entry('dict_type', [...loc, 'dict[any,any]'], 'Input should be a valid dictionary', value),
    entry('list_type', [...loc, 'list[any]'], 'Input should be a valid list', value),
  ];
}

function present(v: unknown): boolean {
  return v !== undefined && v !== null;
}

/** A number from the held limits, else the documented one. */
export function heldNumber(limits: Record<string, unknown>, name: string, fallback: number): number {
  const v = limits[name];
  return typeof v === 'number' && v > 0 ? v : fallback;
}

/**
 * How many objects and arrays sit inside each other, the outermost included,
 * counted up to one past the limit. A value that contains itself cannot be
 * sent as JSON and is a `TypeError`.
 */
export function nestingDepth(value: unknown): number {
  let deepest = 0;
  const path = new Set<object>();
  const visit = (node: object, depth: number): void => {
    if (depth > deepest) deepest = depth;
    if (depth > MAX_NESTING) return;
    if (path.has(node)) throw new TypeError('the request cannot be serialised as JSON: a value contains itself');
    path.add(node);
    for (const c of Array.isArray(node) ? node : Object.values(node)) {
      if (c !== null && typeof c === 'object') visit(c, depth + 1);
    }
    path.delete(node);
  };
  if (value !== null && typeof value === 'object') visit(value, 1);
  return deepest;
}

/** The nesting limit: `BadRequestError`, `api_usage_error`, "Invalid request.". */
export function checkNesting(body: unknown): void {
  const depth = nestingDepth(body);
  if (depth > MAX_NESTING) {
    throw withReason(
      localError(BadRequestError, 'Invalid request.'),
      `the request nests more than ${MAX_NESTING} objects and arrays inside each other`,
    );
  }
}

// ---------------------------------------------------------------- exact decimals for number grids

interface Decimal {
  /** The value times 10^scale, exact; the scale is the value's own decimal places. */
  int: bigint;
  scale: number;
}

/** The exact decimal a JSON number is written as (its shortest round-trip text). */
function toDecimal(n: number): Decimal {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(n))!;
  const frac = m[3] ?? '';
  let digits = m[2]! + frac;
  let scale = frac.length - Number(m[4] ?? 0);
  if (scale < 0) {
    digits += '0'.repeat(-scale);
    scale = 0;
  }
  let int = BigInt(m[1]! + digits);
  while (scale > 0 && int % 10n === 0n) {
    int /= 10n;
    scale--;
  }
  return { int, scale };
}

const TEN = (n: number) => 10n ** BigInt(n);

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

/** The value scaled to `d` decimals, rounded down (exact when it has at most `d`). */
function scaled(x: Decimal, d: number): bigint {
  return x.scale <= d ? x.int * TEN(d - x.scale) : floorDiv(x.int, TEN(x.scale - d));
}

/** -1, 0 or 1 as `a` is below, equal to or above `b`, exactly. */
function compare(a: Decimal, b: Decimal): number {
  const s = Math.max(a.scale, b.scale);
  const x = a.int * TEN(s - a.scale);
  const y = b.int * TEN(s - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The number of values in a grid with these fields, built in exact decimals as
 * the server builds it. Defaults 0, 255 and 1. Assumes the fields passed the
 * number checks.
 */
export function gridSize(q: { min?: unknown; max?: unknown; step?: unknown }): number {
  const pick = (v: unknown, dflt: number) => (typeof v === 'number' ? v : dflt);
  const m = toDecimal(pick(q.min, 0));
  const s = toDecimal(pick(q.step, 1));
  const d = Math.max(m.scale, s.scale);
  return Number((scaled(toDecimal(pick(q.max, 255)), d) - scaled(m, d)) / scaled(s, d) + 1n);
}

function checkNumber(
  id: string,
  q: Record<string, unknown>,
  loc: Array<string | number>,
  entries: Entry[],
  deferred: Error[],
  maxValues: number,
): void {
  const defaults: Record<string, number> = { min: 0, max: 255, step: 1 };
  const values: Record<string, number> = {};
  let ok = true;
  for (const name of ['min', 'max', 'step']) {
    const sent = q[name];
    const floc = [...loc, name];
    if (!present(sent)) {
      values[name] = defaults[name]!;
      continue;
    }
    if (typeof sent !== 'number') {
      entries.push(entry('float_type', floc, 'Input should be a valid number', sent));
      ok = false;
      continue;
    }
    if (!Number.isFinite(sent)) {
      entries.push(entry('finite_number', floc, 'Input should be a finite number', sent));
      ok = false;
      continue;
    }
    if ((name === 'min' || name === 'max') && sent < -TWO_53) {
      entries.push(entry('greater_than_equal', floc, `Input should be greater than or equal to -${TWO_53}`, sent, { ge: -TWO_53 }));
      ok = false;
      continue;
    }
    if ((name === 'min' || name === 'max') && sent > TWO_53) {
      entries.push(entry('less_than_equal', floc, `Input should be less than or equal to ${TWO_53}`, sent, { le: TWO_53 }));
      ok = false;
      continue;
    }
    if (name === 'step' && !(sent > 0)) {
      entries.push(entry('greater_than', floc, 'Input should be greater than 0', sent, { gt: 0 }));
      ok = false;
      continue;
    }
    if ((name === 'min' || name === 'step') && toDecimal(sent).scale > MAX_NUMBER_DECIMALS) {
      entries.push(
        entry('decimal_max_places', floc, `Decimal input should have no more than ${MAX_NUMBER_DECIMALS} decimal places`, sent, {
          decimal_places: MAX_NUMBER_DECIMALS,
        }),
      );
      ok = false;
      continue;
    }
    values[name] = sent;
  }
  if (!ok) return;
  const lo = values.min!;
  const hi = values.max!;
  const d = Math.max(toDecimal(lo).scale, toDecimal(values.step!).scale);
  if (d > 0) {
    // Every grid value must have at most 15 significant digits, so a client reads it back exactly.
    const text = `${'9'.repeat(15 - d)}.${'9'.repeat(d)}`;
    const bound: Decimal = { int: BigInt(text.replace('.', '')), scale: d };
    const negative: Decimal = { int: -bound.int, scale: d };
    for (const name of ['min', 'max']) {
      const v = toDecimal(values[name]!);
      if (compare(v, bound) > 0) {
        entries.push(entry('less_than_equal', [...loc, name], `Input should be less than or equal to ${text}`, q[name], { le: Number(text) }));
        return;
      }
      if (compare(v, negative) < 0) {
        entries.push(entry('greater_than_equal', [...loc, name], `Input should be greater than or equal to -${text}`, q[name], { ge: -Number(text) }));
        return;
      }
    }
  }
  if (lo > hi) {
    const maxSent = present(q.max) ? q.max : 255;
    const minSent = present(q.min) ? q.min : 0;
    entries.push(entry('less_than_equal', [...loc, 'min'], `Input should be less than or equal to ${JSON.stringify(maxSent)}`, minSent, { le: maxSent }));
    return;
  }
  const n = gridSize(values);
  if (n > maxValues) {
    entries.push(
      entry('too_long', loc, `Grid should have at most ${maxValues} values, not ${n}`, q, {
        field_type: 'Grid',
        max_length: maxValues,
        actual_length: n,
      }),
    );
    return;
  }
  if (!present(q.instructions) || q.instructions === '') {
    deferred.push(localError(BadRequestError, `Number question must have instructions: ${id}`, null));
  }
}

/** Keys exactly "0" to "K-1": a score's levels written as an object. */
function isIndexKeyed(o: Record<string, unknown>): boolean {
  const keys = Object.keys(o);
  return keys.every((k) => /^(0|[1-9][0-9]*)$/.test(k) && Number(k) < keys.length);
}

/**
 * A point or box question: the image it looks in (none to look in, none named
 * among two or more, not a string, not one of the request's), its units, then
 * its instructions. `imageIds` is `null` where the request carries no images of
 * its own (a session's open: its images come with its frames).
 */
function checkPlace(
  id: string,
  q: Record<string, unknown>,
  loc: Array<string | number>,
  entries: Entry[],
  deferred: Error[],
  imageIds: readonly unknown[] | null,
): void {
  const type = q.type as string;
  if (imageIds !== null) {
    const image = q.image;
    if (imageIds.length === 0) {
      entries.push(entry('image_required', loc, `A ${type} question needs an image in the request`, q));
    } else if (!present(image)) {
      if (imageIds.length >= 2) entries.push(entry('missing', [...loc, 'image'], 'Field required', q));
    } else if (typeof image !== 'string') {
      entries.push(entry('string_type', [...loc, 'image'], 'Input should be a valid string', image));
    } else if (!imageIds.includes(image)) {
      entries.push(entry('unknown_image', [...loc, 'image'], 'Input should be the id of an image of the request', image));
    }
  }
  const units = q.units;
  if (present(units) && !(typeof units === 'string' && UNITS.has(units))) {
    entries.push(
      entry('literal_error', [...loc, 'units'], "Input should be 'pixels' or 'normalized'", units, { expected: "'pixels' or 'normalized'" }),
    );
  }
  if (!present(q.instructions)) {
    const name = type === 'point' ? 'Point' : 'Box';
    deferred.push(localError(BadRequestError, `${name} question must have instructions: ${id}`, null));
  }
}

function checkQuestion(
  id: string,
  q: unknown,
  entries: Entry[],
  deferred: Error[],
  profile: Profile,
  limits: HeldLimits,
  imageIds: readonly unknown[] | null = null,
): void {
  const base: Array<string | number> = ['body', 'questions', id];
  if (!isObject(q)) {
    entries.push(entry('model_type', base, 'Input should be a valid dictionary or object', q));
    return;
  }
  if (!present(q.type)) {
    entries.push(entry('missing', [...base, 'type'], 'Field required', q));
    return;
  }
  const type = q.type;
  if (typeof type !== 'string' || !(profile === 'systemone' ? SYSTEMONE_TYPES : DECIDE_TYPES).has(type)) {
    deferred.push(withReason(localError(BadRequestError, 'Invalid request.'), `question '${id}': unknown type ${JSON.stringify(type)}`));
    return;
  }
  const loc = [...base, type];
  const instructions = q.instructions;
  if (present(instructions) && !isSdl(instructions)) entries.push(...sdlEntries([...loc, 'instructions'], instructions));
  const criteria = q.criteria;
  if (PLACE_TYPES.has(type)) {
    checkPlace(id, q, loc, entries, deferred, imageIds);
  } else if (type === 'number') {
    if (limits.number_max_grid_values === 0) {
      deferred.push(localError(BadRequestError, `Model ${String(limits.model)} does not answer number questions.`));
      return;
    }
    checkNumber(id, q, loc, entries, deferred, heldNumber(limits, 'number_max_grid_values', MAX_GRID_VALUES));
  } else if (type === 'choice') {
    const most = heldNumber(limits, 'max_choice_options', MAX_CHOICE_OPTIONS);
    if (!present(criteria)) {
      entries.push(entry('missing', [...loc, 'criteria'], 'Field required', q));
    } else if (!isObject(criteria)) {
      entries.push(entry('dict_type', [...loc, 'criteria'], 'Input should be a valid dictionary', criteria));
    } else {
      for (const [name, desc] of Object.entries(criteria)) {
        if (present(desc) && !isSdl(desc)) entries.push(...sdlEntries([...loc, 'criteria', name], desc));
      }
      const n = Object.keys(criteria).length;
      if (n === 0) deferred.push(localError(BadRequestError, `Choice question must have at least one choice: ${id}`, null));
      else if (n > most) deferred.push(localError(BadRequestError, `Too many choices. Must have at most ${most} choices.`, null));
    }
  } else if (type === 'score') {
    const most = heldNumber(limits, 'max_score_levels', MAX_SCORE_LEVELS);
    if (!present(criteria)) {
      entries.push(entry('missing', [...loc, 'criteria'], 'Field required', q));
      return;
    }
    let levels: unknown[];
    if (Array.isArray(criteria)) {
      levels = criteria;
    } else if (isObject(criteria) && profile !== 'systemone' && isIndexKeyed(criteria)) {
      levels = Array.from({ length: Object.keys(criteria).length }, (_, i) => criteria[String(i)]);
    } else {
      entries.push(entry('list_type', [...loc, 'criteria'], 'Input should be a valid list', criteria));
      return;
    }
    if (levels.length === 0) {
      entries.push(entry('too_short', [...loc, 'criteria'], 'List should have at least 1 item after validation, not 0', criteria));
      return;
    }
    levels.forEach((level, i) => {
      if (!isSdl(level)) entries.push(...sdlEntries([...loc, 'criteria', i], level));
    });
    if (levels.length > most) deferred.push(localError(BadRequestError, `Too many score levels. Must have at most ${most} levels.`, null));
  } else {
    // truth, and the same question under its older wire name
    if (present(criteria) && !isObject(criteria)) {
      entries.push(entry('dict_type', [...loc, 'criteria'], 'Input should be a valid dictionary', criteria));
      return;
    }
    const crit = (criteria ?? {}) as Record<string, unknown>;
    for (const side of ['true', 'false']) {
      if (present(crit[side]) && !isSdl(crit[side])) entries.push(...sdlEntries([...loc, 'criteria', side], crit[side]));
    }
    if (!present(instructions) && !present(crit.true) && !present(crit.false)) {
      const name = type === LEGACY_TRUTH ? 'Noul' : 'Truth';
      deferred.push(localError(BadRequestError, `${name} question must have criteria or instructions: ${id}`, null));
    }
  }
}

/**
 * Every fixed rule of a request body, in the server's order: the nesting
 * limit, then every 422 entry (the state, each question), then the first 400
 * in question order. `extra` are 422 entries found before (a session's fields).
 * `imageIds` are the request's image ids, for the point and box rules; `null`
 * where the request carries no images of its own.
 */
export function checkRequest(
  body: Record<string, unknown>,
  profile: Profile = 'decide',
  limits: HeldLimits = {},
  extra: Entry[] = [],
  imageIds: readonly unknown[] | null = null,
): void {
  checkNesting(body);
  const entries: Entry[] = [...extra];
  const deferred: Error[] = [];
  const state = body.state;
  if (present(state) && !isSdl(state)) entries.push(...sdlEntries(['body', 'state'], state));
  const questions = isObject(body.questions) ? body.questions : {};
  for (const [id, q] of Object.entries(questions)) checkQuestion(id, q, entries, deferred, profile, limits, imageIds);
  if (entries.length > 0) throw localValidation(entries);
  if (deferred.length > 0) throw deferred[0]!;
}

/** The questions alone, as on `/v1/decide`. */
export function checkQuestions(questions: Record<string, unknown>, profile: Profile = 'decide', limits: HeldLimits = {}): void {
  checkRequest({ questions }, profile, limits);
}

/**
 * A session's fixed part: `window` 1 to 64 and `ttl_seconds` 1 to 3,600 (a held
 * `sessions.max_window` or `max_ttl_seconds` replaces the bound), whole numbers;
 * `instructions` and `state` of the three types; every question rule; and a
 * model the client knows serves no sessions.
 */
export function checkSessionOpen(body: Record<string, unknown>, limits: HeldLimits = {}): void {
  checkNesting(body);
  const sessions = isObject(limits.sessions) ? limits.sessions : {};
  const entries: Entry[] = [];
  for (const name of ['instructions', 'state']) {
    const v = body[name];
    if (present(v) && !isSdl(v)) entries.push(...sdlEntries(['body', name], v));
  }
  const bounds: Array<[string, number]> = [
    ['window', heldNumber(sessions, 'max_window', MAX_WINDOW)],
    ['ttl_seconds', heldNumber(sessions, 'max_ttl_seconds', MAX_TTL_SECONDS)],
  ];
  for (const [name, hi] of bounds) {
    const v = body[name];
    if (!present(v)) continue;
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      entries.push(entry('int_type', ['body', name], 'Input should be a valid integer', v));
    } else if (v < 1) {
      entries.push(entry('greater_than_equal', ['body', name], 'Input should be greater than or equal to 1', v, { ge: 1 }));
    } else if (v > hi) {
      entries.push(entry('less_than_equal', ['body', name], `Input should be less than or equal to ${hi}`, v, { le: hi }));
    }
  }
  checkRequest({ questions: body.questions }, 'decide', limits, entries);
  if (sessions.enabled === false) {
    throw localError(BadRequestError, `Model ${String(limits.model)} does not serve sessions.`);
  }
}
