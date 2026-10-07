// Compile-time checks: answer types follow from the questions. `tsc` fails on any mismatch.
import {
  Answer,
  ChoiceAnswer,
  DecisionNode,
  ScoreAnswer,
  TruthAnswer,
  choice,
  score,
  truth,
  type Decision,
  type GateAnswers,
} from '../../src/index.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assert<T extends true>(): T | void {}

declare const dn: DecisionNode;

export async function inference() {
  const d = await dn.decide({
    state: { ticket: 'charged twice' },
    questions: {
      route: choice('Where should this go?', { billing: 'money', bug: 'broken', account: 'login' }),
      currency: choice('Which currency?', ['SEK', 'NOK']),
      urgency: score('How urgent?', ['routine', 'today', 'urgent']),
      escalate: truth('Escalate?'),
      wire: { type: 'choice', criteria: { yes: null, no: null } },
      future: { type: 'ranking', criteria: ['a', 'b'] },
    },
  });

  assert<Equal<typeof d.answers.route, ChoiceAnswer<'billing' | 'bug' | 'account'>>>();
  assert<Equal<typeof d.answers.route.choice, 'billing' | 'bug' | 'account'>>();
  assert<Equal<typeof d.answers.currency.choice, 'SEK' | 'NOK'>>();
  assert<Equal<typeof d.answers.urgency, ScoreAnswer>>();
  assert<Equal<typeof d.answers.escalate, TruthAnswer>>();
  assert<Equal<typeof d.answers.escalate.truth, number>>();
  assert<Equal<typeof d.answers.wire.choice, 'yes' | 'no'>>();
  assert<Equal<typeof d.answers.future, Answer>>();
  assert<Equal<ReturnType<typeof d.get<'route'>>, ChoiceAnswer<'billing' | 'bug' | 'account'>>>();

  // @ts-expect-error: no question with this id
  d.answers.missing;

  const c = await dn.classify({ state: 's', instructions: '?', options: ['spam', 'ham'] });
  assert<Equal<typeof c.choice, 'spam' | 'ham'>>();
  const c2 = await dn.classify({ state: 's', options: { low: null, high: 'urgent' } });
  assert<Equal<typeof c2.choice, 'low' | 'high'>>();

  const t = await dn.check({ state: 's', instructions: '?' });
  assert<Equal<typeof t, TruthAnswer>>();
  const s = await dn.score({ state: 's', levels: ['a', 'b'] });
  assert<Equal<typeof s, ScoreAnswer>>();

  const g = await dn.gate({ action: 'deploy' });
  assert<Equal<typeof g, Decision<GateAnswers>>>();
  assert<Equal<typeof g.answers.verdict.choice, 'allow' | 'confirm' | 'block'>>();

  const many = await dn.decideMany([{ questions: { q: truth('?') } }]);
  const first = many[0]!;
  if (!(first instanceof Error)) assert<Equal<typeof first.answers.q, TruthAnswer>>();

  const dynamic: Record<string, ReturnType<typeof truth>> = { a: truth('?') };
  const d2 = await dn.decide({ questions: dynamic });
  assert<Equal<(typeof d2.answers)[string], TruthAnswer>>();
}
