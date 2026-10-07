import { describe, expect, it } from 'vitest';

import { choice, score, truth } from '../../src/index.js';

describe('truth', () => {
  it('leaves out criteria when neither side is given', () => {
    expect(truth('Escalate?')).toEqual({ type: 'truth', instructions: 'Escalate?' });
  });

  it('sends one side alone', () => {
    expect(truth('Refund?', 'asks for money back')).toEqual({
      type: 'truth',
      instructions: 'Refund?',
      criteria: { true: 'asks for money back' },
    });
    expect(truth('Refund?', undefined, 'anything else')).toEqual({
      type: 'truth',
      instructions: 'Refund?',
      criteria: { false: 'anything else' },
    });
  });

  it('accepts criteria without instructions', () => {
    expect(truth(undefined, 'damaged', 'fine')).toEqual({ type: 'truth', criteria: { true: 'damaged', false: 'fine' } });
  });

  it('keeps structured instructions as given', () => {
    const instructions = { question: 'Same person?', compare: ['a.name', 'b.name'] };
    expect(truth(instructions).instructions).toBe(instructions);
  });
});

describe('choice', () => {
  it('turns a list of names into null descriptions', () => {
    expect(choice('Which currency?', ['SEK', 'NOK'])).toEqual({
      type: 'choice',
      instructions: 'Which currency?',
      criteria: { SEK: null, NOK: null },
    });
  });

  it('keeps names byte for byte, the empty name included', () => {
    const q = choice('?', { '': 'none', ' padded ': 'x', $1: 'y' });
    expect(Object.keys(q.criteria)).toEqual(['', ' padded ', '$1']);
  });

  it('treats __proto__ as an ordinary option name', () => {
    const q = choice('?', ['__proto__', 'other']);
    expect(Object.keys(q.criteria)).toEqual(['__proto__', 'other']);
    expect(JSON.stringify(q.criteria)).toBe('{"__proto__":null,"other":null}');
  });

  it('copies the options map', () => {
    const options = { a: 1 };
    const q = choice('?', options);
    options.a = 2;
    expect(q.criteria).toEqual({ a: 1 });
  });
});

describe('score', () => {
  it('sends levels low to high', () => {
    expect(score('How urgent?', ['routine', 'today', { what: 'urgent' }])).toEqual({
      type: 'score',
      instructions: 'How urgent?',
      criteria: ['routine', 'today', { what: 'urgent' }],
    });
  });

  it('leaves out null instructions', () => {
    expect(score(null, ['low', 'high'])).toEqual({ type: 'score', criteria: ['low', 'high'] });
  });
});
