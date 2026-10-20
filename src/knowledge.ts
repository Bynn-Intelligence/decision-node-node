/**
 * Knowledge: a workspace's own documents, kept in collections of type `text`
 * (a knowledge base), and the `knowledge` booster that gives a decision the
 * passages that apply to it. A `Document` is the content of one text item:
 * text held in memory, or a file (a path, bytes or a stream) that is sent
 * inline when it is small text or Markdown and uploaded otherwise.
 */

import { Booster, type BoosterSettings } from './boosters.js';
import { BadRequestError, localError } from './errors.js';

/** The most bytes one document's file may hold: 50 MB. */
export const MAX_DOCUMENT_BYTES = 52_428_800;

/** The file types a knowledge base takes, in the API's order. */
export const DOCUMENT_CONTENT_TYPES = [
  'text/plain',
  'text/markdown',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/html',
  'image/png',
  'image/jpeg',
  'image/tiff',
  'image/webp',
] as const;

/** A file type a knowledge base takes. */
export type DocumentContentType = (typeof DOCUMENT_CONTENT_TYPES)[number];

/** How a text is read: `markdown` (chunked by its headings, the default) or `text` (by its paragraphs). */
export type DocumentFormat = 'markdown' | 'text';

/** A document's bytes. */
export type DocumentBytes = Uint8Array | ArrayBuffer | Blob;

/** A readable stream: a web `ReadableStream`, or a Node `Readable` or any async iterable of bytes or text. */
export type DocumentStream = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>;

/** What a file document may say about itself. */
export interface DocumentFileOptions {
  /** One of `DOCUMENT_CONTENT_TYPES`. Left out: from the file name's extension, else from the first bytes. */
  contentType?: DocumentContentType | (string & {});
  /** The file's name; a path's base name unless given. Its stem is the default title. */
  filename?: string;
}

/** The ways to make a `Document`. */
export type DocumentSource =
  | { text: string; format?: DocumentFormat | (string & {}) }
  | ({ path: string } & DocumentFileOptions)
  | ({ data: DocumentBytes } & DocumentFileOptions)
  | ({ stream: DocumentStream } & DocumentFileOptions)
  | { uploadId: string };

const EXTENSIONS: Record<string, DocumentContentType> = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  html: 'text/html',
  htm: 'text/html',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
};

const KNOWN_TYPES = new Set<string>(DOCUMENT_CONTENT_TYPES);
const TEXT_TYPES = new Set<string>(['text/plain', 'text/markdown']);

/**
 * One document of a knowledge base.
 *
 * ```ts
 * Document.fromText('# Receipts\n\nReject any claim over 500 SEK without a receipt.');
 * Document.fromPath('./claims-policy-2026.pdf');
 * Document.fromBytes(bytes, { contentType: 'application/pdf', filename: 'policy.pdf' });
 * Document.fromStream(fs.createReadStream('./handbook.docx'), { filename: 'handbook.docx' });
 * Document.fromUploadId('upl_...');                    // from uploadDocuments()
 * ```
 *
 * A path is read when the call is made, not when the `Document` is. A stream
 * is read to its end once, into memory, before anything is sent. Text and
 * Markdown under the client's `inlineThreshold` go inline as the item's text;
 * every other file is uploaded first and named by its upload id.
 */
export class Document {
  readonly text: string | undefined;
  readonly format: string | undefined;
  readonly path: string | undefined;
  readonly data: DocumentBytes | undefined;
  readonly stream: DocumentStream | undefined;
  readonly contentType: string | undefined;
  readonly filename: string | undefined;
  readonly uploadId: string | undefined;

