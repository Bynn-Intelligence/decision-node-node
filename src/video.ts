/**
 * Videos sent as frames: the frames the caller sampled, each with its time.
 * The API reads the frames of a video as one video, in order and with their
 * times. Only frames are sent, inline as base64: never a video file, a URL or
 * sound, and a frame is never uploaded, resized or re-encoded. The checks here
 * need no decoding; frame counts, a frame's bytes, sizes and pixels, the
 * window and the token budget are the server's.
 */
import { BadRequestError, localError } from './errors.js';
import { Image, sniffMediaType, toBase64 } from './image.js';

/** The most videos one request takes. */
export const MAX_VIDEOS = 4;
/** The highest `fps` a video may ask for. */
export const MAX_VIDEO_FPS = 4;

const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** The wire form of one frame of a video. */
export interface WireVideoFrame {
  t: number;
  media_type: string;
  data: string;
}

/** The wire form of a video in a request. */
export interface WireVideo {
  id: string;
  fps?: number;
  start?: number;
  end?: number;
  frames: WireVideoFrame[];
}

/**
 * One frame of a video: its time in seconds and its image.
 *
 * ```ts
 * new VideoFrame(30, jpegBytes);                  // the type read from the bytes
 * new VideoFrame(30.5, 'iVBORw0KGgo...', 'image/png'); // base64 text needs its type
 * ```
 *
 * `t` is at least 0 and larger than the time of the frame before it in the
 * same video; a camera's own clock works.
 */
export class VideoFrame {
  readonly t: number;
  /** `image/jpeg`, `image/png` or `image/webp`: as given, or read from the bytes. */
  readonly mediaType: string | undefined;
  readonly #data: string;

  constructor(t: number, data: Uint8Array | ArrayBuffer | string, mediaType?: string) {
    let declared = mediaType || undefined;
    if (typeof data === 'string') {
      this.#data = data;
    } else if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      declared ??= sniffMediaType(bytes) ?? undefined;
      this.#data = toBase64(bytes);
    } else {
      throw new TypeError('a video frame takes bytes (Uint8Array or ArrayBuffer) or base64 text');
    }
    this.t = t;
    this.mediaType = declared;
  }

  /** The frame as the API takes it. */
  toJSON(): WireVideoFrame {
    return { t: this.t, media_type: this.mediaType as string, data: this.#data };
  }
}

/** A video's optional settings; each is left out of the request when not given. */
export interface VideoOptions {
  /** The most frames a second the API reads: above 0, at most 4 (the API's default is 2). */
  fps?: number | null;
  /** The start of the window read, in seconds on the frames' own times. */
  start?: number | null;
  /** The end of the window read (not included), after `start`. */
  end?: number | null;
}

/**
 * A video every question in the request can see, as the frames you sampled.
 *
 * ```ts
 * new Video('dock', [new VideoFrame(30, f0), new VideoFrame(30.5, f1)], { fps: 2 });
 * ```
 *
 * The id is unique across the request's images and videos. The model sees the
 * video as "Video <n>" (its place in the request's videos, from 1) with this id
 * beside it, so text in the state or the instructions can refer to it by either.
 */
export class Video {
  readonly id: string;
  readonly frames: ReadonlyArray<VideoFrame | WireVideoFrame>;
  readonly fps: number | undefined;
  readonly start: number | undefined;
  readonly end: number | undefined;

  constructor(id: string, frames: ReadonlyArray<VideoFrame | WireVideoFrame>, options: VideoOptions = {}) {
    if (!Array.isArray(frames)) throw new TypeError(`video '${String(id)}': frames must be an array`);
    for (const f of frames) {
      if (f === null || typeof f !== 'object') {
        throw new TypeError(`video '${String(id)}': a frame must be a VideoFrame or a wire-form object`);
      }
    }
    this.id = id;
    this.frames = [...frames];
    this.fps = options.fps ?? undefined;
    this.start = options.start ?? undefined;
    this.end = options.end ?? undefined;
  }

  /** The video as the API takes it, `fps`, `start` and `end` only when given. */
  toJSON(): WireVideo {
    const out: WireVideo = { id: this.id, frames: [] };
    if (this.fps !== undefined) out.fps = this.fps;
    if (this.start !== undefined) out.start = this.start;
    if (this.end !== undefined) out.end = this.end;
    out.frames = this.frames.map((f) => (f instanceof VideoFrame ? f.toJSON() : f));
    return out;
  }
}

