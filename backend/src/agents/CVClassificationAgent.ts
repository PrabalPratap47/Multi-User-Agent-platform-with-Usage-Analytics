import { z } from 'zod';
import { Agent } from './Agent.js';
import { AgentContext } from '../types/index.js';
import logger from '../config/logging.js';
import {
  CVClassificationResponseSchema,
  type CVClassificationResponse,
} from './cvClassification/schema.js';
import {
  buildClassificationSystemInstructions,
  buildClassificationUserContent,
  buildRepairSystemInstructions,
} from './cvClassification/prompt.js';
import {
  detectLeakage,
  isPrimaryRationaleGrounded,
  sanitizeEvidenceText,
} from './cvClassification/outputGuard.js';

export const CV_CLASSIFICATION_AGENT_NAME = 'CV Classification Agent';

export interface CvClassificationResult extends CVClassificationResponse {
  /** The complete parsed JSON the model returned, stored verbatim for audit. */
  rawResponse: unknown;
}

/**
 * Thrown when the model's response doesn't conform to
 * CVClassificationResponseSchema even after one controlled repair retry.
 * This is the "safe error" the caller gets instead of either a raw
 * exception or a blindly-accepted malformed result - it deliberately does
 * not include the raw model text in its public `message`, so a controller
 * can return it to an API client without leaking provider output; full
 * details are on `issues`/`rawResponse` for server-side logging only.
 */
export class CvClassificationValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: z.ZodIssue[] | string,
    public readonly rawResponse: string
  ) {
    super(message);
    this.name = 'CvClassificationValidationError';
  }
}

type AttemptOutcome =
  | { success: true; result: CvClassificationResult }
  | { success: false; issues: z.ZodIssue[] | string; rawText: string };

function formatIssuesForPrompt(issues: z.ZodIssue[] | string): string {
  if (typeof issues === 'string') return `- ${issues}`;
  return issues.map(issue => `- ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n');
}

export class CVClassificationAgent extends Agent {
  name = CV_CLASSIFICATION_AGENT_NAME;
  version = '1.0.0';

  /**
   * Classifies a CV's text into one of the fixed categories.
   *
   * Flow: call the LLM -> parse JSON -> validate against
   * CVClassificationResponseSchema. If that fails (invalid JSON or a
   * schema violation), the failure is logged and ONE controlled repair
   * retry is attempted, feeding the validator's exact error messages back
   * to the model. If the repair attempt also fails, this throws
   * CvClassificationValidationError rather than returning a response that
   * was never actually validated.
   */
  async execute(
    cvContent: string,
    context: AgentContext,
    runId?: string
  ): Promise<CvClassificationResult> {
    const firstAttempt = await this.attempt(
      cvContent,
      context,
      runId,
      buildClassificationSystemInstructions()
    );

    if (firstAttempt.success) {
      return firstAttempt.result;
    }

    logger.warn('CV classification response failed validation, attempting one repair retry', {
      userId: context.userId,
      runId,
      issues: firstAttempt.issues,
    });

    const repairAttempt = await this.attempt(
      cvContent,
      context,
      runId,
      buildRepairSystemInstructions(formatIssuesForPrompt(firstAttempt.issues))
    );

    if (repairAttempt.success) {
      return repairAttempt.result;
    }

    logger.error('CV classification response failed validation after repair retry - giving up', {
      userId: context.userId,
      runId,
      issues: repairAttempt.issues,
    });

    throw new CvClassificationValidationError(
      'CV classification could not be completed: the model did not return a response matching the required schema, even after a repair attempt.',
      repairAttempt.issues,
      repairAttempt.rawText
    );
  }

  private async attempt(
    cvContent: string,
    context: AgentContext,
    runId: string | undefined,
    systemInstructions: string
  ): Promise<AttemptOutcome> {
    const { responseText } = await this.llm.call({
      systemInstructions,
      userContent: buildClassificationUserContent(cvContent),
      agentName: this.name,
      context,
      runId,
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      return { success: false, issues: 'Response was not valid JSON', rawText: responseText };
    }

    const validation = CVClassificationResponseSchema.safeParse(parsed);
    if (!validation.success) {
      return { success: false, issues: validation.error.issues, rawText: responseText };
    }

    // Beyond schema shape: content-safety checks (see outputGuard.ts).
    // A response that is structurally valid JSON can still be an
    // injection success (e.g. a fabricated category with no real
    // evidence) or a leak (echoing this agent's own instructions) - both
    // are treated as validation failures and go through the same
    // repair-retry path as a schema violation.
    const leaks = detectLeakage(responseText);
    if (leaks.length > 0) {
      return {
        success: false,
        issues: `Response appears to leak internal instructions or secret-like content (${leaks.join('; ')}). Rejected - never persisted or returned.`,
        rawText: responseText,
      };
    }

    if (!isPrimaryRationaleGrounded(validation.data.primaryCategory, validation.data.rationale, cvContent)) {
      return {
        success: false,
        issues:
          'The rationale for primaryCategory shares no vocabulary with the submitted CV text. Evidence must cite something actually present in the CV, not fabricated or injected content.',
        rawText: responseText,
      };
    }

    const sanitizedRationale = validation.data.rationale.map(entry => ({
      ...entry,
      evidence: sanitizeEvidenceText(entry.evidence),
    }));

    return {
      success: true,
      result: { ...validation.data, rationale: sanitizedRationale, rawResponse: parsed },
    };
  }
}

// `let`, not `const`, specifically so integration tests can swap in an
// agent built with a mocked LLMService (see
// __setCvClassificationAgentForTesting below) without making real network
// calls, while still exercising the real controller/service/route stack.
export let cvClassificationAgent: CVClassificationAgent = new CVClassificationAgent();

/** Test-only hook. Never call this from application code. */
export function __setCvClassificationAgentForTesting(agent: CVClassificationAgent): void {
  cvClassificationAgent = agent;
}
