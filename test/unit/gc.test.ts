// Batch results read after a garbage collection: Node's fetch cancels the body of a
// response that is collected before its body is read, so the client holds the
// response with the stream until the results are read.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import v8 from 'node:v8';
import vm from 'node:vm';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DecisionNode } from '../../src/index.js';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

const LINES =
  '{"custom_id":"t1","status":200,"body":{"model":"decisionnode-moe-0.9.0-rc1","answers":{"q":{"type":"truth","truth":0.5}}},"headers":{}}\n' +
  '{"custom_id":"t2","status":200,"body":{"model":"decisionnode-moe-0.9.0-rc1","answers":{"q":{"type":"truth","truth":0.7}}},"headers":{}}\n';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/x-ndjson');
    res.end(LINES);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('batch results and garbage collection', () => {
  it('reads every line when a collection runs between results() and the first read', async () => {
    const dn = new DecisionNode({ apiKey: 'dn_test', baseUrl, maxRetries: 0 });
    for (let i = 0; i < 10; i++) {
      const results = await dn.batches.results('batch_1');
      for (let k = 0; k < 3; k++) {
        gc();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const list = await results.toArray();
      expect(list.map((r) => r.customId)).toEqual(['t1', 't2']);
    }
  });
});
