import { Readable } from 'node:stream';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BadRequestError,
  DecisionNode,
  Document,
  KnowledgeReading,
  OverloadedError,
  ServerError,
  TimeoutError,
  UnknownReading,
  ValidationError,
  knowledge,
  truth,
} from '../../src/index.js';
import { fakeFetch, type Recorded, type Reply } from './helpers.js';

const ENV = ['DECISIONNODE_API_KEY', 'DECISIONNODE_BASE_URL', 'DECISIONNODE_MODEL'];

beforeEach(() => ENV.forEach((v) => delete process.env[v]));
afterEach(() => ENV.forEach((v) => delete process.env[v]));

const BASE = 'https://api.example.test';
const COL = 'col_3f6c1a9e0b2d4c7f8a1e5d9b2c4f6a80';
const ITEM = 'itm_9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d';
const UPL = 'upl_3f6c1a9e0b2d4c7f8a1e5d9b2c4f6a80';
const QUEUED = { id: ITEM, reference: ITEM, title: 'Claims policy', status: 'queued', source: 'article' };
const READY = { ...QUEUED, status: 'ready' };
const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');
const PRESIGNED = {
  status: 200,
  body: {
    uploads: [
      {
        upload_id: UPL,
        purpose: 'knowledge',
        url: 'https://storage.example.test/k/1?sig=1',
        method: 'PUT',
        headers: { 'content-type': 'application/pdf', 'if-none-match': '*' },
        expires_at: '2099-01-01T00:00:00Z',
      },
    ],
    expires_in: 300,
  },
};
const STORED = { status: 200, text: '' };
const READING = {
  collection: COL,
  collection_name: 'Claims policy',
  corpus: { version: 41 },
  query: { source: 'auto', tokens: 212 },
  budget: { mode: 'auto', tokens: 840, entry: 'short', cause: null },
  scope: { key: 'mission', value: 'M-42' },
  warnings: [],
  passages: [
    {
      n: 1,
      pinned: true,
      item: ITEM,
      reference: 'policy-2026',
      title: 'Claims policy 2026',
      heading: 'Receipts',
      chunk: 3,
      byte_start: 1840,
      byte_end: 2310,
      tokens: 96,
      score: null,
      lexical: false,
      rendered: true,
    },
  ],
  omitted: { below_min_score: 0, per_item_cap: 1, over_budget: 1 },
  pending_items: 0,
  search: { plan: 'exact', candidates: 50, fallback: false },
  truncated: false,
};

function client(replies: Reply[], options: { timeout?: number; inlineThreshold?: number } = {}) {
  const f = fakeFetch(replies);
  const sleeps: number[] = [];
  const dn = new DecisionNode({
    apiKey: 'dn_test',
    baseUrl: BASE,
    fetch: f.fetch,
    fetchHonoursManualRedirect: true,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...options,
  });
  return { dn, calls: f.calls, sleeps };
}

function sent(call: Recorded): { method: string; path: string; body: unknown } {
  const url = new URL(call.url);
  const body = call.body === undefined ? undefined : typeof call.body === 'string' ? JSON.parse(call.body) : '<bytes>';
  return { method: call.method, path: url.pathname + url.search, body };
}

async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => {
      throw new Error('expected a refusal');
    },
    (err: unknown) => err,
  );
}

async function entries(run: () => Promise<unknown>): Promise<unknown> {
  const e = await refusal(run);
  expect(e).toBeInstanceOf(ValidationError);
  return (e as ValidationError).entries;
}

