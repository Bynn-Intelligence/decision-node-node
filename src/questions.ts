/**
 * Question builders. Each returns the wire form of one question, so a plain
 * object copied from the API reference works anywhere a builder does.
 */

/** A yes-or-no question, answered with the probability that the statement is true. */
export interface TruthQuestion {
  type: 'truth';
  instructions?: unknown;
  criteria?: { true?: unknown; false?: unknown } | null;
}

/** Pick exactly one option. `O` is the union of the option names. */
export interface ChoiceQuestion<O extends string = string> {
  type: 'choice';
  instructions?: unknown;
  criteria: { readonly [K in O]: unknown };
}

/** Place the state on an ordered scale, levels low to high. */
export interface ScoreQuestion {
  type: 'score';
  instructions?: unknown;
  criteria: readonly unknown[] | { readonly [index: string]: unknown };
}

/**
 * A value read from an ordered grid: `min` to `max` in steps of `step`. A
 * field left out takes the server's default (0, 255 and 1).
 */
export interface NumberQuestion {
  type: 'number';
  instructions?: unknown;
  min?: number;
  max?: number;
  step?: number;
}

/** A question of a type this SDK version does not know, sent as given. */
export interface OtherQuestion {
  type: string;
  [field: string]: unknown;
}

export type Question = TruthQuestion | ChoiceQuestion<string> | ScoreQuestion | NumberQuestion | OtherQuestion;

/** Questions by id. The id is yours: it comes back as the answer's key, unchanged. */
export type Questions = { readonly [id: string]: Question };

/**
 * A yes-or-no question.
 *
 * @param instructions What to decide: a question, a statement to judge, or any JSON value.
 * @param ifTrue What a yes means (optional).
 * @param ifFalse What a no means (optional).
 */
export function truth(instructions?: unknown, ifTrue?: unknown, ifFalse?: unknown): TruthQuestion {
  const q: TruthQuestion = { type: 'truth' };
  if (instructions !== undefined && instructions !== null) q.instructions = instructions;
  const criteria: { true?: unknown; false?: unknown } = {};
  let any = false;
  if (ifTrue !== undefined && ifTrue !== null) {
    criteria.true = ifTrue;
    any = true;
  }
  if (ifFalse !== undefined && ifFalse !== null) {
    criteria.false = ifFalse;
    any = true;
  }
  if (any) q.criteria = criteria;
  return q;
}

/**
 * Pick one option.
 *
 * @param instructions What to decide.
 * @param options A map of option name to description, or a list of names
 *   (each sent with a `null` description). Names are sent and returned byte for byte.
 */
export function choice<const O extends string>(instructions: unknown, options: readonly O[]): ChoiceQuestion<O>;
export function choice<const C extends { readonly [name: string]: unknown }>(
  instructions: unknown,
  options: C,
): ChoiceQuestion<keyof C & string>;
export function choice(
  instructions: unknown,
  options: readonly string[] | { readonly [name: string]: unknown },
): ChoiceQuestion<string> {
  const criteria = Array.isArray(options)
    ? Object.fromEntries((options as readonly string[]).map((name) => [name, null]))
    : Object.fromEntries(Object.entries(options ?? {}));
  if (instructions !== undefined && instructions !== null) {
    return { type: 'choice', instructions, criteria };
  }
  return { type: 'choice', criteria };
}

/**
 * Place the state on an ordered scale.
 *
 * @param instructions What to measure.
 * @param levels The levels, low to high (1 to 10). Each is a string or any JSON value.
 */
export function score(instructions: unknown, levels: readonly unknown[]): ScoreQuestion {
  const criteria = [...(levels ?? [])];
  if (instructions !== undefined && instructions !== null) {
    return { type: 'score', instructions, criteria };
  }
  return { type: 'score', criteria };
}

/**
 * A value read from an ordered grid of numbers.
 *
 * @param instructions What to count or read. Required by the API.
 * @param min The lowest value (default 0 on the server).
 * @param max The highest value the grid may reach (default 255).
 * @param step The spacing, above 0 (default 1).
 *
 * An argument left out is left out of the wire form, so the server's default applies.
 */
export function number(instructions: unknown, min?: number | null, max?: number | null, step?: number | null): NumberQuestion {
  const q: NumberQuestion = { type: 'number' };
  if (instructions !== undefined && instructions !== null) q.instructions = instructions;
  if (min !== undefined && min !== null) q.min = min;
  if (max !== undefined && max !== null) q.max = max;
  if (step !== undefined && step !== null) q.step = step;
  return q;
}