/** A video in a request: a `Video`, or a wire-form object sent as given. */
export type VideoInput = Video | WireVideo;

/** The videos argument in wire form; an empty list when none are given. */
export function videoWires(videos: readonly VideoInput[] | null | undefined): Array<Record<string, unknown>> {
  if (videos === undefined || videos === null) return [];
  if (!Array.isArray(videos)) throw new TypeError('videos must be an array');
  return videos.map((v) => {
    if (v instanceof Video) return v.toJSON() as unknown as Record<string, unknown>;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      throw new TypeError('a video must be a Video or a wire-form object');
    }
    return v as unknown as Record<string, unknown>;
  });
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A number as the API writes it in a message: printf's `%g` (six significant digits). */
export function formatG(value: number): string {
  if (value === 0) return '0';
  const exp = Math.floor(Math.log10(Math.abs(value)));
  if (exp < -4 || exp >= 6) {
    const [mant, e] = value.toExponential(5).split('e') as [string, string];
    const m = mant.includes('.') ? mant.replace(/0+$/, '').replace(/\.$/, '') : mant;
    const n = Number(e);
    return `${m}e${n < 0 ? '-' : '+'}${String(Math.abs(n)).padStart(2, '0')}`;
  }
  const fixed = value.toFixed(Math.max(0, 5 - exp));
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

function quoted(id: string): string {
  // The server writes the id as Python's repr of a string.
  return id.includes("'") && !id.includes('"') ? `"${id}"` : `'${id.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Throws what the API would answer for these videos (in wire form), in its
 * order and words: the count, each id (unique across images and videos), each
 * frame's time and media type, `fps` and the window.
 */
export function checkVideos(videos: ReadonlyArray<Record<string, unknown>>, images: readonly unknown[] | null | undefined): void {
  if (videos.length === 0) return;
  const seen = new Set<string>();
  for (const img of images ?? []) {
    const id = img instanceof Image ? img.id : img !== null && typeof img === 'object' ? (img as { id?: unknown }).id : undefined;
    if (typeof id === 'string') seen.add(id);
  }
  for (const [i, video] of videos.entries()) {
    const id = video.id;
    if (typeof id !== 'string' || id === '') throw localError(BadRequestError, `Video ${i} needs an id.`);
    if (seen.has(id)) {
      throw localError(BadRequestError, `Video id ${quoted(id)} is used twice (ids are unique across images and videos).`);
    }
    seen.add(id);
    const refuse = (problem: string) => localError(BadRequestError, `Video ${quoted(id)}: ${problem}.`);
    const frames = video.frames;
    if (!Array.isArray(frames) || frames.length === 0) throw refuse('frames must be a non-empty list of frames');
    let before: number | null = null;
    for (const [n, frame] of frames.entries()) {
      if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
        throw refuse(`frame ${n} must be an object with t, media_type and data`);
      }
      const f = frame as Record<string, unknown>;
      const t = f.t;
      if (!finite(t) || t < 0) throw refuse(`frame ${n}: t must be a number of seconds, at least 0`);
      if (before !== null && t <= before) {
        throw refuse(`frame ${n}: t must be larger than the frame before it (${formatG(before)})`);
      }
      before = t;
      if (typeof f.data !== 'string') throw refuse(`frame ${n}: data must be base64 text`);
      if (typeof f.media_type !== 'string' || !MEDIA_TYPES.includes(f.media_type)) {
        throw refuse(`frame ${n}: media_type must be one of ${MEDIA_TYPES.join(', ')}`);
      }
    }
    const fps = video.fps;
    if (fps !== undefined && fps !== null && (!finite(fps) || !(fps > 0 && fps <= MAX_VIDEO_FPS))) {
      throw refuse(`fps must be a number above 0 and at most ${MAX_VIDEO_FPS}`);
    }
    for (const name of ['start', 'end'] as const) {
      const value = video[name];
      if (value !== undefined && value !== null && (!finite(value) || value < 0)) {
        throw refuse(`${name} must be a number of seconds, at least 0`);
      }
    }
    const end = video.end;
    const start = video.start;
    if (finite(end) && end <= (finite(start) ? start : 0)) throw refuse('end must be after start');
  }
}
