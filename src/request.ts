/**
 * Builds a decision body: the local checks first (questions, then images),
 * then the body serialised once, so a request the API would refuse is refused
 * here with nothing sent. Images are placed later, per send.
 */
import { checkQuestions } from './checks.js';
import { serialise } from './transport.js';
import type { ImagePlacer, ImageInput, ImagePlan } from './uploads.js';
import type { WireImage } from './image.js';

export interface Prepared {
  /** The body without `images`, as JSON text. */
  head: string;
  plan: ImagePlan | null;
}

/** The questions object after the argument check: a non-empty map. */
export function checkQuestionMap(questions: unknown): Record<string, unknown> {
  if (questions === null || typeof questions !== 'object' || Array.isArray(questions) || Object.keys(questions).length === 0) {
    throw new TypeError('questions must hold at least one question');
  }
  return questions as Record<string, unknown>;
}

/**
 * Checks and serialises one request. `fields` are the body's fields in order,
 * `questions` among them; `images` are checked after the questions.
 */
export async function prepare(
  placer: ImagePlacer,
  fields: Record<string, unknown>,
  images: readonly ImageInput[] | null | undefined,
): Promise<Prepared> {
  checkQuestions(checkQuestionMap(fields.questions));
  const plan = await placer.check(images);
  return { head: serialise(fields), plan };
}

/** The body with its images added after the other fields. */
export function withImages(head: string, wires: readonly WireImage[] | null): string {
  if (wires === null || wires.length === 0) return head;
  const images = serialise(wires);
  return head === '{}' ? `{"images":${images}}` : `${head.slice(0, -1)},"images":${images}}`;
}
