// Runs the built package against the conformance mock in any runtime with
// fetch: Node, Deno or Bun. Needs DECISIONNODE_BASE_URL (the mock) and
// DECISIONNODE_CONFORMANCE_DIR (for an image fixture).
import { ContextLimitError, DecisionNode, Image, ValidationError, choice, score, truth } from '../../dist/index.js';

const env = (name) => (globalThis.Deno ? globalThis.Deno.env.get(name) : globalThis.process.env[name]);
const suite = env('DECISIONNODE_CONFORMANCE_DIR');
const fail = (msg) => {
  throw new Error(msg);
};

const dn = new DecisionNode({ apiKey: 'dn_test_runtime' });

const d = await dn.decide({
  state: { ticket: 'I was charged twice.' },
  questions: {
    route: choice('Where should this go?', { billing: 'money', bug: 'broken' }),
    urgency: score('How urgent?', ['routine', 'today', 'urgent']),
    escalate: truth('Escalate to a human now?'),
  },
  images: [Image.fromPath('receipt', `${suite}/fixtures/images/pixel.png`)],
});
if (!['billing', 'bug'].includes(d.answers.route.choice)) fail('route');
if (typeof d.answers.urgency.score !== 'number') fail('urgency');
if (typeof d.answers.escalate.truth !== 'number') fail('escalate');
if (!d.requestId || d.model !== 'decisionnode-1.0') fail('headers');

const models = await dn.models();
if (models.length < 2) fail('models');

const c = await dn.check({ state: 's', instructions: 'Is this fine?' });
if (c.type !== 'truth') fail('check');

try {
  await dn.decide({ questions: { q: { type: 'choice', criteria: {} } } });
  fail('expected an error');
} catch (err) {
  if (err.name !== 'BadRequestError') fail(`error class ${err.name}`);
}
// Redirects are never followed in any runtime: the 3xx itself is the error.
const redirected = new DecisionNode({ apiKey: 'dn_test_runtime', maxRetries: 0, headers: { 'x-mock-scenario': 'error/302-redirect-not-followed' } });
try {
  await redirected.decide({ questions: { q: truth('?') } });
  fail('expected a redirect error');
} catch (err) {
  if (err.name !== 'DecisionNodeError' || err.status !== 302) fail(`redirect: ${err.name} ${err.status}`);
}
if (!(new ContextLimitError('x') instanceof Error) || ValidationError.name !== 'ValidationError') fail('classes');

console.log('runtime smoke: ok');