describe('knowledge bases', () => {
  it('creates a text collection with a scope key', async () => {
    const { dn, calls } = client([{ status: 201, body: { id: COL, type: 'text', scope_key: 'mission' } }]);
    await dn.collections.create({ name: 'Claims policy', type: 'text', scopeKey: 'mission' });
    expect(sent(calls[0]!)).toEqual({ method: 'POST', path: '/v1/collections', body: { type: 'text', name: 'Claims policy', scope_key: 'mission' } });
    expect(calls[0]!.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a scope key off its pattern, sending nothing', async () => {
    const { dn, calls } = client([]);
    expect(await entries(() => dn.collections.create({ name: 'Claims', type: 'text', scopeKey: 'Mission' }))).toEqual([
      { type: 'string_pattern_mismatch', loc: ['body', 'scope_key'], msg: "String should match pattern '^[a-z0-9_]{1,40}$'", input: 'Mission' },
    ]);
    expect(calls).toHaveLength(0);
  });
});

describe('documents', () => {
  it('adds Markdown inline, format left out unless given', async () => {
    const { dn, calls } = client([{ status: 202, body: QUEUED }]);
    expect(await dn.collections.addDocument(COL, { document: '# Receipts\n\nKeep them.', title: 'Claims policy' })).toEqual(QUEUED);
    expect(sent(calls[0]!)).toEqual({
      method: 'POST',
      path: `/v1/collections/${COL}/items`,
      body: { title: 'Claims policy', text: '# Receipts\n\nKeep them.' },
    });
  });

  it('adds plain text with every field and wait', async () => {
    const { dn, calls } = client([{ status: 201, body: READY }]);
    await dn.collections.addDocument(COL, {
      document: Document.fromText('Reject any claim over 500 SEK without a receipt.', 'text'),
      title: 'Receipts',
      reference: 'policy-2026',
      pinned: true,
      pinRank: 1,
      label: 'Policy',
      metadata: { mission: 'M-42' },
      wait: true,
    });
    expect(sent(calls[0]!)).toEqual({
      method: 'POST',
      path: `/v1/collections/${COL}/items?wait=true`,
      body: {
        title: 'Receipts',
        text: 'Reject any claim over 500 SEK without a receipt.',
        format: 'text',
        reference: 'policy-2026',
        pinned: true,
        pin_rank: 1,
        label: 'Policy',
        metadata: { mission: 'M-42' },
      },
    });
  });

  it('sends a small Markdown file inline, titled by its stem', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dn-knowledge-'));
    const file = join(dir, 'house-rules.v2.md');
    writeFileSync(file, '# Rules\n\nNo pets.');
    const { dn, calls } = client([{ status: 202, body: QUEUED }]);
    await dn.collections.addDocument(COL, { document: Document.fromPath(file) });
    expect(sent(calls[0]!).body).toEqual({ title: 'house-rules.v2', text: '# Rules\n\nNo pets.', format: 'markdown' });
  });

  it('uploads a PDF with the knowledge purpose, then names its upload id', async () => {
    const { dn, calls } = client([PRESIGNED, STORED, { status: 202, body: { ...QUEUED, source: 'file' } }]);
    await dn.collections.addDocument(COL, { document: Document.fromBytes(PDF, { filename: 'claims-policy-2026.pdf' }), reference: 'policy-2026' });
    expect(calls).toHaveLength(3);
    const presign = sent(calls[0]!);
    expect(presign.path).toBe('/v1/uploads');
    expect(presign.body).toEqual({
      files: [
        {
          purpose: 'knowledge',
          content_type: 'application/pdf',
          byte_size: PDF.length,
          checksum: expect.any(String),
          sha256: expect.any(String),
          filename: 'claims-policy-2026.pdf',
        },
      ],
    });
    // The PUT carries exactly the storage's headers and the bytes.
    expect(calls[1]!.url).toBe('https://storage.example.test/k/1?sig=1');
    expect(calls[1]!.headers).toEqual({ 'content-type': 'application/pdf', 'if-none-match': '*' });
    expect(sent(calls[2]!).body).toEqual({ upload_id: UPL, reference: 'policy-2026' });
  });

  it('tells a file type from the extension, then the first bytes, and refuses one it cannot tell', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const { dn, calls } = client([PRESIGNED, STORED, { status: 202, body: QUEUED }]);
    await dn.collections.addDocument(COL, { document: Document.fromBytes(png), title: 'Floor plan' });
    expect((sent(calls[0]!).body as { files: Array<{ content_type: string }> }).files[0]!.content_type).toBe('image/png');
    // A ZIP container without a name or a type cannot be told: an argument error.
    await expect(dn.collections.addDocument(COL, { document: Document.fromBytes(Uint8Array.from([0x50, 0x4b, 3, 4])), title: 'Sheet' })).rejects.toBeInstanceOf(TypeError);
    const err = await refusal(() => dn.collections.addDocument(COL, { document: Document.fromBytes(png, { contentType: 'image/gif' }), title: 'Gif' }));
    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as BadRequestError).message).toMatch(/^files\[0\]\.content_type: must be one of text\/plain, text\/markdown, application\/pdf, .*, got image\/gif\.$/);
    expect(calls).toHaveLength(3);
  });

  it('uploads text at the threshold and text that is not UTF-8', async () => {
    const { dn, calls } = client([PRESIGNED, STORED, { status: 202, body: QUEUED }], { inlineThreshold: 8 });
    await dn.collections.addDocument(COL, { document: Document.fromBytes(new TextEncoder().encode('12345678'), { filename: 'a.txt' }) });
    expect(sent(calls[2]!).body).toEqual({ upload_id: UPL });
    const under = client([{ status: 202, body: QUEUED }], { inlineThreshold: 8 });
    await under.dn.collections.addDocument(COL, { document: Document.fromBytes(new TextEncoder().encode('1234567'), { filename: 'a.txt' }) });
    expect(sent(under.calls[0]!).body).toEqual({ title: 'a', text: '1234567', format: 'text' });
    const latin = client([PRESIGNED, STORED, { status: 202, body: QUEUED }]);
    await latin.dn.collections.addDocument(COL, { document: Document.fromBytes(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]), { filename: 'cafe.txt' }) });
    expect(sent(latin.calls[0]!).path).toBe('/v1/uploads');
  });

  it('reads a web stream and a Node stream to their end', async () => {
    const web = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(PDF.slice(0, 4));
        c.enqueue(PDF.slice(4));
        c.close();
      },
    });
    const a = client([PRESIGNED, STORED, { status: 202, body: QUEUED }]);
    await a.dn.collections.addDocument(COL, { document: Document.fromStream(web), title: 'Policy' });
    expect((sent(a.calls[0]!).body as { files: Array<{ byte_size: number }> }).files[0]!.byte_size).toBe(PDF.length);
    const b = client([{ status: 202, body: QUEUED }]);
    await b.dn.collections.addDocument(COL, { document: Document.fromStream(Readable.from(['# A\n', 'b']), { filename: 'notes.md' }) });
    expect(sent(b.calls[0]!).body).toEqual({ title: 'notes', text: '# A\nb', format: 'markdown' });
  });

  it('replaces a document and edits a text item', async () => {
    const { dn, calls } = client([{ status: 202, body: QUEUED }, { status: 200, body: READY }]);
    await dn.collections.replaceDocument(COL, ITEM, { document: 'New text', title: 'Policy' });
    expect(sent(calls[0]!)).toEqual({ method: 'PUT', path: `/v1/collections/${COL}/items/${ITEM}`, body: { title: 'Policy', text: 'New text' } });
    await dn.collections.updateItem(COL, ITEM, { pinned: true, pinRank: 3, title: 'Policy 2026' });
    expect(sent(calls[1]!)).toEqual({ method: 'PATCH', path: `/v1/collections/${COL}/items/${ITEM}`, body: { pinned: true, pin_rank: 3, title: 'Policy 2026' } });
    expect(calls[1]!.headers['idempotency-key']).toBeDefined();
  });

  it('keeps one Idempotency-Key on every attempt', async () => {
    const busy = { status: 529, headers: { 'retry-after-ms': '1' }, body: { detail: { error_type: 'overloaded_error', message: 'busy' } } };
    const { dn, calls } = client([busy, { status: 202, body: QUEUED }]);
    await dn.collections.addDocument(COL, { document: 'Text', title: 'T' });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers['idempotency-key']).toBe(calls[1]!.headers['idempotency-key']);
  });

  it('uploads again once when its own upload went stale, with a new key, and throws the second time', async () => {
    const stale = { status: 400, body: { detail: { error_type: 'upload_expired', message: 'expired' } } };
    const { dn, calls } = client([PRESIGNED, STORED, stale, PRESIGNED, STORED, { status: 202, body: QUEUED }]);
    await dn.collections.addDocument(COL, { document: Document.fromBytes(PDF), title: 'P' });
    expect(calls.map((c) => sent(c).path)).toEqual([
      '/v1/uploads',
      '/k/1?sig=1',
      `/v1/collections/${COL}/items`,
      '/v1/uploads',
      '/k/1?sig=1',
      `/v1/collections/${COL}/items`,
    ]);
    expect(calls[2]!.headers['idempotency-key']).not.toBe(calls[5]!.headers['idempotency-key']);
    const twice = client([PRESIGNED, STORED, stale, PRESIGNED, STORED, stale]);
    const err = await refusal(() => twice.dn.collections.addDocument(COL, { document: Document.fromBytes(PDF), title: 'P' }));
    expect((err as BadRequestError).errorType).toBe('upload_expired');
  });

  it("throws a stale or mismatched upload the caller named at once", async () => {
    const mismatch = { status: 400, body: { detail: { error_type: 'upload_purpose_mismatch', message: 'image upload' } } };
    const { dn, calls } = client([{ status: 400, body: { detail: { error_type: 'upload_consumed', message: 'used' } } }, mismatch]);
    expect(((await refusal(() => dn.collections.addDocument(COL, { document: Document.fromUploadId(UPL) }))) as BadRequestError).errorType).toBe('upload_consumed');
    expect(sent(calls[0]!).body).toEqual({ upload_id: UPL });
    expect(((await refusal(() => dn.collections.addDocument(COL, { document: Document.fromUploadId(UPL) }))) as BadRequestError).errorType).toBe(
      'upload_purpose_mismatch',
    );
    expect(calls).toHaveLength(2);
  });

  it('runs the local checks, sending nothing', async () => {
    const { dn, calls } = client([]);
    expect(await entries(() => dn.collections.addDocument(COL, { document: 'Text' }))).toEqual([
      { type: 'missing', loc: ['body', 'title'], msg: 'Field required', input: null },
    ]);
    expect(await entries(() => dn.collections.addDocument(COL, { document: '', title: '   ' }))).toEqual([
      { type: 'string_too_long', loc: ['body', 'title'], msg: 'A title is 1 to 200 characters', input: '   ' },
      { type: 'string_too_short', loc: ['body', 'text'], msg: 'The text is empty', input: '' },
    ]);
    expect(
      await entries(() =>
        dn.collections.addDocument(COL, { document: Document.fromText('x', 'html'), title: 'T', reference: 'a b', pinRank: 1001, label: '' }),
      ),
    ).toEqual([
      { type: 'literal_error', loc: ['body', 'format'], msg: "Input should be 'markdown' or 'text'", input: 'html' },
      {
        type: 'string_pattern_mismatch',
        loc: ['body', 'reference'],
        msg: "String should match pattern '^[A-Za-z0-9_.:-]{1,64}$'",
        input: 'a b',
        ctx: { pattern: '^[A-Za-z0-9_.:-]{1,64}$' },
      },
      { type: 'int_range', loc: ['body', 'pin_rank'], msg: 'Input should be an integer from 0 to 1000', input: 1001 },
      { type: 'string_too_short', loc: ['body', 'label'], msg: 'String should have at least 1 character', input: '', ctx: { min_length: 1 } },
    ]);
    const big = await refusal(() => dn.collections.addDocument(COL, { document: Document.fromBytes(new Uint8Array(52_428_801), { filename: 'big.pdf' }), title: 'T' }));
    expect((big as BadRequestError).message).toBe('files[0].byte_size: 52428801 is over the limit of 52428800 bytes.');
    const empty = await refusal(() => dn.collections.addDocument(COL, { document: Document.fromBytes(new Uint8Array(0), { filename: 'a.pdf' }) }));
    expect((empty as BadRequestError).message).toBe('files[0].byte_size: must be an integer from 1 to 52428800.');
    // A text file sent inline without a name needs a title.
    expect(await entries(() => dn.collections.addDocument(COL, { document: Document.fromBytes(new TextEncoder().encode('hi'), { contentType: 'text/plain' }) }))).toEqual([
      { type: 'missing', loc: ['body', 'title'], msg: 'Field required', input: null },
    ]);
    expect(calls).toHaveLength(0);
  });
});

