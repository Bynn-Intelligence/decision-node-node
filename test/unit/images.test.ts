import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { BadRequestError, DecisionNode, Image, MAX_IMAGE_BYTES, ValidationError, imageDimensions, sniffMediaType, truth } from '../../src/index.js';
import { fromBase64, isBlockedAddress, toBase64 } from '../../src/image.js';
import { OK_TRUTH, fakeFetch } from './helpers.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/images/', import.meta.url));
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

/** A PNG signature and an IHDR chunk of the given size; nothing after it. */
function pngHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}

/** A JPEG with an APP0 segment, then a SOFn segment of the given size. */
function jpegHeader(marker: number, width: number, height: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0, 4, 0, 0];
  const sof = [0xff, marker, 0, 11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof]);
}

describe('image headers', () => {
  it.each([
    ['5x3.png', 'image/png', 5, 3],
    ['7x4.jpg', 'image/jpeg', 7, 4],
    ['7x4-progressive.jpg', 'image/jpeg', 7, 4],
    ['7x4-exif.jpg', 'image/jpeg', 7, 4],
    ['9x6-lossy.webp', 'image/webp', 9, 6],
    ['9x6-lossless.webp', 'image/webp', 9, 6],
    ['9x6-alpha.webp', 'image/webp', 9, 6],
  ])('reads %s', (name, type, width, height) => {
    const bytes = fixture(name);
    expect(sniffMediaType(bytes)).toBe(type);
    expect(imageDimensions(bytes, type)).toEqual({ width, height });
  });

  it('reads a large PNG size from the header alone', () => {
    expect(imageDimensions(pngHeader(8000, 6000), 'image/png')).toEqual({ width: 8000, height: 6000 });
  });

  it('reads every JPEG start-of-frame marker, skipping fill bytes and other segments', () => {
    for (const marker of [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]) {
      expect(imageDimensions(jpegHeader(marker, 640, 480), 'image/jpeg')).toEqual({ width: 640, height: 480 });
    }
    const filled = jpegHeader(0xc0, 300, 200);
    const withFill = new Uint8Array([...filled.slice(0, 8), 0xff, ...filled.slice(8)]);
    expect(imageDimensions(withFill, 'image/jpeg')).toEqual({ width: 300, height: 200 });
  });

  it('does not take a DHT, JPG or DAC segment for a frame header', () => {
    for (const marker of [0xc4, 0xc8, 0xcc]) {
      expect(imageDimensions(jpegHeader(marker, 640, 480), 'image/jpeg')).toBeNull();
    }
  });

  it('gives null for a truncated or broken header', () => {
    expect(imageDimensions(fixture('5x3.png').slice(0, 20), 'image/png')).toBeNull();
    expect(imageDimensions(fixture('7x4.jpg').slice(0, 30), 'image/jpeg')).toBeNull();
    expect(imageDimensions(new Uint8Array([0xff, 0xd8, 0x00, 0x00]), 'image/jpeg')).toBeNull();
    expect(imageDimensions(fixture('9x6-lossy.webp').slice(0, 28), 'image/webp')).toBeNull();
    const badStart = fixture('9x6-lossy.webp');
    badStart[23] = 0;
    expect(imageDimensions(badStart, 'image/webp')).toBeNull();
  });

  it('round-trips base64, and refuses text that is not base64', () => {
    const bytes = fixture('7x4.jpg');
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(fromBase64('not base64!')).toBeNull();
    expect(fromBase64('abcde')).toBeNull();
  });
});

