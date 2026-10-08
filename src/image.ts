import { BadRequestError, localError } from './errors.js';

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

/** The wire form of an image in a request. */
export type WireImage =
  | { id: string; media_type: string; data: string }
  | { id: string; url: string; media_type?: string }
  | { id: string; upload_id: string; media_type?: string };

export type ImageBytes = Uint8Array | ArrayBuffer | Blob;

export type ImageSource =
  | { id: string; path: string }
  | { id: string; data: ImageBytes; mediaType?: ImageMediaType | string }
  | { id: string; base64: string; mediaType?: ImageMediaType | string }
  | { id: string; url: string; mediaType?: ImageMediaType | string }
  | { id: string; uploadId: string; mediaType?: ImageMediaType | string };

/** The most images one request, session frame or batch line takes. */
export const MAX_IMAGES = 4;
/** The most bytes one image may have: 10 MiB. */
export const MAX_IMAGE_BYTES = 10_485_760;
/** The most pixels one image may have, read from its header. */
export const MAX_IMAGE_PIXELS = 40_000_000;
/** The longest image URL, in characters. */
export const MAX_IMAGE_URL_CHARS = 2048;

/** Reads the media type from a file's first bytes: JPEG, PNG or WebP, else `null`. */
export function sniffMediaType(bytes: Uint8Array): ImageMediaType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  return null;
}

function ascii(bytes: Uint8Array, at: number, n: number): string {
  let s = '';
  for (let i = at; i < at + n && i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

const be16 = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const be32 = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
const le16 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const le24 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);

/** JPEG start-of-frame markers: every SOFn except DHT (C4), JPG (C8) and DAC (CC). */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * Width and height in pixels, read from the image's header without decoding
 * it: a JPEG's start-of-frame segment, a PNG's IHDR chunk, or a WebP's VP8,
 * VP8L or VP8X chunk. `null` when the header cannot be read.
 */
export function imageDimensions(bytes: Uint8Array, mediaType: string): { width: number; height: number } | null {
  if (mediaType === 'image/png') {
    if (bytes.length < 24 || ascii(bytes, 12, 4) !== 'IHDR') return null;
    return { width: be32(bytes, 16), height: be32(bytes, 20) };
  }
  if (mediaType === 'image/jpeg') {
    let i = 2;
    while (i + 3 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1]!;
      if (marker === 0xff) {
        i += 1; // a fill byte before a marker
        continue;
      }
      if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2; // a marker without a length
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return null; // end of image or scan data before any frame header
      const length = be16(bytes, i + 2);
      if (length < 2) return null;
      if (isStartOfFrame(marker)) {
        if (i + 9 > bytes.length) return null;
        return { width: be16(bytes, i + 7), height: be16(bytes, i + 5) };
      }
      i += 2 + length;
    }
    return null;
  }
  if (mediaType === 'image/webp') {
    if (bytes.length < 30) return null;
    const chunk = ascii(bytes, 12, 4);
    if (chunk === 'VP8 ') {
      // A key frame: the 3-byte frame tag, the start code 9d 01 2a, then 14-bit sizes.
      if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
      return { width: le16(bytes, 26) & 0x3fff, height: le16(bytes, 28) & 0x3fff };
    }
    if (chunk === 'VP8L') {
      if (bytes[20] !== 0x2f) return null;
      const bits = (bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)) >>> 0;
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
      return { width: le24(bytes, 24) + 1, height: le24(bytes, 27) + 1 };
    }
  }
  return null;
}

const B64_CHARS = /^[A-Za-z0-9+/]*={0,2}$/;