describe('reading documents', () => {
  it('gets an item with and without its text, pages chunks, and deletes the failed', async () => {
    const page = { chunks: [], offset: 20, limit: 20, total: 20, next_offset: null };
    const { dn, calls } = client([
      { status: 200, body: READY },
      { status: 200, body: { ...READY, text: '# Rules' } },
      { status: 200, body: page },
      { status: 200, body: { deleted: 2 } },
    ]);
    await dn.collections.getItem(COL, ITEM);
    expect((await dn.collections.getItem(COL, ITEM, { includeText: true })).text).toBe('# Rules');
    expect(await dn.collections.listChunks(COL, ITEM, { offset: 20, limit: 20 })).toEqual(page);
    expect(await dn.collections.deleteFailedItems(COL)).toEqual({ deleted: 2 });
    expect(calls.map((c) => `${c.method} ${sent(c).path}`)).toEqual([
      `GET /v1/collections/${COL}/items/${ITEM}`,
      `GET /v1/collections/${COL}/items/${ITEM}?include=text`,
      `GET /v1/collections/${COL}/items/${ITEM}/chunks?offset=20&limit=20`,
      `DELETE /v1/collections/${COL}/items?status=failed`,
    ]);
    await expect(dn.collections.listChunks(COL, ITEM, { limit: 101 })).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe('waitUntilReady', () => {
  it('reads an item until it is ready, waiting longer each time', async () => {
    const { dn, calls, sleeps } = client([
      { status: 200, body: QUEUED },
      { status: 200, body: { ...QUEUED, status: 'processing', stage: 'embedding' } },
      { status: 200, body: READY },
    ]);
    expect(await dn.collections.waitUntilReady(COL, { itemId: ITEM })).toEqual(READY);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 1500]);
  });

  it('returns a failed item as a value, and waits for a status it does not know', async () => {
    const failed = { ...QUEUED, status: 'failed', error: 'chunks_limit_reached' };
    const { dn } = client([{ status: 200, body: { ...QUEUED, status: 'uploading' } }, { status: 200, body: failed }]);
    expect(await dn.collections.waitUntilReady(COL, { itemId: ITEM })).toEqual(failed);
  });

  it('waits for a whole collection', async () => {
    const busy = { id: COL, type: 'text', status_counts: { queued: 1, processing: 0, ready: 2, failed: 0 } };
    const done = { id: COL, type: 'text', status_counts: { queued: 0, processing: 0, ready: 3, failed: 0 } };
    const { dn, calls } = client([{ status: 200, body: busy }, { status: 200, body: done }]);
    expect(await dn.collections.waitUntilReady(COL)).toEqual(done);
    expect(sent(calls[0]!).path).toBe(`/v1/collections/${COL}`);
  });

  it('throws TimeoutError past its timeout, and refuses bad arguments before sending', async () => {
    const { dn, calls } = client([{ status: 200, body: QUEUED }]);
    await expect(dn.collections.waitUntilReady(COL, { itemId: ITEM, timeout: 2000 })).rejects.toBeInstanceOf(TimeoutError);
    const before = calls.length;
    await expect(dn.collections.waitUntilReady(COL, { pollInterval: 50 })).rejects.toBeInstanceOf(RangeError);
    await expect(dn.collections.waitUntilReady(COL, { timeout: 0 })).rejects.toBeInstanceOf(RangeError);
    expect(calls).toHaveLength(before);
  });
});

describe('search and the knowledge booster', () => {
  it('searches with the options given and reads the passages', async () => {
    const answer = { ...READING, passages: [{ ...READING.passages[0], text: 'Reject any claim...', rendered: undefined }], truncated: undefined };
    const { dn, calls } = client([{ status: 200, body: answer }]);
    const reading = await dn.collections.search(COL, { query: 'receipts', scope: 'M-42', topK: 2, maxTokens: 'auto' });
    expect(sent(calls[0]!)).toEqual({
      method: 'POST',
      path: `/v1/collections/${COL}/search`,
      body: { query: 'receipts', scope: 'M-42', top_k: 2, max_tokens: 'auto' },
    });
    expect(reading).toBeInstanceOf(KnowledgeReading);
    expect(reading.passages[0]!.text).toBe('Reject any claim...');
    expect(reading.passages[0]!.rendered).toBeNull();
    expect(reading.truncated).toBeNull();
  });

  it('refuses a search answer that is not a reading', async () => {
    const { dn } = client([{ status: 200, body: { collection: COL } }]);
    await expect(dn.collections.search(COL, { query: 'q' })).rejects.toBeInstanceOf(ServerError);
  });

  it('writes the booster object, never the bare name', () => {
    expect(knowledge(COL).toJSON()).toEqual({ name: 'knowledge', options: { collection: COL } });
    expect(
      knowledge(COL, {
        query: 'q',
        scope: 'M-42',
        match: { region: 'SE' },
        filter: { key: 'year', op: 'gte', value: 2026 },
        topK: 0,
        maxTokens: 512,
        pinned: false,
        minScore: 0.3,
        includeText: true,
        require: true,
      }).toJSON(),
    ).toEqual({
      name: 'knowledge',
      require: true,
      options: {
        collection: COL,
        query: 'q',
        scope: 'M-42',
        match: { region: 'SE' },
        filter: { key: 'year', op: 'gte', value: 2026 },
        top_k: 0,
        max_tokens: 512,
        pinned: false,
        min_score: 0.3,
        include_text: true,
      },
    });
    expect(knowledge(COL, { require: false }).toJSON()).toEqual({ name: 'knowledge', options: { collection: COL } });
  });

  it('reads evidence.knowledge, and a malformed reading as an UnknownReading', async () => {
    const decision = (results: unknown[]) => ({
      status: 200,
      body: {
        model: 'decisionnode-moe-0.9.0',
        answers: { approve: { type: 'truth', truth: 0.2 } },
        evidence: { knowledge: { version: 'knowledge-v1', status: 'ok', latency_ms: 141, billed_calls: 1, results } },
        usage: { input_tokens: 9, output_tokens: 0, booster_tokens: 96, boosters: 1 },
      },
    });
    const bad = { ...READING, passages: [{ ...READING.passages[0], byte_start: '1840' }] };
    const { dn, calls } = client([decision([READING]), decision([bad])]);
    const params = { state: { claim: 740 }, questions: { approve: truth('Approve?') }, boosters: [knowledge(COL, { scope: 'M-42', require: true })] };
    const d = await dn.decide(params);
    expect(JSON.parse(calls[0]!.body as string).boosters).toEqual([{ name: 'knowledge', require: true, options: { collection: COL, scope: 'M-42' } }]);
    const r = d.evidence!.knowledge!.results[0]!;
    expect(r).toBeInstanceOf(KnowledgeReading);
    const k = r as KnowledgeReading;
    expect(k.passages[0]).toMatchObject({ n: 1, pinned: true, item: ITEM, chunk: 3, byteStart: 1840, byteEnd: 2310, score: null, heading: 'Receipts' });
    expect(k.scope).toEqual({ key: 'mission', value: 'M-42' });
    expect(k.omitted).toEqual({ below_min_score: 0, per_item_cap: 1, over_budget: 1 });
    expect((await dn.decide(params)).evidence!.knowledge!.results[0]).toBeInstanceOf(UnknownReading);
  });

  it('throws the ingestion 529 at once and retries the plain knowledge 529', async () => {
    const delayed = {
      status: 529,
      headers: { 'retry-after': '60' },
      body: { detail: { error_type: 'booster_unavailable', message: 'delayed', details: { reason: 'ingestion_delayed' } } },
    };
    const { dn, calls } = client([delayed]);
    const params = { questions: { approve: truth('Approve?') }, boosters: [knowledge(COL, { require: true })] };
    const err = await refusal(() => dn.decide(params));
    expect(err).toBeInstanceOf(OverloadedError);
    expect((err as OverloadedError).details).toEqual({ reason: 'ingestion_delayed' });
    expect(calls).toHaveLength(1);
    const pending = { status: 529, headers: { 'retry-after': '5' }, body: { detail: { error_type: 'booster_unavailable', message: 'pending' } } };
    const again = client([pending, pending, pending]);
    await expect(again.dn.decide(params)).rejects.toBeInstanceOf(OverloadedError);
    expect(again.calls).toHaveLength(3);
    expect(again.sleeps).toEqual([5000, 5000]);
  });
});

describe('uploadDocuments', () => {
  it('uploads files and texts in one presign and returns their ids in order', async () => {
    const two = {
      status: 200,
      body: {
        uploads: [
          { upload_id: 'upl_a', purpose: 'knowledge', url: 'https://storage.example.test/a', headers: {} },
          { upload_id: 'upl_b', purpose: 'knowledge', url: 'https://storage.example.test/b', headers: {} },
        ],
      },
    };
    const { dn, calls } = client([two, STORED, STORED]);
    expect(await dn.uploadDocuments([Document.fromBytes(PDF, { filename: 'a.pdf' }), Document.fromText('plain', 'text')])).toEqual(['upl_a', 'upl_b']);
    const files = (sent(calls[0]!).body as { files: Array<Record<string, unknown>> }).files;
    expect(files.map((f) => [f.content_type, f.filename])).toEqual([
      ['application/pdf', 'a.pdf'],
      ['text/plain', undefined],
    ]);
    await expect(dn.uploadDocuments(new Array(17).fill('x'))).rejects.toBeInstanceOf(BadRequestError);
    await expect(dn.uploadDocuments([])).rejects.toBeInstanceOf(BadRequestError);
  });

  it('leaves an image upload without a purpose', async () => {
    const { dn, calls } = client([
      { status: 200, body: { uploads: [{ upload_id: 'upl_i', url: 'https://storage.example.test/i', headers: {} }] } },
      STORED,
    ]);
    const png = Uint8Array.from(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGM8ISfHwMDAxMDAwMDAAAANBAEIfXHKZgAAAABJRU5ErkJggg=='),
      (c) => c.charCodeAt(0),
    );
    const { Image } = await import('../../src/index.js');
    await dn.upload([Image.fromBytes('p', png)]);
    expect(Object.keys((sent(calls[0]!).body as { files: Array<Record<string, unknown>> }).files[0]!)).toEqual([
      'content_type',
      'byte_size',
      'checksum',
      'sha256',
    ]);
  });
});
