// The README's boosters and fine-tuned model examples, compiled so they stay correct.
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
  type ModelInfo,
} from '../../src/index.js';

export async function readme13() {
  const dn = new DecisionNode();

  const d = await dn.decide({
    images: [
      Image.fromUrl('a1b2', 'https://files.example.com/a1b2.jpg'),
      Image.fromUrl('c3d4', 'https://files.example.com/c3d4.jpg'),
    ],
    boosters: ['age', new Booster('ai_generated', { images: ['c3d4'], require: true })],
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
  const generated = d.evidence?.ai_generated?.results[0];
  if (generated instanceof AiGeneratedReading) {
    const top: string | undefined = generated.topGenerator?.name;
    void [generated.generated, generated.method, generated.c2paSigner, top];
  }
  const tokens: number | null = d.usage.boosterTokens;
  const calls: number | null = d.usage.boosters;

  // Names this version does not know are sent as given, as are wire-form objects.
  await dn.decide({ questions: { q: truth('?') }, boosters: ['moderation', { booster: 'age', images: ['a1b2'] }] });

  try {
    await dn.decide({ images: [], questions: { q: truth('?') }, boosters: [new Booster('age', { require: true })] });
  } catch (err) {
    if (err instanceof OverloadedError && err.errorType === 'booster_unavailable') {
      const status: BoosterStatus | undefined = err.boosters.age;
      void status?.status;
    }
  }

  const tuned = await dn.decide({ model: 'decisionnode-1.0-flash@acme/fraud', questions: { q: truth('?') } });
  const pinned: string = tuned.model;
  const models: ModelInfo[] = await dn.models();
  const fineTuned = models.filter((m) => m.fineTuned === true).map((m) => [m.base, m.adapterVersion, m.status]);
  return [adult, tokens, calls, pinned, fineTuned];
}
