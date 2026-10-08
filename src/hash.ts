/**
 * SHA-256 and MD5 of image bytes, for the upload cache and the presign. Uses
 * `node:crypto` where the runtime has it (Node, Bun, Deno), else Web Crypto
 * for SHA-256 and the small MD5 below.
 */

interface NodeCrypto {
  createHash(alg: string): { update(b: Uint8Array): { digest(): Uint8Array } };
}

let nodeCrypto: NodeCrypto | null | undefined;

function node(): NodeCrypto | null {
  if (nodeCrypto === undefined) {
    try {
      const g = globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } };
      nodeCrypto = (g.process?.getBuiltinModule?.('node:crypto') as NodeCrypto | undefined) ?? null;
    } catch {
      nodeCrypto = null;
    }
  }
  return nodeCrypto;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const c = node();
  if (c) return new Uint8Array(c.createHash('sha256').update(bytes).digest());
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
}

export function md5(bytes: Uint8Array): Uint8Array {
  const c = node();
  if (c) return new Uint8Array(c.createHash('md5').update(bytes).digest());
  return md5Js(bytes);
}

export function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

/** MD5 (RFC 1321) for runtimes without `node:crypto`. Exported for tests. */
export function md5Js(input: Uint8Array): Uint8Array {
  const len = input.length;
  const padded = new Uint8Array((((len + 8) >>> 6) + 1) << 6);
  padded.set(input);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (len * 8) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(len / 0x20000000), true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const m = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(off + i * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) & 15;
      }
      const t = d;
      d = c;
      c = b;
      const x = (a + f + K[i]! + m[g]!) >>> 0;
      b = (b + ((x << S[i]!) | (x >>> (32 - S[i]!)))) >>> 0;
      a = t;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true);
  ov.setUint32(4, b0, true);
  ov.setUint32(8, c0, true);
  ov.setUint32(12, d0, true);
  return out;
}
