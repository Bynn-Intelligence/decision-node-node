/**
 * The API's fixed request rules, checked before anything is sent, so a request
 * the server would refuse never leaves the process. Token limits depend on the
 * model version and stay the server's to judge.
 */
import { BadRequestError, ValidationError, localError } from './errors.js';

/** The most options a `choice` question takes. */
export const MAX_CHOICE_OPTIONS = 255;
/** The most levels a `score` question takes. */
export const MAX_SCORE_LEVELS = 10;
/** The most values a `number` grid may hold. */
export const MAX_GRID_VALUES = 4096;

const LEGACY_TRUTH = 'noul';

interface Decimal {
  /** The value times 10^scale, exact. */
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

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * The number of values in a `number` question's grid, built in exact decimals
 * as the server builds it, or the fault the server answers `422` for.
 */
export function gridSize(q: { min?: unknown; max?: unknown; step?: unknown }): { size: number } | { fault: string } {
  const pick = (v: unknown, dflt: number) => (v === undefined || v === null ? dflt : v);
  const lo = pick(q.min, 0);
  const hi = pick(q.max, 255);
  const step = pick(q.step, 1);
  if (!isNumber(lo) || !isNumber(hi) || !isNumber(step)) return { fault: 'min, max and step must be numbers' };
  if (!(step > 0)) return { fault: `step must be above 0, got ${step}` };
  if (lo > hi) return { fault: `min ${lo} is above max ${hi}` };
  const m = toDecimal(lo);
  const s = toDecimal(step);
  const d = Math.max(m.scale, s.scale);
  const n = (scaled(toDecimal(hi), d) - scaled(m, d)) / scaled(s, d) + 1n;
  return { size: Number(n) };
}

function present(v: unknown): boolean {
  return v !== undefined && v !== null;
}

/**
 * Checks every question against the API's fixed rules: a choice of 1 to 255
 * options, a score of 1 to 10 levels, a truth with instructions or criteria,
 * a number with instructions and a grid of at most 4,096 values with `step`
 * above 0 and `min` at most `max`. A fault raises the API's own class:
 * `BadRequestError`, or `ValidationError` where the API answers `422`.
 */
export function checkQuestions(questions: Record<string, unknown>): void {
  for (const [id, q] of Object.entries(questions)) {
    if (q === null || typeof q !== 'object' || Array.isArray(q)) continue;
    const question = q as Record<string, unknown>;
    const type = question.type;
    const criteria = question.criteria;
    if (type === 'choice' && criteria !== null && typeof criteria === 'object' && !Array.isArray(criteria)) {
      const n = Object.keys(criteria).length;
      if (n === 0) throw localError(BadRequestError, `Choice question must have at least one choice: ${id}`, null);
      if (n > MAX_CHOICE_OPTIONS) {
        throw localError(BadRequestError, `Too many choices. Must have at most ${MAX_CHOICE_OPTIONS} choices.`, null);
      }
    } else if (type === 'score' && criteria !== null && typeof criteria === 'object') {
      const n = Array.isArray(criteria) ? criteria.length : Object.keys(criteria).length;
      if (n === 0) throw localError(ValidationError, `question ${id}: a score needs at least one level`, null);
      if (n > MAX_SCORE_LEVELS) {
        throw localError(BadRequestError, `Too many score levels. Must have at most ${MAX_SCORE_LEVELS} levels.`, null);
      }
    } else if (type === 'truth' || type === LEGACY_TRUTH) {
      const c = criteria !== null && typeof criteria === 'object' && !Array.isArray(criteria) ? (criteria as Record<string, unknown>) : {};
      if (!present(question.instructions) && !present(c.true) && !present(c.false)) {
        throw localError(BadRequestError, `Truth question must have criteria or instructions: ${id}`, null);
      }
    } else if (type === 'number') {
      const grid = gridSize(question);
      if ('fault' in grid) throw localError(ValidationError, `question ${id}: ${grid.fault}`, null);
      if (grid.size > MAX_GRID_VALUES) {
        throw localError(
          ValidationError,
          `question ${id}: the grid holds ${grid.size} values, the limit is ${MAX_GRID_VALUES}`,
          null,
        );
      }
      if (!present(question.instructions) || question.instructions === '') {
        throw localError(BadRequestError, `Number question must have instructions: ${id}`, null);
      }
    }
  }
}
