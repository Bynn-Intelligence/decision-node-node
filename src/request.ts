/**
 * Builds a decision body: the local checks first (questions, then images),
 * then the body serialised once, so a request the API would refuse is refused
 * here with nothing sent. Images are placed later, per send.
 */
import { checkRequest, entry, heldNumber, type Entry, type HeldLimits, type Profile } from './checks.js';
import { Image, MAX_IMAGES } from './image.js';
import { MAX_VIDEOS } from './video.js';
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
  checkRequest(probe, profile, limits, [], imageIds, countEntries(images ?? [], wires, limits));
  const plan = await placer.check(images, limits);
  checkVideos(wires, images);
  return { head: serialise(wires.length > 0 ? { ...fields, videos: wires } : fields), plan };
}

/** The image limit: the held `/v1/models` entry's `max_images`, else its `images.max_images`, else 16. */
export function maxImages(limits: HeldLimits): number {
  const nested = limits.images !== null && typeof limits.images === 'object' ? (limits.images as Record<string, unknown>) : {};
  return heldNumber(limits, 'max_images', heldNumber(nested, 'max_images', MAX_IMAGES));
}

/** An image as a 422 entry's `input` lists it: its wire form, a local image's bytes left out. */
function imageInput(img: unknown): unknown {
  if (!(img instanceof Image)) return img;
  if (img.url !== undefined || img.uploadId !== undefined) return img.referenceWire();
  return img.mediaType === undefined ? { id: img.id } : { id: img.id, media_type: img.mediaType };
}

/**
 * More images or videos than a request takes: the API's 422 `too_long` on
 * `["body", "images"]` or `["body", "videos"]`. `videos` are in wire form.
 */
export function countEntries(images: readonly unknown[], videos: readonly unknown[], limits: HeldLimits): Entry[] {
  const out: Entry[] = [];
  const lists: Array<[string, readonly unknown[], number]> = [
    ['images', images, maxImages(limits)],
    ['videos', videos, MAX_VIDEOS],
  ];
  for (const [name, items, most] of lists) {
    if (items.length > most) {
      const input = name === 'images' ? items.map(imageInput) : [...items];
      out.push(
        entry('too_long', ['body', name], `List should have at most ${most} items after validation, not ${items.length}`, input, {
          field_type: 'List',
          max_length: most,
          actual_length: items.length,
        }),
      );
    }
  }
  return out;
}

/** The body with its images added after the other fields. */
export function withImages(head: string, wires: readonly WireImage[] | null): string {
  if (wires === null || wires.length === 0) return head;
  const images = serialise(wires);
  return head === '{}' ? `{"images":${images}}` : `${head.slice(0, -1)},"images":${images}}`;
}
