export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

/** The wire form of an image in a request. */
export type WireImage = { id: string; media_type: string; data: string } | { id: string; url: string };

export type ImageBytes = Uint8Array | ArrayBuffer | Blob;

export type ImageSource =
  | { id: string; path: string }
  | { id: string; data: ImageBytes; mediaType?: ImageMediaType | string }
  | { id: string; url: string };

/** Reads the media type from a file's first bytes: JPEG, PNG or WebP, else `null`. */
export function sniffMediaType(bytes: Uint8Array): ImageMediaType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return 'image/png';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

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

/**
 * An image sent beside the state. Every question in the request sees every image.
 *
 * ```ts
 * Image.fromPath('receipt', './receipt.jpg');
 * Image.fromBytes('photo', bytes);              // media type read from the bytes
 * Image.fromBytes('photo', bytes, 'image/png');
 * Image.fromUrl('scan', 'https://example.com/scan.webp');
 * ```
 *
 * A path is read when the `Image` is made, and bytes given without a media type
 * are recognised then, from their first bytes (JPEG, PNG or WebP). An unreadable
 * file or an unrecognised format throws a `TypeError` at that point. Reading a
 * path needs a runtime with a file system (Node, Deno, Bun). A `Blob` without a
 * type is recognised when the request is built, before anything is sent.
 */
export class Image {
  readonly id: string;
  readonly path: string | undefined;
  readonly data: ImageBytes | undefined;
  readonly mediaType: string | undefined;
  readonly url: string | undefined;

  constructor(source: ImageSource) {
    this.id = source.id;
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
      const sniffed = sniffMediaType(bytes);
      if (sniffed === null) {
        throw new TypeError(`image '${source.id}': ${source.path} is not a JPEG, PNG or WebP file`);
      }
      this.data = bytes;
      this.mediaType = sniffed;
    } else if ('url' in source && source.url !== undefined) {
      this.url = source.url;
    } else if ('data' in source && source.data !== undefined) {
      const data = source.data;
      this.data = data;
      let mediaType: string | undefined = source.mediaType || undefined;
      if (mediaType === undefined && !isBlob(data)) {
        const sniffed = sniffMediaType(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
        if (sniffed === null) {
          throw new TypeError(`image '${source.id}': the bytes are not a JPEG, PNG or WebP file; pass a media type`);
        }
        mediaType = sniffed;
      }
      this.mediaType = mediaType;
    } else {
      throw new TypeError(`image '${source.id}' needs a path, data or a url`);
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

  /** An image the server fetches itself (`https` only). */
  static fromUrl(id: string, url: string): Image {
    return new Image({ id, url });
  }

  /** The wire form. Reads a `Blob` when needed. */
  async toWire(): Promise<WireImage> {
    if (this.url !== undefined) return { id: this.id, url: this.url };
    const data = this.data!;
    let bytes: Uint8Array;
    if (data instanceof Uint8Array) bytes = data;
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else bytes = new Uint8Array(await data.arrayBuffer());
    let mediaType = this.mediaType;
    if (mediaType === undefined) {
      mediaType = (isBlob(data) && data.type) || sniffMediaType(bytes) || undefined;
      if (mediaType === undefined) {
        throw new TypeError(`image '${this.id}': the bytes are not a JPEG, PNG or WebP file; pass a media type`);
      }
    }
    return { id: this.id, media_type: mediaType, data: toBase64(bytes) };
  }
}

function isBlob(data: unknown): data is Blob {
  return typeof Blob !== 'undefined' && data instanceof Blob;
}
