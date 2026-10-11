import { z } from 'zod';
import { CV_CATEGORIES } from '../../utils/validators.js';
import { hasValidSentenceCount, MAX_FEEDBACK_LENGTH, MAX_FEEDBACK_SENTENCES, MIN_FEEDBACK_SENTENCES } from './feedback.js';

/**
 * Runtime validator for the CV Classification Agent's required output
 * shape. This is the authoritative contract - every model response is
 * parsed as JSON and checked against this schema before being trusted;
 * see CVClassificationAgent.execute() for the validate -> repair -> fail
 * flow built around it.
 *
 * A matching, documented JSON Schema (draft-07) lives alongside this file
 * in cvClassificationResponse.schema.json. A unit test
 * (tests/cvClassificationSchema.test.ts) asserts the two stay in sync.
 */

export const ConfidenceMapSchema = z
  .object({
    PSS: z.number().min(0).max(1),
    DCS: z.number().min(0).max(1),
    'Front-End Developer': z.number().min(0).max(1),
    'Back-End Developer': z.number().min(0).max(1),
    'Web Automation': z.number().min(0).max(1),
    'Mobile Automation': z.number().min(0).max(1),
    'AI Engineer': z.number().min(0).max(1),
    'Chatbot Application Tester': z.number().min(0).max(1),
    Other: z.number().min(0).max(1),
  })
  .strict();

export const RationaleEntrySchema = z
  .object({
    category: z.enum(CV_CATEGORIES),
    evidence: z.string().trim().min(1, 'evidence must not be empty').max(2000),
  })
  .strict();

export const CVClassificationResponseSchema = z
  .object({
    primaryCategory: z.enum(CV_CATEGORIES),
    secondaryCategories: z.array(z.enum(CV_CATEGORIES)).max(CV_CATEGORIES.length),
    confidence: ConfidenceMapSchema,
    rationale: z.array(RationaleEntrySchema).min(1, 'rationale must include at least one entry'),
    // 2-4 complete sentences of constructive feedback about the CV (see feedback.ts).
    feedback: z
      .string()
      .trim()
      .min(1, 'feedback must not be empty')
      .max(MAX_FEEDBACK_LENGTH)
      .refine(hasValidSentenceCount, `feedback must be ${MIN_FEEDBACK_SENTENCES} to ${MAX_FEEDBACK_SENTENCES} complete sentences`),
  })
  .strict()
  .refine(data => !data.secondaryCategories.includes(data.primaryCategory), {
    message: 'secondaryCategories must not include primaryCategory',
    path: ['secondaryCategories'],
  })
  .refine(data => new Set(data.secondaryCategories).size === data.secondaryCategories.length, {
    message: 'secondaryCategories must not contain duplicates',
    path: ['secondaryCategories'],
  })
  .refine(data => data.rationale.some(entry => entry.category === data.primaryCategory), {
    message: 'rationale must include at least one entry for primaryCategory',
    path: ['rationale'],
  })
  .refine(
    data => {
      const primaryScore = data.confidence[data.primaryCategory];
      return Object.values(data.confidence).every(score => score <= primaryScore);
    },
    {
      message: 'primaryCategory must have the highest (or tied-highest) confidence score',
      path: ['confidence'],
    }
  );

export type CVClassificationResponse = z.infer<typeof CVClassificationResponseSchema>;
