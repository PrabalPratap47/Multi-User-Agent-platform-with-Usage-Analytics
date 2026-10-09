import { z } from 'zod';
import { Agent } from './Agent.js';
import { AgentContext } from '../types/index.js';
import logger from '../config/logging.js';
import { SentimentResponseSchema, type SentimentResponse } from './sentiment/schema.js';
import {
  buildSentimentSystemInstructions,
  buildSentimentUserContent,
  buildSentimentRepairSystemInstructions,
} from './sentiment/prompt.js';
import { detectLeakage, isRationaleGrounded, sanitizeRationaleText } from './sentiment/outputGuard.js';

export const SENTIMENT_AGENT_NAME = 'Sentiment Analysis Agent';

export interface SentimentAgentResult extends SentimentResponse {
  /** The complete parsed JSON the model returned, stored verbatim for audit. */
  rawResponse: unknown;
}

/**
 * Thrown when the model's response doesn't conform to
 * SentimentResponseSchema even after one controlled repair retry. The
 * "safe error" the caller gets instead of either a raw exception or a
 * blindly-accepted malformed result - mirrors
 * CvClassificationValidationError's design exactly, see that class for
 * the rationale.
 */
export class SentimentValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: z.ZodIssue[] | string,
    public readonly rawResponse: string
  ) {
    super(message);
    this.name = 'SentimentValidationError';
  }
}

type AttemptOutcome =
  | { success: true; result: SentimentAgentResult }
  | { success: false; issues: z.ZodIssue[] | string; rawText: string };

function formatIssuesForPrompt(issues: z.ZodIssue[] | string): string {
  if (typeof issues === 'string') return `- ${issues}`;
  return issues.map(issue => `- ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n');
}

export class SentimentAgent extends Agent {
  name = SENTIMENT_AGENT_NAME;
  version = '1.0.0';

  /**
   * Analyzes the sentiment of feedback text.
   *
   * Flow: call the LLM -> parse JSON -> validate against
   * SentimentResponseSchema -> content-safety checks (leak detection,
   * groundedness). If any of those fail, the failure is logged and ONE
   * controlled repair retry is attempted, feeding the validator's exact
   * error messages back to the model. If the repair attempt also fails,
   * this throws SentimentValidationError rather than returning a
   * response that was never actually validated.
   */
  async execute(
    feedbackText: string,
    context: AgentContext,
    runId?: string
  ): Promise<SentimentAgentResult> {
    const firstAttempt = await this.attempt(
      feedbackText,
      context,
      runId,
      buildSentimentSystemInstructions()
    );

    if (firstAttempt.success) {
      return firstAttempt.result;
    }

    logger.warn('Sentiment response failed validation, attempting one repair retry', {
      userId: context.userId,
      runId,
      issues: firstAttempt.issues,
    });

    const repairAttempt = await this.attempt(
      feedbackText,
      context,
      runId,
      buildSentimentRepairSystemInstructions(formatIssuesForPrompt(firstAttempt.issues))
    );

    if (repairAttempt.success) {
      return repairAttempt.result;
    }

    logger.error('Sentiment response failed validation after repair retry - giving up', {
      userId: context.userId,
      runId,
      issues: repairAttempt.issues,
    });

    throw new SentimentValidationError(
      'Sentiment analysis could not be completed: the model did not return a response matching the required schema, even after a repair attempt.',
      repairAttempt.issues,
      repairAttempt.rawText
    );
  }

  private async attempt(
    feedbackText: string,
    context: AgentContext,
    runId: string | undefined,
    systemInstructions: string
  ): Promise<AttemptOutcome> {
    const { responseText } = await this.llm.call({
      systemInstructions,
      userContent: buildSentimentUserContent(feedbackText),
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

    const validation = SentimentResponseSchema.safeParse(parsed);
    if (!validation.success) {
      return { success: false, issues: validation.error.issues, rawText: responseText };
    }

    const leaks = detectLeakage(responseText);
    if (leaks.length > 0) {
      return {
        success: false,
        issues: `Response appears to leak internal instructions or secret-like content (${leaks.join('; ')}). Rejected - never persisted or returned.`,
        rawText: responseText,
      };
    }

    if (!isRationaleGrounded(validation.data.rationale, feedbackText)) {
      return {
        success: false,
        issues:
          'The rationale shares no vocabulary with the submitted feedback text. Rationale must cite something actually present in the feedback, not fabricated or injected content.',
        rawText: responseText,
      };
    }

    return {
      success: true,
      result: {
        ...validation.data,
        rationale: sanitizeRationaleText(validation.data.rationale),
        rawResponse: parsed,
      },
    };
  }
}

// `let`, not `const` - mirrors cvClassificationAgent's singleton-override
// pattern so integration tests can inject a mocked LLMService without
// making real network calls.
export let sentimentAgent: SentimentAgent = new SentimentAgent();

/** Test-only hook. Never call this from application code. */
export function __setSentimentAgentForTesting(agent: SentimentAgent): void {
  sentimentAgent = agent;
}
