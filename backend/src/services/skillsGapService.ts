import type { Prisma } from '@prisma/client';
import prisma from '../db/client.js';
import { Errors } from '../middleware/errorHandler.js';
import { UserPayload, AgentContext } from '../types/index.js';
import { skillsGapAgent, SKILLS_GAP_AGENT_NAME, SkillsGapValidationError } from '../agents/SkillsGapAgent.js';
import { ROLE_REQUIREMENTS, SKILLS_GAP_ROLES, PRIORITY_FOR_IMPORTANCE } from '../agents/skillsGap/roles.js';
import { validateCVClassificationRequest, validateSkillsGapRequest } from '../utils/validators.js';
import { extractPdfText, PdfExtractionError } from '../utils/pdfText.js';
import { LLMServiceError, providerFailureMessage } from './llmService.js';
import { MAX_FILE_CONTENT_LENGTH, MIN_FILE_CONTENT_LENGTH } from './cvBatchService.js';
import logger from '../config/logging.js';

/**
 * CV Skills Extraction & Gap Analysis. Same run lifecycle as sentiment
 * analysis: an AgentRun per analysis, usage logged by LLMService for every
 * provider call, a saved result on success, a safe reason on failure.
 * Ownership like every other result: own for a user, all for an admin.
 *
 * Separate from CV classification: nothing here reads or writes
 * cv_recommendations or recommendation_decisions.
 */

// Owner email lets an admin tell whose analysis each one is.
const OWNER = { user: { select: { email: true } } };

function toSafeRunError(error: unknown): string {
  if (error instanceof SkillsGapValidationError) return 'The AI response did not pass validation, even after one automatic retry.';
  if (error instanceof LLMServiceError) return providerFailureMessage(error).slice(0, 300);
  return 'Processing failed due to an internal error.';
}

export class SkillsGapService {
  /** The role list with expected skills, for the role picker. */
  static listRoles() {
    return SKILLS_GAP_ROLES.map(role => ({
      role,
      label: ROLE_REQUIREMENTS[role].label,
      summary: ROLE_REQUIREMENTS[role].summary,
      skills: ROLE_REQUIREMENTS[role].skills.map(s => ({ ...s, gapPriority: PRIORITY_FOR_IMPORTANCE[s.importance] })),
    }));
  }

  static async analyze(user: UserPayload, body: unknown) {
    const request = validateSkillsGapRequest(body);
    // The same CV text rules and PDF extraction as CV classification - no second parser.
    const rawText =
      request.pdfBase64 !== undefined
        ? await extractPdfText(request.pdfBase64, { minChars: MIN_FILE_CONTENT_LENGTH, maxChars: MAX_FILE_CONTENT_LENGTH })
        : (request.cvContent as string);
    const { cvContent } = validateCVClassificationRequest({ cvContent: rawText });

    const agent = await prisma.agent.upsert({
      where: { name: SKILLS_GAP_AGENT_NAME },
      update: {},
      create: { name: SKILLS_GAP_AGENT_NAME, description: 'Extracts CV skills for a target role and builds a learning plan for the gaps', version: '1.0.0' },
    });
    const run = await prisma.agentRun.create({
      data: { userId: user.id, agentId: agent.id, agentName: agent.name, status: 'RUNNING' },
    });
    const context: AgentContext = { userId: user.id, userEmail: user.email, userRole: user.role };

    try {
      const { analysis, rawResponse } = await skillsGapAgent.execute(cvContent, context, run.id, request.targetRole);
      const saved = await prisma.skillsGapAnalysis.create({
        data: {
          runId: run.id,
          userId: user.id,
          agentId: agent.id,
          targetRole: request.targetRole,
          cvFileName: request.fileName,
          cvCharCount: cvContent.length,
          result: analysis as unknown as Prisma.InputJsonValue,
          rawResponse: rawResponse as Prisma.InputJsonValue,
        },
        include: OWNER,
      });
      await prisma.agentRun.update({ where: { id: run.id }, data: { status: 'SUCCESS', completedAt: new Date() } });
      return saved;
    } catch (error) {
      await prisma.agentRun
        .update({ where: { id: run.id }, data: { status: 'ERROR', completedAt: new Date(), errorMessage: toSafeRunError(error) } })
        .catch((updateError: unknown) => {
          logger.error('Failed to mark agent run as ERROR', { runId: run.id, error: updateError instanceof Error ? updateError.message : String(updateError) });
        });
      throw error;
    }
  }

  /** Saved analyses, newest first: own for a regular user, all for an admin. */
  static async list(user: UserPayload) {
    const where = user.role === 'admin' ? {} : { userId: user.id };
    return prisma.skillsGapAnalysis.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: { id: true, userId: true, targetRole: true, cvFileName: true, createdAt: true, result: true, ...OWNER },
    });
  }

  /**
   * Permanently deletes one saved analysis (the CV's record in this
   * section; the CV text itself is never stored here). Admin only - the
   * route also requires an admin. Its agent run and usage logs are kept,
   * so token, cost and run history stay exact.
   */
  static async delete(user: UserPayload, id: number) {
    if (user.role !== 'admin') throw Errors.forbidden('Only an admin can delete skills gap analyses');
    const analysis = await prisma.skillsGapAnalysis.findUnique({ where: { id }, select: { id: true, userId: true } });
    if (!analysis) throw Errors.notFound('Skills gap analysis');
    await prisma.skillsGapAnalysis.delete({ where: { id } });
    // Ids only - never the file name or analysis content.
    logger.info('Skills gap analysis permanently deleted', { analysisId: id, deletedBy: user.id, ownerId: analysis.userId });
    return { id };
  }

  /** One saved analysis: own for a regular user, any for an admin. */
  static async get(user: UserPayload, id: number) {
    const analysis = await prisma.skillsGapAnalysis.findUnique({
      where: { id },
      select: { id: true, userId: true, runId: true, targetRole: true, cvFileName: true, cvCharCount: true, createdAt: true, result: true, ...OWNER },
    });
    if (!analysis) throw Errors.notFound('Skills gap analysis');
    if (user.role !== 'admin' && analysis.userId !== user.id) throw Errors.forbidden('You can only view your own skills gap analyses');
    return analysis;
  }
}

export { PdfExtractionError, SkillsGapValidationError };
