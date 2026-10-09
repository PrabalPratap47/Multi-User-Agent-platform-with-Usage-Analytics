import { UsageIssue } from '../types/index.js';

/** Plain-language meaning of each usage issue (definitions: backend services/usageCompleteness.ts). */
export const USAGE_ISSUE_TEXT: Record<UsageIssue, string> = {
  USAGE_UNKNOWN: 'The AI provider returned no token counts. Recorded as 0 tokens and $0; the real usage is unknown.',
  COST_UNKNOWN: 'The model has no configured price. Tokens are counted, but the cost is missing from Estimated Cost.',
  NO_USAGE_LOGGED: 'The run succeeded but its usage log could not be saved. Its AI calls are missing from every total.',
  INTERRUPTED: 'Interrupted by a backend restart. An AI call may have been cut off; its usage is unknown.',
};
