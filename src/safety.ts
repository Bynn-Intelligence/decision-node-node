/**
 * What the hosted API's safety check found for a request, parsed from the
 * `x-decisionnode-safety` response header.
 */
export type Safety = CheckedSafety | UncheckedSafety;

export interface CheckedSafety {
  checked: true;
  /** Probability of the `harm` category, as sent. */
  harm: number | null;
  /** Probability of the `self_harm` category, as sent. */
  selfHarm: number | null;
  /** The categories above your key's thresholds (wire names, header order). */
  flagged: string[];
}

export interface UncheckedSafety {
  checked: false;
  /** Why the check did not run, as a short code. */
  reason: string | null;
}

interface Member {
  name: string;
  value: string | null;
  params: Map<string, string | null>;
}

/** Splits on `sep` outside double-quoted strings. */
function splitOutsideQuotes(text: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      cur += ch;
      if (ch === '\\' && i + 1 < text.length) {
        cur += text[++i];
      } else if (ch === '"') {
        quoted = false;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      cur += ch;
    } else if (ch === sep) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return v;
}

function parseMember(text: string): Member | null {
  const parts = splitOutsideQuotes(text, ';');
  const head = parts[0]!.trim();
  if (!head) return null;
  const eq = head.indexOf('=');
  const name = (eq === -1 ? head : head.slice(0, eq)).trim();
  const value = eq === -1 ? null : head.slice(eq + 1).trim();
  const params = new Map<string, string | null>();
  for (const p of parts.slice(1)) {
    const t = p.trim();
    if (!t) continue;
    const i = t.indexOf('=');
    if (i === -1) params.set(t, null);
    else params.set(t.slice(0, i).trim(), unquote(t.slice(i + 1)));
  }
  return { name, value, params };
}

function toNumber(value: string | null): number | null {
  if (value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parses the safety header. Returns `null` when the header is absent, which is
 * what a self-hosted server without the check sends.
 */
export function parseSafety(header: string | null | undefined): Safety | null {
  if (header === null || header === undefined) return null;
  const members = splitOutsideQuotes(header, ',')
    .map(parseMember)
    .filter((m): m is Member => m !== null);

  const unchecked = members.find((m) => m.name === 'unchecked');
  if (unchecked) {
    return { checked: false, reason: unchecked.params.get('reason') ?? null };
  }

  const out: CheckedSafety = { checked: true, harm: null, selfHarm: null, flagged: [] };
  for (const m of members) {
    if (m.name === 'harm') out.harm = toNumber(m.value);
    else if (m.name === 'self_harm') out.selfHarm = toNumber(m.value);
    if (m.params.has('flagged') || m.params.has('blocked')) out.flagged.push(m.name);
  }
  return out;
}
