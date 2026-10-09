import { z } from 'zod';
import type { Prisma } from '@prisma/client';

const categoryListSchema = z.array(z.string());

/**
 * SQLite has no scalar lists, so category lists (CvRecommendation.secondaryCategories,
 * RecommendationDecision.finalSecondaryCategories) are stored as Json holding a
 * string[]. Every read goes through here so a malformed row fails loudly instead
 * of flowing on as an untyped value.
 */
export function parseCategoryList(value: Prisma.JsonValue): string[] {
  const result = categoryListSchema.safeParse(value);
  if (!result.success) {
    throw new Error('Stored category list is not a string array');
  }
  return result.data;
}
