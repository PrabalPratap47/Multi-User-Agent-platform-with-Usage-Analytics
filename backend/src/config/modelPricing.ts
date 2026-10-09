/**
 * Centralized LLM model pricing.
 *
 * This is the ONLY place per-token prices are defined. costCalculator.ts
 * reads from here and does nothing else - updating a price, or adding a
 * new model, never requires touching the cost calculation logic or any
 * agent code that depends on it.
 *
 * Prices are USD per single token, converted from OpenAI's published
 * per-million-token rates (https://platform.openai.com/docs/pricing).
 *
 * IMPORTANT: verify these against the current OpenAI pricing page before
 * relying on them for real billing or cost-sensitive decisions - provider
 * prices change over time and this file is not auto-synced.
 * Last verified: 2026-10-07 (web search against current OpenAI pricing
 * references - gpt-4o $2.50/$10.00 per 1M input/output tokens, gpt-4o-mini
 * $0.15/$0.60 per 1M input/output tokens).
 */

export interface ModelPricing {
  /** USD per single input token */
  inputPerToken: number;
  /** USD per single output token */
  outputPerToken: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'gpt-4o': {
    inputPerToken: 2.5 / 1_000_000, // $2.50 / 1M input tokens
    outputPerToken: 10 / 1_000_000, // $10.00 / 1M output tokens
  },
  'gpt-4o-mini': {
    inputPerToken: 0.15 / 1_000_000, // $0.15 / 1M input tokens
    outputPerToken: 0.6 / 1_000_000, // $0.60 / 1M output tokens
  },
};

// OpenAI reports the dated snapshot that served a request (e.g.
// "gpt-4o-mini-2024-07-18" for a "gpt-4o-mini" request).
const SNAPSHOT_DATE_SUFFIX = /-\d{4}-\d{2}-\d{2}$/;

/**
 * Pricing for a model or one of its dated snapshots, or null when the
 * model is not in the table. Never substitutes another model's price: an
 * unknown model gets no cost rather than a wrong one.
 */
export function getModelPricing(model: string): ModelPricing | null {
  return MODEL_PRICING[model] ?? MODEL_PRICING[model.replace(SNAPSHOT_DATE_SUFFIX, '')] ?? null;
}
