/**
 * Builds a decision body: the local checks first (questions, then images),
 * then the body serialised once, so a request the API would refuse is refused
 * here with nothing sent. Images are placed later, per send.
 */
import { boostersWire } from './boosters.js';
import { checkRequest, entry, heldNumber, type Entry, type HeldLimits } from './checks.js';
import { RequestTooLargeError } from './errors.js';
import { Image, MAX_IMAGES } from './image.js';
import { MAX_VIDEOS } from './video.js';
import { serialise } from './transport.js';
import type { ImagePlacer, ImageInput, ImagePlan } from './uploads.js';
import type { WireImage } from './image.js';
import { checkVideos, videoWires, type VideoInput } from './video.js';

/** The API's request body limit in bytes, 25 MiB. */
const MAX_BODY_BYTES = 26_214_400;

const BODY_TOO_LARGE =
  'The request body is over 26,214,400 bytes (25 MiB). Send large images as uploads (POST /v1/uploads) and name them by upload_id.';

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
 * `videos`, which are sent after the other fields (frames always inline), then
 * `boosters`, sent as given (none, or an empty list, leaves the key out), then
 * `fallback`, sent only when given.
 */
export async function prepare(
  placer: ImagePlacer,
  fields: Record<string, unknown>,
  images: readonly ImageInput[] | null | undefined,
  limits: HeldLimits = {},
  videos?: readonly VideoInput[] | null,
  boosters?: unknown,
  fallback?: unknown,
): Promise<Prepared> {
  checkQuestionMap(fields.questions);
  if (fallback !== undefined && fallback !== null && typeof fallback !== 'boolean') {
    throw new TypeError(`fallback must be true or false, got ${typeof fallback}`);
  }
  const wires = videoWires(videos);
  const tail: Record<string, unknown> = {};
  if (wires.length > 0) tail.videos = wires;
  const boosterWire = boostersWire(boosters);
  if (boosterWire !== undefined) tail.boosters = boosterWire;
  if (typeof fallback === 'boolean') tail.fallback = fallback;
  // The images and videos count toward the nesting limit as the objects they will be, the boosters as sent.
  let probe = Array.isArray(images) && images.length > 0 ? { ...fields, images: images.map(() => ({ id: '' })) } : fields;
  if (wires.length > 0) probe = { ...probe, videos: wires.map(() => ({ id: '' })) };
  if (boosterWire !== undefined) probe = { ...probe, boosters: boosterWire };
  // The request's image ids as given, for the point and box rules.
  const imageIds = Array.isArray(images) ? images.map((img) => (img !== null && typeof img === 'object' ? (img as { id?: unknown }).id : undefined)) : [];
  checkRequest(probe, limits, [], imageIds, countEntries(images ?? [], wires, limits));
  const plan = await placer.check(images, limits);
  checkVideos(wires, images);
  const head = serialise({ ...fields, ...tail });
  checkBodySize(withImages(head, plan === null ? null : await placer.project(plan)));
  return { head, plan };
}

/**
 * The body as it would be sent, against the API's 25 MiB: over it, the API's
 * `RequestTooLargeError`, raised before anything is sent or uploaded.
 */
function checkBodySize(body: string): void {
  // Each character is 1 to 3 bytes in UTF-8 (a surrogate pair 4 for 2), so most bodies need no count.
  if (body.length * 3 <= MAX_BODY_BYTES) return;
  const size = utf8Length(body);
  if (size > MAX_BODY_BYTES) {
    throw new RequestTooLargeError(BODY_TOO_LARGE, {
      errorType: 'request_too_large_error',
      reason: `the body is ${size} bytes; the limit is ${MAX_BODY_BYTES}`,
    });
  }
}

/** The length of the text in UTF-8, as it goes on the wire. */
function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
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
