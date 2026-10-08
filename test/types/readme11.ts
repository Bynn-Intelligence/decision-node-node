// The README's examples of sessions, batches, uploads and number questions, compiled so they stay correct.
import {
  DecisionNode,
  FrameError,
  Image,
  NumberAnswer,
  Reply,
  SessionClosed,
  choice,
  number,
  score,
  truth,
  type BatchResult,
  type Frame,
} from '../../src/index.js';

declare const review: string;
declare const base64Text: string;
declare const bytes: Uint8Array;
declare const drone: AsyncIterable<{ battery: number }>;
declare const tickets: Array<{ id: string; text: string }>;

export async function readme11() {
  const dn = new DecisionNode({ inlineThreshold: 524_288 });

  const d = await dn.decide({
    state: { ticket: 'I was charged twice and nobody has replied for 3 days.' },
    questions: {
      route: choice('Where should this go?', { billing: 'money', bug: 'broken', account: 'login' }),
      urgency: score('How urgent is this?', ['routine', 'today', 'urgent', 'critical']),
      escalate: truth('Escalate to a human now?'),
      days: number('How many days has the customer waited?', 0, 30),
    },
  });
  const days: number = d.answers.days.number;
  const dist: Record<string, number> = d.answers.days.probabilities;
  void days;
  void dist;

  const rating: NumberAnswer = await dn.number({ state: review, instructions: 'Rating out of 5, in halves?', min: 0, max: 5, step: 0.5 });
  void rating.expected;

  await dn.decide({
    state: { claim: { total: '740.00', currency: 'SEK' } },
    images: [
      Image.fromUrl('receipt', 'https://files.example.com/claims/4411/receipt.jpg'),
      Image.fromPath('receipt2', './receipt.jpg'),
      Image.fromBytes('photo', bytes),
      Image.fromBase64('photo2', base64Text),
      Image.fromUploadId('photo3', 'upl_0'),
    ],
    questions: { total_matches: truth('Does the total on the receipt equal the total in the claim?') },
  });
  const ids: string[] = await dn.upload([Image.fromBytes('photo', bytes)]);
  void ids;

  const session = await dn.openSession({
    instructions: 'You are the mission supervisor of a survey drone.',
    state: { mission: 'Survey the north field' },
    questions: {
      mode: choice('Which flight mode now?', { continue: 'keep flying', hold: 'hover', return: 'fly home', land: 'land now' }),
      abort: truth('Should the mission be aborted now?'),
    },
  });
  await session.connect();
  const seq: number = await session.send({ frame: { battery: 0.31, wind_mps: 11.4 } });
  void seq;
  await session.send({ frame: 'Obstacle ahead.', image: Image.fromPath('camera', './frame.jpg') });
  for await (const event of session.replies()) {
    if (event instanceof Reply) console.log(event.seq, event.answers.mode);
    else if (event instanceof FrameError) console.warn(event.seq, event.errorType, event.message);
    else {
      const closed: SessionClosed = event;
      void closed.reopen;
      break;
    }
  }
  await session.end();

  async function* readings(): AsyncGenerator<Frame> {
    for await (const telemetry of drone) yield { frame: telemetry };
  }
  const closed = await dn.supervise({ questions: { abort: truth('Abort?') } }, readings(), (event) => console.log(event));
  void closed?.code;

  const { batch, results } = await dn.runBatch(
    tickets.map((t) => ({ customId: t.id, state: t.text, questions: { route: choice('Where?', ['billing', 'bug']) } })),
    { pollInterval: 60_000 },
  );
  void batch.counters.completed;
  for await (const r of results) {
    const line: BatchResult = r;
    if (line.decision) console.log(line.customId, line.decision.answers.route);
    else console.warn(line.customId, line.status, line.error?.message);
  }
  const page = await dn.batches.list({ limit: 10 });
  void page.nextOffset;

  const checked = new DecisionNode({ uploadTimeout: 60_000, webSocketOptions: { dispatcher: {} } });
  await checked.checkRequest('decide', { state: 's', questions: { q: truth('?') }, images: [Image.fromBytes('a', bytes)] });
  await checked.checkRequest('openSession', { questions: { a: truth('?') }, window: 8 });
  await checked.checkRequest('batches.create', [{ customId: 'a', questions: { q: truth('?') } }]);
  await session.checkFrame({ frame: { battery: 0.3 }, questions: ['abort'] });
}
