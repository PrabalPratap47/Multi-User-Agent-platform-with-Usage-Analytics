import type { z } from 'zod';
import { Agent } from './Agent.js';
import { AgentContext } from '../types/index.js';
import logger from '../config/logging.js';
import { SkillsGapResponseSchema, type SkillsGapResponse } from './skillsGap/schema.js';
import { buildSkillsGapRepairInstructions, buildSkillsGapSystemInstructions, buildSkillsGapUserContent } from './skillsGap/prompt.js';
import { checkEvidence, checkRoleCoverage, detectLeakage, sanitizeStrings } from './skillsGap/outputGuard.js';
import type { SkillsGapRole } from './skillsGap/roles.js';

export const SKILLS_GAP_AGENT_NAME = 'CV Skills Extraction & Gap Analysis Agent';

// A full analysis (every role skill, gaps with learning plans, a roadmap) is
// much longer than a classification; still a hard cap on output size.
const SKILLS_GAP_MAX_TOKENS = 4096;

export interface SkillsGapAgentResult {
  analysis: SkillsGapResponse;
  /** The complete parsed JSON the model returned, stored verbatim for audit. */
  rawResponse: unknown;
}

/** The safe error after the one repair retry also fails (mirrors CvClassificationValidationError). */
export class SkillsGapValidationError extends Error {
  constructor(
    message: string,
    public readonly problems: string[]
  ) {
    super(message);
    this.name = 'SkillsGapValidationError';
  }
}

type AttemptOutcome = { success: true; result: SkillsGapAgentResult } | { success: false; problems: string[] };

/**
 * Zod issue -> "path: description" using only the path and fixed wording,
 * never the received value (which the model chose, possibly under the
 * influence of injected CV text). Refinement messages are our own text.
 */
function describeIssue(issue: z.ZodIssue): string {
  const path = issue.path.join('.') || '(root)';
  switch (issue.code) {
    case 'invalid_type':
      return `${path}: expected ${issue.expected}`;
    case 'invalid_enum_value':
    case 'invalid_literal':
      return `${path}: is not one of the allowed values`;
    case 'unrecognized_keys':
      return `${path}: contains fields that are not in the required shape`;
    case 'too_small':
    case 'too_big':
      return `${path}: ${issue.message}`;
    case 'custom':
      return `${path}: ${issue.message}`;
    default:
      return `${path}: is invalid`;
  }
}

export class SkillsGapAgent extends Agent {
  name = SKILLS_GAP_AGENT_NAME;
  version = '1.0.0';

  /**
   * Extracts the skills a CV demonstrates for `targetRole` and builds the
   * gap analysis. call -> parse JSON -> strict schema -> role coverage,
   * evidence and leak checks; on failure ONE repair retry, then
   * SkillsGapValidationError - never an unvalidated result.
   */
  async execute(cvContent: string, context: AgentContext, runId?: string, targetRole?: SkillsGapRole): Promise<SkillsGapAgentResult> {
    if (!targetRole) throw new Error('SkillsGapAgent.execute requires a target role');

    const first = await this.attempt(cvContent, targetRole, context, runId, buildSkillsGapSystemInstructions(targetRole));
    if (first.success) return first.result;

    logger.warn('Skills gap response failed validation, attempting one repair retry', { userId: context.userId, runId, problems: first.problems });
    const problems = first.problems.slice(0, 20).map(p => `- ${p}`).join('\n');
    const repair = await this.attempt(cvContent, targetRole, context, runId, buildSkillsGapRepairInstructions(targetRole, problems));
    if (repair.success) return repair.result;

    logger.error('Skills gap response failed validation after repair retry - giving up', { userId: context.userId, runId, problems: repair.problems });
    throw new SkillsGapValidationError(
      'The skills gap analysis could not be completed: the model did not return a valid response, even after a repair attempt.',
      repair.problems
    );
  }

  private async attempt(
    cvContent: string,
    targetRole: SkillsGapRole,
    context: AgentContext,
    runId: string | undefined,
    systemInstructions: string
  ): Promise<AttemptOutcome> {
    const { responseText } = await this.llm.call({
      systemInstructions,
      userContent: buildSkillsGapUserContent(cvContent),
      agentName: this.name,
      context,
      runId,
      maxTokens: SKILLS_GAP_MAX_TOKENS,
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      return { success: false, problems: ['(root): the response was not valid JSON'] };
    }

    const validation = SkillsGapResponseSchema.safeParse(parsed);
    if (!validation.success) return { success: false, problems: validation.error.issues.map(describeIssue) };

    if (detectLeakage(responseText)) {
      return { success: false, problems: ['(root): the response repeats internal instructions or contains secret-like text'] };
    }

    const ruleProblems = [...checkRoleCoverage(validation.data, targetRole), ...checkEvidence(validation.data, cvContent)];
    if (ruleProblems.length > 0) return { success: false, problems: ruleProblems };

    // Sanitizing could in principle empty a field, so the stored value is validated again.
    const sanitized = SkillsGapResponseSchema.safeParse(sanitizeStrings(validation.data));
    if (!sanitized.success) return { success: false, problems: sanitized.error.issues.map(describeIssue) };

    return { success: true, result: { analysis: sanitized.data, rawResponse: parsed } };
  }
}

// `let` so integration tests can swap in an agent with a mocked LLMService (same pattern as the other agents).
export let skillsGapAgent: SkillsGapAgent = new SkillsGapAgent();

/** Test-only hook. Never call this from application code. */
export function __setSkillsGapAgentForTesting(agent: SkillsGapAgent): void {
  skillsGapAgent = agent;
}
