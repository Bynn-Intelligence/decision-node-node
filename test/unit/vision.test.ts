import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Booster, Decision, DecisionNode, DepthReading, SegmentReading, UnknownReading, truth } from '../../src/index.js';
import { OK_TRUTH, fakeFetch } from './helpers.js';

const ENV = ['DECISIONNODE_API_KEY', 'DECISIONNODE_BASE_URL', 'DECISIONNODE_MODEL'];

beforeEach(() => ENV.forEach((v) => delete process.env[v]));
afterEach(() => ENV.forEach((v) => delete process.env[v]));

type Json = Record<string, unknown>;

const DEPTH: Json = {
  image: 'front',
  ahead: 3.21,
  directions: [5.12, 4.03, null, 2.81, 6.02, 7.15, 9.33],
  ground: true,
  grid_rows: 2,
  grid_cols: 2,
  grid: [
    [10.1, 10.2],
    [3.4, 2.05],
  ],
  depth_min: 2.05,
  depth_max: 14.98,
  depth_median: 4.37,
  width: 810,
  height: 1080,
};

const GATE: Json = {
  label: 'purple octagonal frame on a pole',
  score: 0.812,
  box: [0.31, 0.2, 0.69, 0.85],
  polygon: [
    [0.31, 0.2],
    [0.69, 0.2],
    [0.69, 0.85],
    [0.31, 0.85],
  ],
  area: 0.10512,
  centroid: [0.5004, 0.5251],
  opening: {
    polygon: [
      [0.36, 0.3],
      [0.64, 0.3],
      [0.64, 0.75],
      [0.36, 0.75],
    ],
    centroid: [0.5, 0.525],
    width: 0.28,
    height: 0.45,
    offset: [0.0, 0.0],
    area: 0.126,
  },
  depth: { median: 5.05, opening_median: 10.5, opening_rim_median: 5.1 },
  size_m: { width: 2.45, height: 2.33, opening: { width: 1.82, height: 1.63 } },
};

const PAD: Json = {
  label: 'landing pad',
  score: 0.37,
  box: [0.4, 0.6, 0.6, 0.9],
  polygon: [
    [0.4, 0.6],
    [0.6, 0.6],
    [0.6, 0.9],
  ],
  area: 0.04,
  centroid: [0.5, 0.75],
  opening: null,
  depth: { median: 7.2, opening_median: null, opening_rim_median: null },
  size_m: { width: 1.2, height: 1.1, opening: null },
};

const SEGMENT: Json = {
  image: 'front',
  width: 1280,
  height: 720,
  prompts: ['purple octagonal frame on a pole', 'landing pad'],
  instances: [GATE, PAD],
  depth_source: 'bynn_depth',
  assumed_hfov_deg: 65.0,
};

function readings(booster: string, results: unknown[]) {
  const d = new Decision({ model: 'm', answers: {}, evidence: { [booster]: { version: `${booster}-v1`, status: 'ok', latency_ms: 60, results } } }, {});
  return d.evidence![booster]!.results;
}

/** A copy of `base` with the value at `path` replaced, or removed when `value` is `REMOVE`. */
const REMOVE = Symbol('remove');
function changed(base: Json, path: Array<string | number>, value: unknown): Json {
  const out = structuredClone(base);
  let node = out as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  const last = path[path.length - 1]!;
  if (value === REMOVE) delete node[last];
  else node[last] = value;
  return out;
}

