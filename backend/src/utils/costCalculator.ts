import { getModelPricing } from '../config/modelPricing.js';
import logger from '../config/logging.js';

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

/**
 * Calculate estimated cost from ACTUAL token counts (never estimate the
 * counts themselves - that must already have happened upstream, from the
 * provider's own usage field). This function only ever multiplies known
 * token counts by centrally-configured per-token prices (modelPricing.ts).
 *
 * Returns null when the model has no configured price, so the usage log
 * records "cost unknown" instead of a cost computed at another model's rate.
 */
export function calculateCost(usage: TokenUsage, model: string): number | null {
  const pricing = getModelPricing(model);
  if (!pricing) {
    logger.warn(`No pricing configured for model "${model}" - estimated cost recorded as null (add it to modelPricing.ts)`);
    return null;
  }
  return usage.input_tokens * pricing.inputPerToken + usage.output_tokens * pricing.outputPerToken;
}

/**
 * Format a cost value (USD) for display.
 */
export function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}