describe('local image checks', () => {
  const client = () => {
    const f = fakeFetch([OK_TRUTH]);
    const dn = new DecisionNode({ apiKey: 'k', baseUrl: 'https://api.example.test', fetch: f.fetch, fetchHonoursManualRedirect: true });
    return { dn, calls: f.calls };
  };
  const decideWith = async (images: Image[]) => {
    const { dn, calls } = client();
    const err = await dn.decide({ questions: { q: truth('?') }, images }).catch((e: unknown) => e);
    return { err, calls };
  };

  it.each([
    ['over 40 megapixels', [Image.fromBytes('huge', pngHeader(8000, 6000))], /over 40 megapixels/],
    ['a declared type that differs', [Image.fromBytes('p', fixture('5x3.png'), 'image/jpeg')], /could not be decoded as image\/jpeg/],
    ['a GIF', [Image.fromBytes('g', new TextEncoder().encode('GIF89a\x01\x00\x01\x00'), 'image/gif')], /not a JPEG, PNG or WebP/],
    ['an unreadable header', [Image.fromBytes('t', fixture('5x3.png').slice(0, 20))], /header cannot be read/],
    ['base64 that is not', [Image.fromBase64('b', '***')], /not valid base64/],
    ['a plain http URL', [Image.fromUrl('u', 'http://example.com/a.jpg')], /only https URLs/],
    ['a URL over 2,048 characters', [Image.fromUrl('u', `https://example.com/${'a'.repeat(2048)}`)], /over the limit of 2048/],
    ['a URL with user information', [Image.fromUrl('u', 'https://user:pw@example.com/a.jpg')], /user information/],
    ['a URL on another port', [Image.fromUrl('u', 'https://example.com:8443/a.jpg')], /port other than 443/],
    ['a private address', [Image.fromUrl('u', 'https://10.1.2.3/a.jpg')], /private address/],
    ['the metadata address', [Image.fromUrl('u', 'https://169.254.169.254/a.jpg')], /private address/],
    ['an IPv6 loopback', [Image.fromUrl('u', 'https://[::1]/a.jpg')], /private address/],
    ['an IPv4-mapped private address', [Image.fromUrl('u', 'https://[::ffff:192.168.0.1]/a.jpg')], /private address/],
    ['a NAT64 loopback', [Image.fromUrl('u', 'https://[64:ff9b::7f00:1]/a.jpg')], /private address/],
    ['an upload reference of another type', [Image.fromUploadId('r', 'upl_0', 'image/gif')], /media_type must be/],
    ['repeated ids', [Image.fromUrl('a', 'https://example.com/1.jpg'), Image.fromUrl('a', 'https://example.com/2.jpg')], /Duplicate image id/],
  ])('refuses %s with BadRequestError and sends nothing', async (_name, images, message) => {
    const { err, calls } = await decideWith(images);
    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as BadRequestError).message).toMatch(message);
    expect((err as BadRequestError).status).toBeNull();
    expect((err as BadRequestError).requestId).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('refuses a seventeenth image with the API 422 too_long and sends nothing', async () => {
    const urls = Array.from({ length: 17 }, (_, i) => Image.fromUrl(`u${i}`, 'https://example.com/a.jpg'));
    const { err, calls } = await decideWith([...urls.slice(0, 16), Image.fromBytes('local', fixture('5x3.png'))]);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).status).toBeNull();
    expect((err as ValidationError).entries).toEqual([
      {
        type: 'too_long',
        loc: ['body', 'images'],
        msg: 'List should have at most 16 items after validation, not 17',
        input: [...urls.slice(0, 16).map((u) => ({ id: u.id, url: 'https://example.com/a.jpg' })), { id: 'local', media_type: 'image/png' }],
        ctx: { field_type: 'List', max_length: 16, actual_length: 17 },
      },
    ]);
    expect(calls).toHaveLength(0);
  });

  it('refuses an image over 10 MiB', async () => {
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    big.set(fixture('5x3.png'));
    const { err, calls } = await decideWith([Image.fromBytes('big', big)]);
    expect(err).toBeInstanceOf(BadRequestError);
    expect(calls).toHaveLength(0);
  });

  it('takes base64 input and sends it inline with the media type read from the bytes', async () => {
    const { dn, calls } = client();
    const text = toBase64(fixture('9x6-lossless.webp'));
    await dn.decide({ questions: { q: truth('?') }, images: [Image.fromBase64('w', text)] });
    expect(JSON.parse(calls[0]!.body!).images).toEqual([{ id: 'w', media_type: 'image/webp', data: text }]);
  });

  it('sends an upload id as given', async () => {
    const { dn, calls } = client();
    await dn.decide({ questions: { q: truth('?') }, images: [Image.fromUploadId('r', 'upl_0123', 'image/png')] });
    expect(JSON.parse(calls[0]!.body!).images).toEqual([{ id: 'r', upload_id: 'upl_0123', media_type: 'image/png' }]);
  });
});

describe('blocked addresses', () => {
  it('judges literal addresses only', () => {
    for (const host of ['8.8.8.8', '[2606:4700::1111]', 'example.com', '[::ffff:8.8.8.8]', '172.32.0.1']) expect(isBlockedAddress(host)).toBe(false);
    for (const host of ['127.0.0.1', '0.0.0.0', '100.64.0.1', '172.31.255.255', '[fe80::1]', '[fd00:ec2::254]', '[2001:db8::1]', '255.255.255.255']) {
      expect(isBlockedAddress(host)).toBe(true);
    }
  });
});
