import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { BadRequestError, Decision, DecisionNode, Image, SPEC_VERSION, ValidationError, Video, VideoFrame, truth } from '../../src/index.js';
import { formatG } from '../../src/video.js';
import { fakeFetch, type Reply } from './helpers.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/images/', import.meta.url));
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const JPEG = fixture('7x4.jpg');
const PNG = fixture('5x3.png');
const WEBP = fixture('9x6-lossless.webp');
const GIF = new TextEncoder().encode('GIF89a\x01\x00\x01\x00');
const B64 = Buffer.from(JPEG).toString('base64');
const Q = { q: truth('Does a person fall in the video?') };

/** Answers every question of the request with a truth of 0.4. */
function answering(extra: Record<string, unknown> = {}): Reply[] {
  return [{ status: 200, body: { model: 'decisionnode-1.0', answers: {}, usage: { input_tokens: 9, output_tokens: 0 }, ...extra } }];
}

function client(replies: Reply[] = answering()) {
  const f = fakeFetch(replies);
  const dn = new DecisionNode({ apiKey: 'k', baseUrl: 'https://api.example.test', fetch: f.fetch, fetchHonoursManualRedirect: true });
  return { dn, calls: f.calls };
}

const frames = (...times: number[]) => times.map((t) => new VideoFrame(t, JPEG));

describe('video wire form', () => {
  it('writes a frame from bytes, the type read from them, or from base64 text as given', () => {
    expect(new VideoFrame(1.5, JPEG).toJSON()).toEqual({ t: 1.5, media_type: 'image/jpeg', data: B64 });
    expect(new VideoFrame(0, PNG).mediaType).toBe('image/png');
    expect(new VideoFrame(0, WEBP.buffer.slice(WEBP.byteOffset, WEBP.byteOffset + WEBP.byteLength)).mediaType).toBe('image/webp');
    expect(new VideoFrame(2, 'abc=', 'image/png').toJSON()).toEqual({ t: 2, media_type: 'image/png', data: 'abc=' });
    expect(new VideoFrame(0, GIF).mediaType).toBeUndefined();
    expect(() => new VideoFrame(0, 12 as unknown as string)).toThrow(TypeError);
  });

  it('writes a video with fps, start and end only when given', () => {
    const v = new Video('dock', frames(30, 30.5), { fps: 2, start: 30, end: 31 });
    expect(v.toJSON()).toEqual({
      id: 'dock',
      fps: 2,
      start: 30,
      end: 31,
      frames: [
        { t: 30, media_type: 'image/jpeg', data: B64 },
        { t: 30.5, media_type: 'image/jpeg', data: B64 },
      ],
    });
    expect(new Video('cam', frames(0)).toJSON()).toEqual({ id: 'cam', frames: [{ t: 0, media_type: 'image/jpeg', data: B64 }] });
    expect(() => new Video('cam', 'x' as unknown as VideoFrame[])).toThrow(TypeError);
  });

  it('formats numbers in messages as the API does', () => {
    expect(formatG(1.5)).toBe('1.5');
    expect(formatG(4)).toBe('4');
    expect(formatG(1 / 3)).toBe('0.333333');
    expect(formatG(1009.5)).toBe('1009.5');
    expect(formatG(1234567)).toBe('1.23457e+06');
    expect(formatG(0.00001)).toBe('1e-05');
  });
});

