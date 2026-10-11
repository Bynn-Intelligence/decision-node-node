// The README's boosters, fine-tuned model and fallback examples, compiled so they stay correct.
import {
  AgeReading,
  AiGeneratedReading,
  Booster,
  DecisionNode,
  Image,
  OverloadedError,
  UnknownReading,
  truth,
  type BoosterStatus,
  type Fallback,
  type ModelInfo,
} from '../../src/index.js';

export async function readme13() {
  const dn = new DecisionNode();

  const d = await dn.decide({
    images: [
      Image.fromUrl('a1b2', 'https://files.example.com/a1b2.jpg'),
      Image.fromUrl('c3d4', 'https://files.example.com/c3d4.jpg'),
    ],
    boosters: ['age', 'ai_generated'],
    questions: {
      adult: truth('Is the person in the first picture an adult?'),
      synthetic: truth('Is the second picture AI-generated?'),
    },
  });

  const adult: number = d.answers.adult.truth;
  const age = d.evidence?.age;
  for (const reading of age?.results ?? []) {
    // An age booster's results are age readings, or generic ones.
    const typed: AgeReading | UnknownReading = reading;
    if (typed instanceof AgeReading && typed.faces > 0) {
      const years: number | null = typed.ageYears;
      void [years, typed.low, typed.high];
    }
  }
  const generated = d.evidence?.ai_generated?.results[1];
  if (generated instanceof AiGeneratedReading) {
    const top: string | undefined = generated.topGenerator?.name;
    void [generated.generated, generated.method, generated.c2paSigner, top];
  }
  const tokens: number | null = d.usage.boosterTokens;
  const calls: number | null = d.usage.boosters;

  // A booster that needs a setting; names this version does not know and
  // wire-form objects are sent as given.
  await dn.decide({
    images: [Image.fromUrl('c3d4', 'https://files.example.com/c3d4.jpg')],
    boosters: ['age', new Booster('ai_generated', { images: ['c3d4'], require: true })],
    questions: { q: truth('?') },
  });
  await dn.decide({ questions: { q: truth('?') }, boosters: ['moderation', { name: 'age', images: ['a1b2'] }] });

  try {
    await dn.decide({ images: [], questions: { q: truth('?') }, boosters: [new Booster('age', { require: true })] });
  } catch (err) {
    if (err instanceof OverloadedError && err.errorType === 'booster_unavailable') {
      const status: BoosterStatus | undefined = err.boosters.age;
      void status?.status;
    }
  }

  const tuned = await dn.decide({ model: 'decisionnode-moe@acme/fraud', questions: { q: truth('?') } });
  const pinned: string = tuned.model;
  const models: ModelInfo[] = await dn.models();
  const fineTuned = models.filter((m) => m.fineTuned === true).map((m) => [m.base, m.adapterVersion, m.status]);

  // The fallback: on by default, named in decision.fallback; false asks for the 529 instead.
  const main = await dn.decide({ model: 'decisionnode-moe', questions: { q: truth('?') } });
  const fellBack: Fallback | null = main.fallback;
  if (fellBack !== null) {
    const served: string = fellBack.servedModel;
    const requested: string | null = fellBack.requestedModel;
    void [served, requested];
  }
  await dn.decide({ model: 'decisionnode-moe', questions: { q: truth('?') }, fallback: false });
  return [adult, tokens, calls, pinned, fineTuned];
}
