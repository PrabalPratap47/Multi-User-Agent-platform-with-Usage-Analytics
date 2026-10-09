import { z } from 'zod';

/**
 * Runtime validator for the Feedback Sentiment Agent's required output
 * shape. This is the authoritative contract - every model response is
 * parsed as JSON and checked against this schema before being trusted;
 * see SentimentAgent.execute() for the validate -> repair -> fail flow
 * built around it. A matching, documented JSON Schema (draft-07) lives
 * alongside this file in sentimentResponse.schema.json; a unit test
 * asserts the two stay in sync.
 *
 * Mirrors the minimum shape required by the task exactly:
 *   { "sentiment": "positive | neutral | negative", "confidence": 0.0, "rationale": "..." }
 */

export const SENTIMENT_LABELS = ['positive', 'neutral', 'negative'] as const;

export const SentimentResponseSchema = z
  .object({
    sentiment: z.enum(SENTIMENT_LABELS),
    confidence: z.number().min(0).max(1),
    rationale: z.string().trim().min(1, 'rationale must not be empty').max(1000),
  })
  .strict();

export type SentimentResponse = z.infer<typeof SentimentResponseSchema>;