/** Base64 without a Node dependency; uses Buffer when present. */
export function toBase64(bytes: Uint8Array): string {
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(bytes).toString('base64');
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Bytes from standard base64 text (padding optional, whitespace ignored); `null` when it is not base64. */
export function fromBase64(text: string): Uint8Array | null {
  const clean = text.replace(/\s+/g, '');
  if (clean.length % 4 === 1 || !B64_CHARS.test(clean)) return null;
  const B = (globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer;
  if (B) return new Uint8Array(B.from(clean, 'base64'));
  try {
    const binary = atob(clean.padEnd(clean.length + ((4 - (clean.length % 4)) % 4), '='));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

type ReadFileSync = (path: string) => Uint8Array;

/** A synchronous file reader: Node and Bun through `node:fs`, Deno through `Deno.readFileSync`. */
function readFileSyncFn(): ReadFileSync | undefined {
  const g = globalThis as {
    process?: { getBuiltinModule?: (id: string) => unknown };
    Deno?: { readFileSync?: ReadFileSync };
  };
  const fs = g.process?.getBuiltinModule?.('node:fs') as { readFileSync: ReadFileSync } | undefined;
  if (fs) return (path) => fs.readFileSync(path);
  if (typeof g.Deno?.readFileSync === 'function') return (path) => g.Deno!.readFileSync!(path);
  return undefined;
}

function isBlob(data: unknown): data is Blob {
  return typeof Blob !== 'undefined' && data instanceof Blob;
}

/** An image's bytes after the local checks. */
export interface LocalImage {
  id: string;
  bytes: Uint8Array;
  mediaType: ImageMediaType;
  /** True when the SDK holds its own copy of the bytes, so values derived from them may be kept. */
  owned: boolean;
  image: Image;
}

/**
 * An image sent beside the state. Every question in the request sees every image.
 *
 * ```ts
 * Image.fromUrl('scan', 'https://example.com/scan.webp'); // recommended: nothing is uploaded
 * Image.fromPath('receipt', './receipt.jpg');
 * Image.fromBytes('photo', bytes);                       // media type read from the bytes
 * Image.fromBase64('photo', base64Text);
 * Image.fromUploadId('photo', 'upl_...');                // an earlier upload
 * ```
 *
 * A path is read when the `Image` is made, so an unreadable file throws a
 * `TypeError` there. Local bytes are checked before any request is sent: JPEG,
 * PNG or WebP by their first bytes (a given media type must match them), at
 * most 10 MiB, at most 40 megapixels by the image header. A fault raises
 * `BadRequestError`, as the API would, with nothing sent. Small images go
 * inline as base64; larger ones are uploaded (see the client's `inlineThreshold`).
 */
export class Image {
  readonly id: string;
  readonly path: string | undefined;
  readonly data: ImageBytes | undefined;
  /** The declared media type, or the one read from a file's first bytes. */
  readonly mediaType: string | undefined;
  readonly url: string | undefined;
  readonly uploadId: string | undefined;
  readonly #declared: string | undefined;
  readonly #base64: string | undefined;
  #checked: Promise<LocalImage> | undefined;

  constructor(source: ImageSource) {
    if (source === null || typeof source !== 'object' || typeof source.id !== 'string') {
      throw new TypeError('an image needs a string id');
    }
    this.id = source.id;
    const declared = 'mediaType' in source && source.mediaType ? source.mediaType : undefined;
    if ('path' in source && source.path !== undefined) {
      this.path = source.path;
      const read = readFileSyncFn();
      if (read === undefined) {
        throw new TypeError(`image '${source.id}': this runtime has no file system; pass the bytes instead`);
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(read(source.path));
      } catch (cause) {
        throw new TypeError(`image '${source.id}': cannot read ${source.path}`, { cause });
      }
      this.data = bytes;
      this.mediaType = sniffMediaType(bytes) ?? undefined;
    } else if ('url' in source && source.url !== undefined) {
      if (typeof source.url !== 'string') throw new TypeError(`image '${source.id}': url must be a string`);
      this.url = source.url;
      this.mediaType = declared;
    } else if ('uploadId' in source && source.uploadId !== undefined) {
      if (typeof source.uploadId !== 'string') throw new TypeError(`image '${source.id}': uploadId must be a string`);
      this.uploadId = source.uploadId;
      this.mediaType = declared;
    } else if ('base64' in source && source.base64 !== undefined) {
      if (typeof source.base64 !== 'string') throw new TypeError(`image '${source.id}': base64 must be a string`);
      this.#base64 = source.base64;
      this.#declared = declared;
      this.mediaType = declared;
    } else if ('data' in source && source.data !== undefined) {
      const data = source.data;
      if (!(data instanceof Uint8Array) && !(data instanceof ArrayBuffer) && !isBlob(data)) {
        throw new TypeError(`image '${source.id}': data must be a Uint8Array, an ArrayBuffer or a Blob`);
      }
      this.data = data;
      this.#declared = declared;
      if (declared !== undefined) this.mediaType = declared;
      else if (!isBlob(data)) this.mediaType = sniffMediaType(data instanceof ArrayBuffer ? new Uint8Array(data) : data) ?? undefined;
    } else {
      throw new TypeError(`image '${source.id}' needs a path, data, base64, a url or an uploadId`);
    }
  }

  /** An image read from a file, now. Its media type is taken from its first bytes. */
  static fromPath(id: string, path: string): Image {
    return new Image({ id, path });
  }

  /** An image from bytes. Without a media type it is read from the bytes. */
  static fromBytes(id: string, data: ImageBytes, mediaType?: ImageMediaType | string): Image {
    return new Image(mediaType === undefined ? { id, data } : { id, data, mediaType });
  }

  /** An image from base64 text (no `data:` prefix). */
  static fromBase64(id: string, base64: string, mediaType?: ImageMediaType | string): Image {
    return new Image(mediaType === undefined ? { id, base64 } : { id, base64, mediaType });
  }

  /** An image the server fetches itself: `https`, at most 2,048 characters. The fastest input. */
  static fromUrl(id: string, url: string, mediaType?: ImageMediaType | string): Image {
    return new Image(mediaType === undefined ? { id, url } : { id, url, mediaType });
  }

  /** An image uploaded before, named by its `upload_id`. */
  static fromUploadId(id: string, uploadId: string, mediaType?: ImageMediaType | string): Image {
    return new Image(mediaType === undefined ? { id, uploadId } : { id, uploadId, mediaType });
  }

  /** True when the image is bytes held on this side (a file, bytes or base64). */
  get isLocal(): boolean {
    return this.url === undefined && this.uploadId === undefined;
  }

  /**
   * The bytes after the local checks: a known format matching any declared
   * type, at most 10 MiB, at most 40 megapixels. A fault is a `BadRequestError`.
   * Kept once checked when the SDK holds its own copy of the bytes.
   */
  checkLocal(): Promise<LocalImage> {
    const owned = this.path !== undefined || this.#base64 !== undefined || isBlob(this.data);
    if (owned && this.#checked) return this.#checked;
    const checked = this.#check(owned);
    if (owned) {
      this.#checked = checked;
      // A failed check is not kept: the next call reports it again.
      checked.catch(() => {
        this.#checked = undefined;
      });
    }
    return checked;
  }

  async #check(owned: boolean): Promise<LocalImage> {
    let bytes: Uint8Array;
    if (this.#base64 !== undefined) {
      const decoded = fromBase64(this.#base64);
      if (decoded === null) throw localError(BadRequestError, `Image ${this.id}: the data is not valid base64.`);
      bytes = decoded;
    } else {
      const data = this.data!;
      if (data instanceof Uint8Array) bytes = data;
      else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else bytes = new Uint8Array(await data.arrayBuffer());
    }
    return checkImageBytes(this, bytes, this.path === undefined ? this.#declared : undefined, owned);
  }

  /** The wire form of an image that is not local bytes. */
  referenceWire(): WireImage {
    if (this.url !== undefined) {
      return this.mediaType ? { id: this.id, url: this.url, media_type: this.mediaType } : { id: this.id, url: this.url };
    }
    if (this.uploadId !== undefined) {
      return this.mediaType
        ? { id: this.id, upload_id: this.uploadId, media_type: this.mediaType }
        : { id: this.id, upload_id: this.uploadId };
    }
    throw new TypeError(`image '${this.id}' holds bytes`);
  }
}

function checkImageBytes(image: Image, bytes: Uint8Array, declared: string | undefined, owned: boolean): LocalImage {
  const id = image.id;
  const found = sniffMediaType(bytes);
  if (found === null) throw localError(BadRequestError, `Image ${id} is not a JPEG, PNG or WebP image.`);
  if (declared !== undefined && declared !== found) {
    throw localError(BadRequestError, `Image ${id} could not be decoded as ${declared}.`);
  }
  if (bytes.length > MAX_IMAGE_BYTES) throw localError(BadRequestError, `Image ${id} is larger than 10 MB.`);
  const dims = imageDimensions(bytes, found);
  if (dims === null) throw localError(BadRequestError, `Image ${id}: its header cannot be read.`);
  if (dims.width * dims.height > MAX_IMAGE_PIXELS) {
    throw localError(BadRequestError, `Image ${id} is ${dims.width}x${dims.height} pixels, over 40 megapixels.`);
  }
  return { id, bytes, mediaType: found, owned, image };
}

/** A `BadRequestError` unless the URL is `https` and at most 2,048 characters. */
export function checkImageUrl(id: string, url: string): void {
  let ok = url.length <= MAX_IMAGE_URL_CHARS;
  if (ok) {
    try {
      ok = new URL(url).protocol === 'https:';
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    throw localError(BadRequestError, `Image ${id}: only https URLs of at most ${MAX_IMAGE_URL_CHARS} characters are accepted.`);
  }
}