  constructor(source: DocumentSource) {
    if (source === null || typeof source !== 'object') throw new TypeError('a document needs text, a path, data, a stream or an uploadId');
    const file = source as DocumentFileOptions;
    if ('text' in source && source.text !== undefined) {
      if (typeof source.text !== 'string') throw new TypeError('a document text must be a string');
      this.text = source.text;
      this.format = source.format ?? undefined;
      return;
    }
    if ('uploadId' in source && source.uploadId !== undefined) {
      if (typeof source.uploadId !== 'string') throw new TypeError('a document uploadId must be a string');
      this.uploadId = source.uploadId;
      return;
    }
    if ('path' in source && source.path !== undefined) {
      if (typeof source.path !== 'string') throw new TypeError('a document path must be a string');
      this.path = source.path;
    } else if ('data' in source && source.data !== undefined) {
      const data = source.data;
      if (!(data instanceof Uint8Array) && !(data instanceof ArrayBuffer) && !isBlob(data)) {
        throw new TypeError('document data must be a Uint8Array, an ArrayBuffer or a Blob');
      }
      this.data = data;
    } else if ('stream' in source && source.stream !== undefined) {
      if (!isStream(source.stream)) throw new TypeError('a document stream must be a ReadableStream or an async iterable');
      this.stream = source.stream;
    } else {
      throw new TypeError('a document needs text, a path, data, a stream or an uploadId');
    }
    this.contentType = file.contentType ?? undefined;
    this.filename = file.filename ?? undefined;
  }

  /** Text held in memory, `markdown` unless `format` says `text`. */
  static fromText(text: string, format?: DocumentFormat | (string & {})): Document {
    return new Document(format === undefined ? { text } : { text, format });
  }

  /** A local file, read when the call is made. */
  static fromPath(path: string, options: DocumentFileOptions = {}): Document {
    return new Document({ path, ...options });
  }

  /** A file's bytes. */
  static fromBytes(data: DocumentBytes, options: DocumentFileOptions = {}): Document {
    return new Document({ data, ...options });
  }

  /** A readable stream, read to its end once, into memory, before anything is sent. */
  static fromStream(stream: DocumentStream, options: DocumentFileOptions = {}): Document {
    return new Document({ stream, ...options });
  }

  /** A knowledge upload made before (`uploadDocuments`), sent as given. */
  static fromUploadId(uploadId: string): Document {
    return new Document({ uploadId });
  }
}

/** A document in a call: a `Document`, or a Markdown string. */
export type DocumentInput = Document | string;

/** A document ready to send, after it was read and checked. */
export type ResolvedDocument =
  | { kind: 'text'; text: string; format: string | undefined }
  | { kind: 'inline'; text: string; format: DocumentFormat; stem: string | null }
  | { kind: 'file'; bytes: Uint8Array; contentType: string; filename: string | null; stem: string | null }
  | { kind: 'upload'; uploadId: string };

function isBlob(data: unknown): data is Blob {
  return typeof Blob !== 'undefined' && data instanceof Blob;
}

