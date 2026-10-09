import { describe, it, expect } from 'vitest';
import { calculateCost, formatCost } from '../src/utils/costCalculator.js';
import { MODEL_PRICING, getModelPricing } from '../src/config/modelPricing.js';

describe('cost calculation', () => {
  it('computes cost as inputTokens * inputPrice + outputTokens * outputPrice for a known model', () => {
    const model = 'gpt-4o';
    const pricing = MODEL_PRICING[model];

    const cost = calculateCost({ input_tokens: 1000, output_tokens: 500 }, model);

    const expected = 1000 * pricing.inputPerToken + 500 * pricing.outputPerToken;
    expect(cost).toBeCloseTo(expected, 10);
  });

  it('matches the documented gpt-4o rate exactly ($2.50/$10.00 per 1M tokens)', () => {
    // 1,000,000 input tokens should cost exactly $2.50; 1,000,000 output tokens exactly $10.00.
    const cost = calculateCost({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'gpt-4o');
    expect(cost).toBeCloseTo(2.5 + 10, 6);
  });

  it('returns 0 for a call with 0 tokens', () => {
    const cost = calculateCost({ input_tokens: 0, output_tokens: 0 }, 'gpt-4o');
    expect(cost).toBe(0);
  });

  it('scales linearly with token count', () => {
    const model = 'gpt-4o-mini';
    const small = calculateCost({ input_tokens: 100, output_tokens: 50 }, model);
    const large = calculateCost({ input_tokens: 1000, output_tokens: 500 }, model);
    expect(large).toBeCloseTo(small * 10, 10);
  });

  it('returns null (cost unknown) for an unrecognized model instead of borrowing another model\'s price', () => {
    expect(calculateCost({ input_tokens: 1000, output_tokens: 1000 }, 'some-future-model-not-in-table')).toBeNull();
  });

  it('getModelPricing returns null for an unknown model', () => {
    expect(getModelPricing('totally-made-up-model')).toBeNull();
  });

  it('prices a dated snapshot (as reported in OpenAI responses) at its base model rate', () => {
    expect(getModelPricing('gpt-4o-mini-2024-07-18')).toEqual(MODEL_PRICING['gpt-4o-mini']);
    expect(getModelPricing('gpt-4o-2024-08-06')).toEqual(MODEL_PRICING['gpt-4o']);
    expect(calculateCost({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'gpt-4o-mini-2024-07-18')).toBeCloseTo(
      0.15 + 0.6,
      6
    );
  });

  it('does not treat a different model sharing a prefix as the same model', () => {
    expect(getModelPricing('gpt-4o-mini-audio-preview')).toBeNull();
  });

  it('every configured model has strictly positive input and output prices', () => {
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
      expect(pricing.inputPerToken, `${model} inputPerToken`).toBeGreaterThan(0);
      expect(pricing.outputPerToken, `${model} outputPerToken`).toBeGreaterThan(0);
    }
  });

  it('formatCost renders a USD string with 4 decimal places', () => {
    expect(formatCost(0.0202)).toBe('$0.0202');
    expect(formatCost(0)).toBe('$0.0000');
  });
});
