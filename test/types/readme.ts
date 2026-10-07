// The README's examples, compiled so they stay correct.
import {
  ContextLimitError,
  DecisionNode,
  DecisionNodeError,
  Image,
  RefusalError,
  choice,
  score,
  truth,
  type FetchLike,
} from '../../src/index.js';

declare const customFetch: FetchLike;
declare const bytes: Uint8Array;
declare const tickets: string[];
declare const state: unknown;
declare const questions: { q: ReturnType<typeof truth> };

export async function readme() {
  const dn = new DecisionNode();

  const d = await dn.decide({
    state: { ticket: 'I was charged twice and nobody has replied for 3 days.' },
    questions: {
      route: choice('Where should this go?', { billing: 'money', bug: 'broken', account: 'login' }),
      urgency: score('How urgent is this?', ['routine', 'today', 'urgent', 'critical']),
      escalate: truth('Escalate to a human now?'),
    },
  });
  const route: 'billing' | 'bug' | 'account' = d.answers.route.choice;
  const p: number = d.answers.route.probabilities.billing;
  const s: number = d.answers.urgency.score + d.answers.escalate.truth + p;
  void route;
  void s;

  await dn.decide({
    state: 'Paid 740 SEK at Nordic Rail.',
    questions: {
      currency: { type: 'choice', instructions: 'Which currency?', criteria: { SEK: null, NOK: null, EUR: null } },
    },
  });

  new DecisionNode({
    apiKey: 'your-api-key',
    baseUrl: 'https://example.com',
    model: 'decisionnode-latest',
    timeout: 10_000,
    maxRetries: 2,
    headers: { 'x-team': 'support' },
    fetch: customFetch,
    fetchHonoursManualRedirect: true,
  });

  const results = await dn.decideMany(
    tickets.map((ticket) => ({ state: ticket, questions: { spam: truth('Is this spam?') } })),
    { concurrency: 8 },
  );
  for (const r of results) {
    if (r instanceof Error) console.error(r.message);
    else console.log(r.answers.spam.truth);
  }

  const g = await dn.gate({ action: 'DROP TABLE invoices;', context: { environment: 'production' } });
  const verdict: 'allow' | 'confirm' | 'block' = g.answers.verdict.choice;
  void verdict;
  void g.answers.risk.score;

  await dn.decideRaw({
    model: 'decisionnode-latest',
    state: 'Customer: refund me.',
    questions: { refund: { type: 'truth', instructions: 'Is this a refund request?' } },
  });

  await dn.decide({
    state: { claim: { total: '740.00', currency: 'SEK' } },
    images: [
      Image.fromPath('receipt', './receipt.jpg'),
      Image.fromBytes('photo', bytes, 'image/png'),
      Image.fromUrl('scan', 'https://example.com/scan.webp'),
    ],
    questions: { total_matches: truth('Does the total on the receipt equal the total in the claim?') },
  });

  try {
    await dn.decide({ state, questions });
  } catch (err) {
    if (err instanceof ContextLimitError) console.error('Too long:', err.reason);
    else if (err instanceof RefusalError) console.error('Refused:', err.category);
    else if (err instanceof DecisionNodeError) console.error(err.status, err.message, err.requestId);
    else throw err;
  }

  const safety = d.safety;
  if (safety?.checked) console.log(safety.harm, safety.selfHarm, safety.flagged);
  else if (safety) console.log(safety.reason);

  const models = await dn.models();
  models.map((m) => [m.name, m.limits]);

  new DecisionNode({ logger: (line) => console.debug(line) });
  await dn.check({ state: 's', instructions: '?' }, { signal: AbortSignal.timeout(1000) });
}