describe('bynn_depth readings', () => {
  it('reads every field', () => {
    const [r] = readings('bynn_depth', [DEPTH]);
    expect(r).toBeInstanceOf(DepthReading);
    const d = r as DepthReading;
    expect([d.image, d.ahead, d.ground]).toEqual(['front', 3.21, true]);
    expect(d.directions).toEqual([5.12, 4.03, null, 2.81, 6.02, 7.15, 9.33]);
    expect([d.gridRows, d.gridCols, d.grid]).toEqual([2, 2, [[10.1, 10.2], [3.4, 2.05]]]);
    expect([d.depthMin, d.depthMax, d.depthMedian, d.width, d.height]).toEqual([2.05, 14.98, 4.37, 810, 1080]);
    expect(d.raw).toEqual(DEPTH);
  });

  it('reads nothing ahead as a reading', () => {
    const open = changed(changed(DEPTH, ['ahead'], null), ['directions'], Array(7).fill(null));
    const [r] = readings('bynn_depth', [open]);
    expect(r).toBeInstanceOf(DepthReading);
    expect([(r as DepthReading).ahead, (r as DepthReading).directions]).toEqual([null, Array(7).fill(null)]);
  });

  it('keeps an unreadable picture generic', () => {
    const [r] = readings('bynn_depth', [{ image: 'front', readable: false }]);
    expect(r).toBeInstanceOf(UnknownReading);
    expect([(r as UnknownReading).image, r!.raw]).toEqual(['front', { image: 'front', readable: false }]);
  });

  it('reads a missing ahead as null', () => {
    const [r] = readings('bynn_depth', [changed(DEPTH, ['ahead'], REMOVE)]);
    expect(r).toBeInstanceOf(DepthReading);
    expect((r as DepthReading).ahead).toBeNull();
  });

  const malformed: Array<[Array<string | number>, unknown]> = [
    [['ahead'], 'near'],
    [['directions'], 'left'],
    [['directions'], Array(6).fill(1.0)],
    [['directions'], Array(8).fill(1.0)],
    [['directions', 0], 'far'],
    [['ground'], 1],
    [['grid_rows'], 2.5],
    [['grid'], [[1.0, 'x']]],
    [['grid'], [1.0, 2.0]],
    [['depth_median'], null],
    [['width'], '810'],
    [['image'], 3],
  ];
  for (const [path, value] of malformed) {
    it(`reads ${path.join('.')} = ${String(value === REMOVE ? 'missing' : JSON.stringify(value))} as generic`, () => {
      const raw = changed(DEPTH, path, value);
      const [r] = readings('bynn_depth', [raw]);
      expect(r).toBeInstanceOf(UnknownReading);
      expect(r!.raw).toEqual(raw);
    });
  }
});

