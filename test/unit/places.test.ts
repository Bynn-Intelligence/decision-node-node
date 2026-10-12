import { describe, expect, it } from 'vitest';

import {
  BoxesAnswer,
  DecisionNode,
  Image,
  PointsAnswer,
  UnknownAnswer,
  ValidationError,
  box,
  parseAnswer,
  point,
  truth,
} from '../../src/index.js';
import { fakeFetch, type Reply } from './helpers.js';

const LOT = Image.fromUrl('lot', 'https://files.example.com/lot/0917.jpg');
const CARS = 'Every car in the lot.';
const OK: Reply = { status: 200, body: { model: 'decisionnode-moe-0.9.0-rc1', answers: {} } };
const BOXES = {
  type: 'box',
  count: 2,
  present: 0.99,
  complete: 0.94,
  boxes: [
    { x1: 112, y1: 400, x2: 388, y2: 590, confidence: 0.91 },
    { x1: 402, y1: 395, x2: 660, y2: 598, confidence: 0.9 },
  ],
  image: 'lot',
  width: 1920,
  height: 1080,
};
const POINTS = {
  type: 'point',
  count: 2,
  present: 0.97,
  complete: 0.99,
  points: [
    { x: 0.3333, y: 0.474, confidence: 0.88 },
    { x: 0.6302, y: 0.4907, confidence: 0.85 },
  ],
  image: 'lot',
  width: 1920,
  height: 1080,
};

function client(replies: Reply[] = [OK]) {
  const f = fakeFetch(replies);
  const dn = new DecisionNode({ apiKey: 'k', baseUrl: 'https://api.example.test', fetch: f.fetch, fetchHonoursManualRedirect: true });
  return { dn, calls: f.calls };
}

async function entriesOf(dn: DecisionNode, max: unknown) {
  const err = await dn.decide({ images: [LOT], questions: { cars: { type: 'box', instructions: CARS, max } } }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ValidationError);
  return (err as ValidationError).entries;
}

describe('several places', () => {
  it('sends max only when given, and types the answer from a question with max', async () => {
    expect(box(CARS, 'lot', null, 8)).toEqual({ type: 'box', instructions: CARS, image: 'lot', max: 8 });
    expect(point('Each person.', undefined, 'normalized', 6)).toEqual({ type: 'point', instructions: 'Each person.', units: 'normalized', max: 6 });
    expect(box(CARS)).toEqual({ type: 'box', instructions: CARS });
    const { dn, calls } = client([{ status: 200, body: { model: 'decisionnode-moe-0.9.0-rc1', answers: { cars: BOXES } } }]);
    const d = await dn.decide({ images: [LOT], questions: { cars: box(CARS, 'lot', null, 8) } });
    const cars: BoxesAnswer = d.answers.cars;
    expect(cars).toBeInstanceOf(BoxesAnswer);
    expect(JSON.parse(calls[0]!.body!).questions.cars.max).toBe(8);
  });

  it('reads several boxes and normalized points in order, numbers as sent', () => {
    const b = parseAnswer(BOXES) as BoxesAnswer;
    expect(b).toBeInstanceOf(BoxesAnswer);
    expect([b.count, b.present, b.complete, b.image, b.width, b.height]).toEqual([2, 0.99, 0.94, 'lot', 1920, 1080]);
    expect(b.boxes).toEqual(BOXES.boxes);
    const p = parseAnswer(POINTS) as PointsAnswer;
    expect(p).toBeInstanceOf(PointsAnswer);
    expect(p.points).toEqual(POINTS.points);
  });

  it('reads none found as an empty list', () => {
    const none = parseAnswer({ ...BOXES, count: 0, present: 0.03, boxes: [] }) as BoxesAnswer;
    expect(none).toBeInstanceOf(BoxesAnswer);
    expect([none.count, none.boxes]).toEqual([0, []]);
  });

  it('reads a malformed several-places answer as UnknownAnswer', () => {
    const bad = [
      { ...BOXES, count: '3' },
      { ...BOXES, count: 1.5 },
      { ...BOXES, boxes: [{ x1: 1, y1: 2, x2: 3, y2: 4 }] },
      { ...POINTS, complete: undefined },
      { ...POINTS, points: { x: 1, y: 2, confidence: 0.5 } },
      { ...BOXES, boxes: undefined, points: POINTS.points },
      { ...POINTS, present: true },
    ];
    for (const raw of bad) expect(parseAnswer(raw)).toBeInstanceOf(UnknownAnswer);
  });

  it('refuses a max that is not an integer, under 2 or over 16, sending nothing', async () => {
    const { dn, calls } = client();
    const loc = ['body', 'questions', 'cars', 'box', 'max'];
    for (const max of [2.5, '8', true]) {
      expect(await entriesOf(dn, max)).toEqual([{ type: 'int_type', loc, msg: 'Input should be a valid integer', input: max }]);
    }
    expect(await entriesOf(dn, 1)).toEqual([
      { type: 'greater_than_equal', loc, msg: 'Input should be greater than or equal to 2', input: 1, ctx: { ge: 2 } },
    ]);
    expect(await entriesOf(dn, 17)).toEqual([
      { type: 'less_than_equal', loc, msg: 'Input should be less than or equal to 16', input: 17, ctx: { le: 16 } },
    ]);
    await expect(dn.decide({ images: [LOT], questions: { cars: box(CARS, 'lot', null, 16) } })).resolves.toBeDefined();
    expect(calls).toHaveLength(1);
  });

  it('refuses max locally when the held model entry states no places, but not on a session open', async () => {
    const off = { name: 'decisionnode-moe', version: 'decisionnode-moe-0.9.0-rc1', alias: 'decisionnode-moe', places: { max_places: 0 } };
    const { dn, calls } = client([{ status: 200, body: { models: [off] } }, OK]);
    await dn.models();
    const err = await dn
      .decide({ images: [LOT], questions: { cars: box(CARS, 'lot', null, 8), people: point('Each person.', 'lot', null, 6), ok: truth('?') } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).entries).toEqual([
      { type: 'not_supported', loc: ['body', 'questions', 'cars', 'box', 'max'], msg: 'Several places are not supported by this model version', input: 8 },
      { type: 'not_supported', loc: ['body', 'questions', 'people', 'point', 'max'], msg: 'Several places are not supported by this model version', input: 6 },
    ]);
    await expect(dn.checkRequest('openSession', { questions: { cars: box(CARS, undefined, null, 8) } })).resolves.toBeUndefined();
    await expect(dn.decide({ images: [LOT], questions: { cars: box(CARS) } })).resolves.toBeDefined();
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
  });

  it('sends max when the held entry states places, and leaves it to the server when nothing is held', async () => {
    const on = { name: 'decisionnode-moe', version: 'decisionnode-moe-0.9.0-rc1', alias: 'decisionnode-moe', places: { max_places: 16 } };
    const held = client([{ status: 200, body: { models: [on] } }, OK]);
    await held.dn.models();
    await expect(held.dn.decide({ images: [LOT], questions: { cars: box(CARS, 'lot', null, 8) } })).resolves.toBeDefined();
    const fresh = client();
    await expect(fresh.dn.decide({ images: [LOT], questions: { cars: box(CARS, 'lot', null, 8) } })).resolves.toBeDefined();
    expect(fresh.calls).toHaveLength(1);
  });
});