function isStream(v: unknown): v is DocumentStream {
  if (v === null || typeof v !== 'object') return false;
  return typeof (v as ReadableStream).getReader === 'function' || typeof (v as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function';
}

/** A path's last segment, by `/` or `\`. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/** A file name without its last extension; `null` when nothing is left. */
export function stemOf(filename: string | null): string | null {
  if (filename === null) return null;
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  return stem === '' ? null : stem;
}

/** The knowledge type of a file name's extension, case-insensitive. */
export function contentTypeOfName(filename: string | null): DocumentContentType | null {
  if (filename === null) return null;
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return null;
  return EXTENSIONS[filename.slice(dot + 1).toLowerCase()] ?? null;
}

/** The knowledge type of a file's first bytes, for the types that can be told from them. */
export function contentTypeOfBytes(b: Uint8Array): DocumentContentType | null {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (at(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf';
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x49, 0x49, 0x2a, 0x00) || at(0, 0x4d, 0x4d, 0x00, 0x2a)) return 'image/tiff';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

function tooLarge(n: number, index = 0): BadRequestError {
  return localError(BadRequestError, `files[${index}].byte_size: ${n} is over the limit of ${MAX_DOCUMENT_BYTES} bytes.`);
}

function refusedType(contentType: string, index = 0): BadRequestError {
  return localError(BadRequestError, `files[${index}].content_type: must be one of ${DOCUMENT_CONTENT_TYPES.join(', ')}, got ${contentType}.`);
}

function emptyFile(index = 0): BadRequestError {
  return localError(BadRequestError, `files[${index}].byte_size: must be an integer from 1 to ${MAX_DOCUMENT_BYTES}.`);
}

type FsPromises = {
  readFile(path: string): Promise<Uint8Array>;
  stat(path: string): Promise<{ size: number }>;
};

/** An asynchronous file reader: Node and Bun through `node:fs`, Deno through `Deno.readFile`. */
function fileSystem(): FsPromises | undefined {
  const g = globalThis as {
    process?: { getBuiltinModule?: (id: string) => unknown };
    Deno?: { readFile?: (p: string) => Promise<Uint8Array>; stat?: (p: string) => Promise<{ size: number }> };
  };
  const fs = g.process?.getBuiltinModule?.('node:fs') as { promises: FsPromises } | undefined;
  if (fs) return fs.promises;
  const deno = g.Deno;
  if (typeof deno?.readFile === 'function' && typeof deno.stat === 'function') {
    return { readFile: (p) => deno.readFile!(p), stat: (p) => deno.stat!(p) };
  }
  return undefined;
}

async function readPath(path: string, index: number): Promise<Uint8Array> {
  const fs = fileSystem();
  if (fs === undefined) throw new TypeError(`document ${path}: this runtime has no file system; pass the bytes instead`);
  let size: number;
  try {
    size = (await fs.stat(path)).size;
  } catch (cause) {
    throw new TypeError(`document: cannot read ${path}`, { cause });
  }
  // Refused before a byte is read: a file over the limit is never held.
  if (size > MAX_DOCUMENT_BYTES) throw tooLarge(size, index);
  try {
    return new Uint8Array(await fs.readFile(path));
  } catch (cause) {
    throw new TypeError(`document: cannot read ${path}`, { cause });
  }
}

/** A stream read to its end, stopping past the limit. */
async function readStream(stream: DocumentStream, index: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const add = (chunk: Uint8Array | string): boolean => {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    chunks.push(bytes);
    total += bytes.length;
    return total <= MAX_DOCUMENT_BYTES;
  };
  if (typeof (stream as ReadableStream).getReader === 'function') {
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!add(value)) {
          void reader.cancel().catch(() => {});
          throw tooLarge(total, index);
        }
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    for await (const chunk of stream as AsyncIterable<Uint8Array | string>) {
      // Leaving the loop early closes the stream.
      if (!add(chunk)) throw tooLarge(total, index);
    }
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

async function readData(data: DocumentBytes, index: number): Promise<Uint8Array> {
  if (isBlob(data)) {
    if (data.size > MAX_DOCUMENT_BYTES) throw tooLarge(data.size, index);
    return new Uint8Array(await data.arrayBuffer());
  }
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}

/** The text of bytes that decode as UTF-8 and hold no NUL, else `null`. */
function utf8Text(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return text.includes('\u0000') ? null : text;
}

/**
 * Reads a document and runs the file checks that need no network: at most
 * 50 MB, a knowledge type that is given or can be told, not empty. Text and
 * Markdown under `inlineThreshold` that decode as UTF-8 with no NUL go inline;
 * every other file is to be uploaded.
 */
export async function resolveDocument(input: DocumentInput, inlineThreshold: number, index = 0): Promise<ResolvedDocument> {
  const doc = typeof input === 'string' ? Document.fromText(input) : input;
  if (!(doc instanceof Document)) throw new TypeError('a document must be a Document or a string');
  if (doc.text !== undefined) return { kind: 'text', text: doc.text, format: doc.format };
  if (doc.uploadId !== undefined) return { kind: 'upload', uploadId: doc.uploadId };
  let bytes: Uint8Array;
  if (doc.path !== undefined) bytes = await readPath(doc.path, index);
  else if (doc.data !== undefined) bytes = await readData(doc.data, index);
  else bytes = await readStream(doc.stream!, index);
  const filename = doc.filename ?? (doc.path !== undefined ? baseName(doc.path) : null);
  const contentType = doc.contentType ?? contentTypeOfName(filename) ?? contentTypeOfBytes(bytes);
  if (contentType === null) {
    throw new TypeError("the document's type cannot be told from its name or its first bytes: give contentType or filename");
  }
  if (!KNOWN_TYPES.has(contentType)) throw refusedType(contentType, index);
  if (bytes.length === 0) throw emptyFile(index);
  if (bytes.length > MAX_DOCUMENT_BYTES) throw tooLarge(bytes.length, index);
  const stem = stemOf(filename);
  if (TEXT_TYPES.has(contentType) && bytes.length < inlineThreshold) {
    const text = utf8Text(bytes);
    if (text !== null) return { kind: 'inline', text, format: contentType === 'text/markdown' ? 'markdown' : 'text', stem };
  }
  return { kind: 'file', bytes, contentType, filename, stem };
}

/**
 * A document as `uploadDocuments` uploads it: a file as it is, a text as
 * `text/markdown` or `text/plain` by its format.
 */
export async function documentFile(input: DocumentInput, index = 0): Promise<{ bytes: Uint8Array; contentType: string; filename: string | null }> {
  const doc = typeof input === 'string' ? Document.fromText(input) : input;
  if (!(doc instanceof Document)) throw new TypeError('a document must be a Document or a string');
  if (doc.uploadId !== undefined) throw new TypeError('uploadDocuments takes documents to upload, not an upload id');
  if (doc.text !== undefined) {
    const bytes = new TextEncoder().encode(doc.text);
    return { bytes, contentType: doc.format === 'text' ? 'text/plain' : 'text/markdown', filename: null };
  }
  const resolved = await resolveDocument(doc, 0, index);
  if (resolved.kind !== 'file') throw new TypeError('uploadDocuments takes documents to upload');
  return { bytes: resolved.bytes, contentType: resolved.contentType, filename: resolved.filename };
}

// ---------------------------------------------------------------- the booster

/** A metadata condition of `match`: a scalar is equal, an array is any of. */
export type KnowledgeMatch = Record<string, string | number | boolean | ReadonlyArray<string | number | boolean>>;

/** The `knowledge` booster's options, each sent only when given and as given; the API checks them. */
export interface KnowledgeOptions {
  /** Replaces the query built from the request's questions and state; 1 to 2,000 characters. */
  query?: string;
  /** The value of the collection's scope key: the global items and this value's. */
  scope?: string;
  /** Metadata equality: `{ region: 'SE', product: ['car', 'home'] }`. */
  match?: KnowledgeMatch | Record<string, unknown>;
  /** A typed filter tree of `and`, `or` and leaves (`{ key, op, value }` or `{ attr, op, value }`). */
  filter?: Record<string, unknown>;
  /** At most this many retrieved passages, pins not counted; 0 to 20, 0 is pinned only. Default 4. */
  topK?: number;
  /** The retrieved passages' token budget: `'auto'` (the default) or 128 to 8,192. */
  maxTokens?: number | 'auto';
  /** `false` leaves the pinned items out. Default `true`. */
  pinned?: boolean;
  /** A similarity floor, 0 to 1, for passages found by meaning alone. */
  minScore?: number;
  /** Adds each passage's text and the query's text to the reading; needs a full-scope key. */
  includeText?: boolean;
  /**
   * `true`: a reading that did not run fails the request (529
   * `booster_unavailable`, or 409 `knowledge_collection_empty` when nothing is
   * ready or pending). Sent only when true.
   */
  require?: boolean;
}

/**
 * The `knowledge` booster over one text collection, by its `col_` id. Always
 * sent as the object form, since `collection` is required.
 *
 * ```ts
 * boosters: [knowledge('col_...', { scope: 'M-42', topK: 4, require: true })]
 * ```
 */
export function knowledge(collection: string, options: KnowledgeOptions = {}): Booster {
  const settings: BoosterSettings = { collection };
  const fields: Array<[string, unknown]> = [
    ['query', options.query],
    ['scope', options.scope],
    ['match', options.match],
    ['filter', options.filter],
    ['top_k', options.topK],
    ['max_tokens', options.maxTokens],
    ['pinned', options.pinned],
    ['min_score', options.minScore],
    ['include_text', options.includeText],
  ];
  for (const [key, value] of fields) if (value !== undefined && value !== null) settings[key] = value;
  return new Booster('knowledge', options.require === true ? { require: true, options: settings } : { options: settings });
}