describe('videos in requests', () => {
  it('sends videos beside images, and leaves an empty list out', async () => {
    const { dn, calls } = client();
    const video = new Video('gate', frames(0, 0.5), { fps: 4 });
    await dn.decide({ state: 's', questions: Q, images: [Image.fromUrl('plate', 'https://files.example.com/plate.jpg')], videos: [video] });
    const body = JSON.parse(calls[0]!.body!);
    expect(body.videos).toEqual([video.toJSON()]);
    expect(body.images).toEqual([{ id: 'plate', url: 'https://files.example.com/plate.jpg' }]);
    await dn.decide({ state: 's', questions: Q, videos: [] });
    expect('videos' in JSON.parse(calls[1]!.body!)).toBe(false);
  });

  it('carries videos on decideMany and batch lines', async () => {
    const video = new Video('cam', frames(0));
    const { dn, calls } = client();
    await dn.decideMany([{ state: 'a', questions: Q, videos: [video] }]);
    expect(JSON.parse(calls[0]!.body!).videos).toEqual([video.toJSON()]);
    const b = client([{ status: 201, body: { id: 'batch_1', state: 'draft', counters: {} } }]);
    await b.dn.batches.create([{ customId: 'c1', state: 's', questions: Q, videos: [video] }]);
    expect(JSON.parse(b.calls[0]!.body!.split('\n')[0]!).videos).toEqual([video.toJSON()]);
  });

  it('carries videos on the helpers', async () => {
    const video = new Video('cam', frames(0));
    const { dn, calls } = client([{ status: 200, body: { model: 'm', answers: { check: { type: 'truth', truth: 0.2 } } } }]);
    await dn.check({ state: 's', instructions: 'Does smoke appear?', videos: [video] });
    expect(JSON.parse(calls[0]!.body!).videos).toEqual([video.toJSON()]);
  });

  it('reads video usage and warnings, empty when absent', async () => {
    const { dn } = client(
      answering({
        usage: { input_tokens: 900, output_tokens: 0, video_frames: 20, video_seconds: 10.5 },
        warnings: ["Video 'cam' was read at 1 frame a second."],
      }),
    );
    const d = await dn.decide({ questions: Q, videos: [new Video('cam', frames(0))] });
    expect([d.usage.videoFrames, d.usage.videoSeconds]).toEqual([20, 10.5]);
    expect(d.warnings).toEqual(["Video 'cam' was read at 1 frame a second."]);
    const plain = new Decision({ model: 'm', answers: {} }, {});
    expect([plain.usage.videoFrames, plain.usage.videoSeconds, plain.warnings]).toEqual([null, null, []]);
  });

  it.each([
    ['an empty id', [new Video('', frames(0))], [], 'Video 0 needs an id.'],
    ['a repeated id', [new Video('cam', frames(0)), new Video('cam', frames(0))], [], "Video id 'cam' is used twice (ids are unique across images and videos)."],
    ['an image id', [new Video('gate', frames(0))], [Image.fromUrl('gate', 'https://e.com/g.jpg')], "Video id 'gate' is used twice (ids are unique across images and videos)."],
    ['no frames', [new Video('cam', [])], [], "Video 'cam': frames must be a non-empty list of frames."],
    ['a negative time', [new Video('cam', frames(-1))], [], "Video 'cam': frame 0: t must be a number of seconds, at least 0."],
    ['a repeated time', [new Video('cam', frames(0, 1.5, 1.5))], [], "Video 'cam': frame 2: t must be larger than the frame before it (1.5)."],
    ['GIF bytes', [new Video('cam', [new VideoFrame(0, GIF)])], [], "Video 'cam': frame 0: media_type must be one of image/jpeg, image/png, image/webp."],
    ['base64 without a type', [new Video('cam', [new VideoFrame(0, B64)])], [], "Video 'cam': frame 0: media_type must be one of image/jpeg, image/png, image/webp."],
    ['fps 4.5', [new Video('cam', frames(0), { fps: 4.5 })], [], "Video 'cam': fps must be a number above 0 and at most 4."],
    ['fps 0', [new Video('cam', frames(0), { fps: 0 })], [], "Video 'cam': fps must be a number above 0 and at most 4."],
    ['a negative start', [new Video('cam', frames(0), { start: -1 })], [], "Video 'cam': start must be a number of seconds, at least 0."],
    ['end 0 alone', [new Video('cam', frames(0), { end: 0 })], [], "Video 'cam': end must be after start."],
    ['end before start', [new Video('cam', frames(5), { start: 5, end: 4 })], [], "Video 'cam': end must be after start."],
  ])('refuses %s with the API error and sends nothing', async (_name, videos, images, message) => {
    const { dn, calls } = client();
    const err = await dn.decide({ questions: Q, images: images as Image[], videos }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as BadRequestError).message).toBe(message);
    expect((err as BadRequestError).errorType).toBe('api_usage_error');
    expect((err as BadRequestError).status).toBeNull();
    expect(calls).toHaveLength(0);
    await expect(dn.checkRequest('decide', { questions: Q, images: images as Image[], videos })).rejects.toBeInstanceOf(BadRequestError);
  });

  it('refuses a fifth video with the API 422 too_long, after the question entries', async () => {
    const { dn, calls } = client();
    const videos = Array.from({ length: 5 }, (_, i) => new Video(`v${i}`, frames(0)));
    const err = await dn.decide({ questions: { q: { type: 'choice', instructions: '?' } }, videos }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    const entries = (err as ValidationError).entries as Array<Record<string, unknown>>;
    expect(entries.map((e) => [e.type, e.loc])).toEqual([
      ['missing', ['body', 'questions', 'q', 'choice', 'criteria']],
      ['too_long', ['body', 'videos']],
    ]);
    expect(entries[1]!.input).toEqual(videos.map((v) => v.toJSON()));
    expect(entries[1]!.ctx).toEqual({ field_type: 'List', max_length: 4, actual_length: 5 });
    expect(calls).toHaveLength(0);
  });

  it('leaves frame counts and a frame bytes against its type to the server', async () => {
    const { dn, calls } = client();
    const many = new Video('cam', frames(...Array.from({ length: 200 }, (_, i) => i * 0.25)), { fps: 4 });
    const wrong = new Video('door', [new VideoFrame(0, JPEG, 'image/png')]);
    await dn.decide({ questions: Q, videos: [many, wrong] });
    expect(calls).toHaveLength(1);
  });

  it('takes sixteen images and refuses the seventeenth', async () => {
    const { dn, calls } = client();
    const images = Array.from({ length: 16 }, (_, i) => Image.fromBytes(`i${i}`, PNG));
    await dn.decide({ questions: Q, images });
    expect(JSON.parse(calls[0]!.body!).images).toHaveLength(16);
    const err = await dn
      .decide({ questions: Q, images: [...images, Image.fromUrl('x', 'https://e.com/x.jpg')] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(((err as ValidationError).entries as Array<Record<string, unknown>>)[0]!.ctx).toEqual({ field_type: 'List', max_length: 16, actual_length: 17 });
    const refused = await dn.upload([...images, Image.fromBytes('y', PNG)]).catch((e: unknown) => e);
    expect([(refused as BadRequestError).message, (refused as BadRequestError).errorType]).toEqual([
      'files: 1 to 16 files, got 17.',
      'api_usage_error',
    ]);
    expect(calls).toHaveLength(1);
  });

  it('implements specification 1.2', () => {
    expect(SPEC_VERSION).toBe('1.3');
  });
});
