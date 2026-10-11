import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Booster,
  Decision,
  DecisionNode,
  FaceDetectionReading,
  TimeoutError,
  UnknownReading,
  WantedPersonReading,
  truth,
} from '../../src/index.js';
import { OK_TRUTH, fakeFetch, type Reply } from './helpers.js';

const ENV = ['DECISIONNODE_API_KEY', 'DECISIONNODE_BASE_URL', 'DECISIONNODE_MODEL'];

beforeEach(() => ENV.forEach((v) => delete process.env[v]));
afterEach(() => {
  ENV.forEach((v) => delete process.env[v]);
  vi.useRealTimers();
});

const Q = { q: truth('?') };

function client(replies: Reply[], options: { timeout?: number; maxRetries?: number } = {}) {
  const f = fakeFetch(replies);
  const dn = new DecisionNode({
    apiKey: 'dn_test',
    baseUrl: 'https://api.example.test',
    fetch: f.fetch,
    fetchHonoursManualRedirect: true,
    sleep: async () => {},
    ...options,
  });
  return { dn, calls: f.calls };
}

function evidence(name: string, results: unknown[]): Decision {
  return new Decision({ model: 'm', answers: {}, evidence: { [name]: { version: `${name}-v1`, status: 'ok', latency_ms: 30, results } } }, {});
}

describe('face_detection readings', () => {
  it('reads the count and each face, numbers as sent', () => {
    const d = evidence('face_detection', [
      { image: 'crowd', faces: 70, detections: [{ box: { x1: 10, y1: 20, x2: 110, y2: 140 }, confidence: 0.98 }] },
      { image: 'empty', faces: 0, detections: [] },
      { image: 'small', faces: 1, detections: [{ box: { x1: 0.1234, y1: 0.2, x2: 0.5, y2: 0.75 }, confidence: 0.9 }] },
    ]);
    const [crowd, empty, small] = d.evidence!.face_detection!.results as FaceDetectionReading[];
    expect(crowd).toBeInstanceOf(FaceDetectionReading);
    // faces counts every face; the list holds at most 64 of them.
    expect([crowd!.image, crowd!.faces, crowd!.detections]).toEqual(['crowd', 70, [{ box: { x1: 10, y1: 20, x2: 110, y2: 140 }, confidence: 0.98 }]]);
    expect([empty!.faces, empty!.detections]).toEqual([0, []]);
    expect(small!.detections[0]!.box).toEqual({ x1: 0.1234, y1: 0.2, x2: 0.5, y2: 0.75 });
  });

  it('reads a malformed reading as generic', () => {
    const box = { x1: 1, y1: 2, x2: 3, y2: 4 };
    const d = evidence('face_detection', [
      { image: 'a', faces: 1.5, detections: [] },
      { image: 'b', faces: -1, detections: [] },
      { image: 'c', faces: 1 },
      { image: 'd', faces: 1, detections: {} },
      { image: 'e', faces: 1, detections: ['x'] },
      { image: 'f', faces: 1, detections: [{ box: { x1: 1, y1: 2, x2: 3 }, confidence: 0.5 }] },
      { image: 'g', faces: 1, detections: [{ box, confidence: '0.5' }] },
      { image: 'h', faces: 1, detections: [{ box }] },
      { image: 1, faces: 1, detections: [] },
    ]);
    expect(d.evidence!.face_detection!.results.every((r) => r instanceof UnknownReading)).toBe(true);
  });
});

describe('wanted_person readings', () => {
  it('reads the faces checked and each match', () => {
    const d = evidence('wanted_person', [
      { image: 'gate', faces: 3, matches: [{ box: { x1: 5, y1: 6, x2: 50, y2: 60 }, score: 0.91, reference: 'ref_01.a:b-c' }] },
      { image: 'lobby', faces: 2, matches: [] },
    ]);
    const [gate, lobby] = d.evidence!.wanted_person!.results as WantedPersonReading[];
    expect(gate).toBeInstanceOf(WantedPersonReading);
    expect([gate!.faces, gate!.matches]).toEqual([3, [{ box: { x1: 5, y1: 6, x2: 50, y2: 60 }, score: 0.91, reference: 'ref_01.a:b-c' }]]);
    expect([lobby!.faces, lobby!.matches]).toEqual([2, []]);
  });

  it('reads a malformed reading as generic', () => {
    const box = { x1: 1, y1: 2, x2: 3, y2: 4 };
    const d = evidence('wanted_person', [
      { image: 'a', faces: 1 },
      { image: 'b', faces: 1, matches: [{ box, score: 0.9 }] },
      { image: 'c', faces: 1, matches: [{ box, score: 0.9, reference: 7 }] },
      { image: 'd', faces: 1, matches: [{ box, score: true, reference: 'r' }] },
      { image: 'e', faces: 1, matches: [{ box: 'x', score: 0.9, reference: 'r' }] },
      { image: 'f', faces: '1', matches: [] },
    ]);
    expect(d.evidence!.wanted_person!.results.every((r) => r instanceof UnknownReading)).toBe(true);
  });
});

describe('a decision naming ocr', () => {
  const HANG: Reply = { hang: true };
  const OVERLOADED: Reply = { status: 529, body: { detail: { error_type: 'overloaded_error', message: 'busy' } } };

  it('waits 30 s per attempt when no timeout is set, and is not retried after one', async () => {
    vi.useFakeTimers();
    const { dn, calls } = client([HANG]);
    const outcome = dn.decide({ questions: Q, boosters: ['ocr'] }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(calls).toHaveLength(1);
    let settled = false;
    void outcome.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false); // the 10 s default does not apply
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await outcome).toBeInstanceOf(TimeoutError);
    expect(calls).toHaveLength(1);
  });

  it('keeps the 10 s default and its retries for a decision without ocr', async () => {
    vi.useFakeTimers();
    const { dn, calls } = client([HANG]);
    const outcome = dn.decide({ questions: Q, boosters: ['age'] }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_100);
    expect(await outcome).toBeInstanceOf(TimeoutError);
    expect(calls).toHaveLength(3);
  });

  it('uses a set timeout as given, even below 30 s, in the object form and on a helper', async () => {
    const { dn, calls } = client([HANG], { timeout: 50 });
    const err = await dn.decide({ questions: Q, boosters: [new Booster('ocr', { options: { prompt: 'the total' } })] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(calls).toHaveLength(1);
    const helper = await dn.check({ instructions: '?', boosters: [{ name: 'ocr', require: true }] }).catch((e: unknown) => e);
    expect(helper).toBeInstanceOf(TimeoutError);
    expect(calls).toHaveLength(2);
  });

  it('is still retried on a 529', async () => {
    const { dn, calls } = client([OVERLOADED, OK_TRUTH], { timeout: 50 });
    const d = await dn.decide({ questions: Q, boosters: ['ocr'] });
    expect(d.answers.q).toBeDefined();
    expect(calls).toHaveLength(2);
  });

  it('applies per item in decideMany', async () => {
    const { dn, calls } = client([HANG], { timeout: 50, maxRetries: 1 });
    const results = await dn.decideMany(
      [
        { state: 'with ocr', questions: Q, boosters: ['ocr'] },
        { state: 'without', questions: Q },
      ],
      { concurrency: 2 },
    );
    expect(results.every((r) => r instanceof TimeoutError)).toBe(true);
    const states = calls.map((c) => (JSON.parse(c.body!) as { state: string }).state);
    expect(states.filter((s) => s === 'with ocr')).toHaveLength(1);
    expect(states.filter((s) => s === 'without')).toHaveLength(2);
  });
});
