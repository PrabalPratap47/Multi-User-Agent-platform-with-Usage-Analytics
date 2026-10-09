import prisma from '../db/client.js';
import { Errors } from '../middleware/errorHandler.js';
import { UserPayload } from '../types/index.js';
import { validateRecommendationDecision } from '../utils/validators.js';
import { parseCategoryList } from '../utils/categoryList.js';

/**
 * The CV recommendation decision workflow: ACCEPT / MODIFY / REJECT.
 *
 * Identity for every decision comes exclusively from `user` (the
 * authenticated caller, i.e. req.user set by auth middleware from the
 * verified JWT) - never from anything in the request body. The decision
 * row's userId is always user.id, and ownership of the recommendation
 * being decided on is checked against user.id/user.role, never against
 * a client-supplied id.
 */
export class CvDecisionService {
  static async makeDecision(user: UserPayload, recommendationId: number, body: unknown) {
    const request = validateRecommendationDecision(body);

    const recommendation = await prisma.cvRecommendation.findUnique({ where: { id: recommendationId } });
    if (!recommendation) {
      throw Errors.notFound('Recommendation');
    }
    if (user.role !== 'admin' && recommendation.userId !== user.id) {
      throw Errors.forbidden('You can only decide on your own recommendations');
    }

    const originalSecondaryCategories = parseCategoryList(recommendation.secondaryCategories);
    let finalPrimaryCategory: string | null;
    let finalSecondaryCategories: string[];

    if (request.decisionType === 'ACCEPT') {
      // "Final decision equals original recommendation."
      finalPrimaryCategory = recommendation.primaryCategory;
      finalSecondaryCategories = originalSecondaryCategories;
    } else if (request.decisionType === 'REJECT') {
      // No category is accepted - enforced again by a DB CHECK constraint.
      finalPrimaryCategory = null;
      finalSecondaryCategories = [];
    } else {
      // MODIFY: an omitted field means "unchanged from the original" for
      // that part - the user only has to specify what they're actually
      // changing. But at least one of primary/secondary must end up
      // genuinely different, or this isn't a modification.
      finalPrimaryCategory = request.finalPrimaryCategory ?? recommendation.primaryCategory;
      finalSecondaryCategories = request.finalSecondaryCategories ?? originalSecondaryCategories;

      const samePrimary = finalPrimaryCategory === recommendation.primaryCategory;
      const sameSecondary =
        finalSecondaryCategories.length === originalSecondaryCategories.length &&
        finalSecondaryCategories.every(category => originalSecondaryCategories.includes(category));

      if (samePrimary && sameSecondary) {
        throw Errors.badRequest(
          'MODIFY must choose a different primary category and/or secondary categories from the original recommendation'
        );
      }
    }

    return prisma.recommendationDecision.create({
      data: {
        recommendationId: recommendation.id,
        cvDocumentId: recommendation.cvDocumentId,
        agentRunId: recommendation.runId,
        userId: user.id,
        decisionType: request.decisionType,
        finalPrimaryCategory,
        finalSecondaryCategories,
        reason: request.reason,
      },
    });
  }

  /** All decisions made on one recommendation, ownership-enforced. */
  static async listForRecommendation(user: UserPayload, recommendationId: number) {
    const recommendation = await prisma.cvRecommendation.findUnique({ where: { id: recommendationId } });
    if (!recommendation) {
      throw Errors.notFound('Recommendation');
    }
    if (user.role !== 'admin' && recommendation.userId !== user.id) {
      throw Errors.forbidden('You can only view decisions on your own recommendations');
    }

    return prisma.recommendationDecision.findMany({
      where: { recommendationId },
      orderBy: { timestamp: 'desc' },
    });
  }
}