describe('bynn_segment readings', () => {
  it('reads every field', () => {
    const [r] = readings('bynn_segment', [SEGMENT]);
    expect(r).toBeInstanceOf(SegmentReading);
    const s = r as SegmentReading;
    expect([s.image, s.width, s.height, s.prompts]).toEqual(['front', 1280, 720, SEGMENT.prompts]);
    expect([s.depthSource, s.assumedHfovDeg]).toEqual(['bynn_depth', 65.0]);
    const [gate, pad] = s.instances;
    expect(gate).toEqual({
      label: 'purple octagonal frame on a pole',
      score: 0.812,
      box: [0.31, 0.2, 0.69, 0.85],
      polygon: [
        [0.31, 0.2],
        [0.69, 0.2],
        [0.69, 0.85],
        [0.31, 0.85],
      ],
      area: 0.10512,
      centroid: [0.5004, 0.5251],
      opening: {
        polygon: [
          [0.36, 0.3],
          [0.64, 0.3],
          [0.64, 0.75],
          [0.36, 0.75],
        ],
        centroid: [0.5, 0.525],
        width: 0.28,
        height: 0.45,
        offset: [0.0, 0.0],
        area: 0.126,
      },
      depth: { median: 5.05, openingMedian: 10.5, openingRimMedian: 5.1 },
      sizeM: { width: 2.45, height: 2.33, opening: { width: 1.82, height: 1.63 } },
    });
    expect(pad!.opening).toBeNull();
    expect(pad!.sizeM).toEqual({ width: 1.2, height: 1.1, opening: null });
    expect(pad!.depth).toEqual({ median: 7.2, openingMedian: null, openingRimMedian: null });
  });

  it('reads no depth and no instances as readings', () => {
    const noDepth = { ...GATE, depth: null, size_m: null };
    const [r] = readings('bynn_segment', [{ ...SEGMENT, instances: [noDepth], depth_source: null }]);
    expect(r).toBeInstanceOf(SegmentReading);
    const s = r as SegmentReading;
    expect([s.depthSource, s.instances[0]!.depth, s.instances[0]!.sizeM]).toEqual([null, null, null]);
    const [empty] = readings('bynn_segment', [{ ...SEGMENT, instances: [] }]);
    expect(empty).toBeInstanceOf(SegmentReading);
    expect((empty as SegmentReading).instances).toEqual([]);
  });

  const absent: Array<[Array<string | number>, (s: SegmentReading) => unknown]> = [
    [['depth_source'], (s) => s.depthSource],
    [['assumed_hfov_deg'], (s) => s.assumedHfovDeg],
    [['instances', 0, 'opening'], (s) => s.instances[0]!.opening],
    [['instances', 0, 'depth'], (s) => s.instances[0]!.depth],
    [['instances', 0, 'depth', 'opening_median'], (s) => s.instances[0]!.depth!.openingMedian],
    [['instances', 0, 'size_m'], (s) => s.instances[0]!.sizeM],
    [['instances', 0, 'size_m', 'opening'], (s) => s.instances[0]!.sizeM!.opening],
  ];
  for (const [path, read] of absent) {
    it(`reads a missing ${path.join('.')} as null`, () => {
      const [r] = readings('bynn_segment', [changed(SEGMENT, path, REMOVE)]);
      expect(r).toBeInstanceOf(SegmentReading);
      expect(read(r as SegmentReading)).toBeNull();
    });
  }

  const malformed: Array<[Array<string | number>, unknown]> = [
    [['prompts'], 'gate'],
    [['prompts', 0], 7],
    [['instances'], { label: 'gate' }],
    [['depth_source'], 5],
    [['assumed_hfov_deg'], 'wide'],
    [['width'], 1280.5],
    [['instances', 0, 'label'], null],
    [['instances', 0, 'box'], [0.1, 0.2, 0.3]],
    [['instances', 0, 'polygon'], [[0.1, 0.2, 0.3]]],
    [['instances', 0, 'centroid'], { x: 0.5, y: 0.5 }],
    [['instances', 0, 'opening'], 'hole'],
    [['instances', 0, 'opening', 'offset'], [0.0]],
    [['instances', 0, 'opening', 'area'], REMOVE],
    [['instances', 0, 'depth'], 5.05],
    [['instances', 0, 'depth', 'opening_median'], 'far'],
    [['instances', 0, 'size_m'], [2.45, 2.33]],
    [['instances', 0, 'size_m', 'width'], REMOVE],
    [['instances', 0, 'size_m', 'opening'], 1.82],
    [['instances', 0, 'size_m', 'opening', 'width'], null],
  ];
  for (const [path, value] of malformed) {
    it(`reads ${path.join('.')} = ${String(value === REMOVE ? 'missing' : JSON.stringify(value))} as generic`, () => {
      const raw = changed(SEGMENT, path, value);
      const [r] = readings('bynn_segment', [raw]);
      expect(r).toBeInstanceOf(UnknownReading);
      expect(r!.raw).toEqual(raw);
    });
  }
});

describe('Depth Vision and Segment Vision options', () => {
  it('are sent as given', async () => {
    const f = fakeFetch([OK_TRUTH]);
    const dn = new DecisionNode({ apiKey: 'dn_test', baseUrl: 'https://api.example.test', fetch: f.fetch, fetchHonoursManualRedirect: true, sleep: async () => {} });
    await dn.decide({
      state: 's',
      questions: { q: truth('?') },
      boosters: [
        new Booster('bynn_depth', { options: { grid_size: 16 } }),
        new Booster('bynn_segment', { options: { prompt: ['landing pad', 'person'], depth: false } }),
      ],
    });
    expect(JSON.parse(f.calls[0]!.body!).boosters).toEqual([
      { name: 'bynn_depth', options: { grid_size: 16 } },
      { name: 'bynn_segment', options: { prompt: ['landing pad', 'person'], depth: false } },
    ]);
  });
});
