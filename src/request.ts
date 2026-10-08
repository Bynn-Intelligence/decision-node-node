/**
 * Builds a decision body: the local checks first (questions, then images),
 * then the body serialised once, so a request the API would refuse is refused
 * here with nothing sent. Images are placed later, per send.
 */
import { checkRequest, type HeldLimits, type Profile } from './checks.js';
import { serialise } from './transport.js';
import type { ImagePlacer, ImageInput, ImagePlan } from './uploads.js';
import type { WireImage } from './image.js';
import { checkVideos, videoWires, type VideoInput } from './video.js';

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
 * `questions` among them; `images` are checked after the questions, then the
 * `videos`, which are sent after the other fields (frames always inline).
 */
export async function prepare(
  placer: ImagePlacer,
  fields: Record<string, unknown>,
  images: readonly ImageInput[] | null | undefined,
  profile: Profile = 'decide',
  limits: HeldLimits = {},
  videos?: readonly VideoInput[] | null,
): Promise<Prepared> {
  checkQuestionMap(fields.questions);
  const wires = videoWires(videos);
  // The images and videos count toward the nesting limit as the objects they will be.
  let probe = Array.isArray(images) && images.length > 0 ? { ...fields, images: images.map(() => ({ id: '' })) } : fields;
  if (wires.length > 0) probe = { ...probe, videos: wires.map(() => ({ id: '' })) };
  // The request's image ids as given, for the point and box rules.
  const imageIds = Array.isArray(images) ? images.map((img) => (img !== null && typeof img === 'object' ? (img as { id?: unknown }).id : undefined)) : [];
  checkRequest(probe, profile, limits, [], imageIds);
  const plan = await placer.check(images, limits);
  checkVideos(wires, images);
  return { head: serialise(wires.length > 0 ? { ...fields, videos: wires } : fields), plan };
}

/** The body with its images added after the other fields. */
export function withImages(head: string, wires: readonly WireImage[] | null): string {
  if (wires === null || wires.length === 0) return head;
  const images = serialise(wires);
  return head === '{}' ? `{"images":${images}}` : `${head.slice(0, -1)},"images":${images}}`;
}
