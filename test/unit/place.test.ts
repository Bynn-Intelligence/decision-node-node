import { describe, expect, it } from 'vitest';

import {
  BadRequestError,
  BoxAnswer,
  DecisionNode,
  Image,
  PointAnswer,
  UnknownAnswer,
  ValidationError,
  box,
  parseAnswer,
  point,
  truth,
} from '../../src/index.js';
import { fakeFetch, type Reply } from './helpers.js';

const BELT = Image.fromUrl('belt', 'https://files.example.com/line-3/cam-2/0917.jpg');
const DOCK = Image.fromUrl('dock', 'https://files.example.com/dock/0001.jpg');
const PICK = 'Point to the yellow package closest to the robot arm.';
const DAMAGE = 'Draw a box around the damaged package.';
const POINT = { type: 'point', x: 812, y: 455, present: 0.97, confidence: 0.91, image: 'belt', width: 1920, height: 1080 };
const BOX = { type: 'box', x1: 300, y1: 120, x2: 520, y2: 410, present: 0.95, confidence: 0.88, image: 'belt', width: 1920, height: 1080 };

function client(replies: Reply[] = [{ status: 200, body: { model: 'decisionnode-moe-0.9.0-rc1', answers: {} } }]) {
  const f = fakeFetch(replies);
  const dn = new DecisionNode({ apiKey: 'k', baseUrl: 'https://api.example.test', fetch: f.fetch, fetchHonoursManualRedirect: true });
  return { dn, calls: f.calls };
}

async function entriesOf(request: Parameters<DecisionNode['decide']>[0]) {
  const { dn, calls } = client();
  const err = await dn.decide(request).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as ValidationError).status).toBeNull();
  expect(calls).toHaveLength(0);
  return (err as ValidationError).entries;
}

describe('point and box', () => {
  it('builds the wire form, image and units only when given', () => {
    expect(point(PICK)).toEqual({ type: 'point', instructions: PICK });
    expect(box(DAMAGE, 'belt', 'normalized')).toEqual({ type: 'box', instructions: DAMAGE, image: 'belt', units: 'normalized' });
    expect(point(PICK, undefined, 'pixels')).toEqual({ type: 'point', instructions: PICK, units: 'pixels' });
  });

  it('reads typed answers', async () => {
    const { dn, calls } = client([
      { status: 200, body: { model: 'decisionnode-moe-0.9.0-rc1', answers: { pick: POINT, damage: BOX, any: { type: 'truth', truth: 0.96 } } } },
    ]);
    const d = await dn.decide({ images: [BELT], questions: { pick: point(PICK), damage: box(DAMAGE), any: truth('?') } });
    expect(d.answers.pick).toBeInstanceOf(PointAnswer);
    expect(d.answers.damage).toBeInstanceOf(BoxAnswer);
    const pick: PointAnswer = d.answers.pick;
    const damage: BoxAnswer = d.answers.damage;
    expect([pick.x, pick.y, pick.present, pick.confidence, pick.image, pick.width, pick.height]).toEqual([812, 455, 0.97, 0.91, 'belt', 1920, 1080]);
    expect([damage.x1, damage.y1, damage.x2, damage.y2]).toEqual([300, 120, 520, 410]);
    expect(JSON.parse(calls[0]!.body!).questions.pick).toEqual({ type: 'point', instructions: PICK });
  });

  it.each([
    ['a missing field', { ...POINT, confidence: undefined }],
    ['a boolean coordinate', { ...POINT, x: true }],
    ['an image that is not a string', { ...POINT, image: 1 }],
    ['a string corner', { ...BOX, x2: '520' }],
  ])('reads %s as UnknownAnswer', (_name, raw) => {
    expect(parseAnswer(JSON.parse(JSON.stringify(raw)))).toBeInstanceOf(UnknownAnswer);
  });

  it('checks the image rules and units before sending', async () => {
    const loc = ['body', 'questions', 'pick', 'point'];
    const q = { type: 'point', instructions: PICK };
    expect(await entriesOf({ state: 's', questions: { pick: point(PICK) } })).toEqual([
      { type: 'image_required', loc, msg: 'A point question needs an image in the request', input: q },
    ]);
    expect(await entriesOf({ images: [BELT, DOCK], questions: { pick: point(PICK) } })).toEqual([
      { type: 'missing', loc: [...loc, 'image'], msg: 'Field required', input: q },
    ]);
    expect(
      await entriesOf({ images: [BELT, DOCK], questions: { pick: { type: 'point', instructions: PICK, image: 'crate', units: 'inches' } } }),
    ).toEqual([
      { type: 'unknown_image', loc: [...loc, 'image'], msg: 'Input should be the id of an image of the request', input: 'crate' },
      {
        type: 'literal_error',
        loc: [...loc, 'units'],
        msg: "Input should be 'pixels' or 'normalized'",
        input: 'inches',
        ctx: { expected: "'pixels' or 'normalized'" },
      },
    ]);
    expect(await entriesOf({ images: [BELT], questions: { pick: { type: 'point', instructions: PICK, image: 0 } } })).toEqual([
      { type: 'string_type', loc: [...loc, 'image'], msg: 'Input should be a valid string', input: 0 },
    ]);
  });

  it('refuses missing instructions, and checks clean requests', async () => {
    const { dn, calls } = client();
    const err = await dn.decide({ images: [BELT], questions: { pick: { type: 'point' } } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect([(err as BadRequestError).message, (err as BadRequestError).errorType]).toEqual(['Point question must have instructions: pick', null]);
    await dn.checkRequest('decide', { images: [BELT], questions: { pick: point(PICK) } });
    await dn.checkRequest('decide', { images: [BELT, DOCK], questions: { pick: point(PICK, 'belt'), pallet: box('?', 'dock') } });
    await expect(dn.batches.create([{ customId: 'c1', state: 's', questions: { damage: box(DAMAGE) } }])).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });
});
