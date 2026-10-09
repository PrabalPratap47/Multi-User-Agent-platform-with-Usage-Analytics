import { sharesVocabulary } from '../shared/textOverlap.js';

/**
 * Content-safety checks applied to a model response AFTER it has already
 * passed SentimentResponseSchema (structural validation) - mirrors
 * agents/cvClassification/outputGuard.ts's approach for the same reasons
 * (see that file and docs/PROMPT_INJECTION_SECURITY.md). Both checks feed
 * into the same validate -> repair -> fail pipeline as schema validation.
 *
 * KNOWN LIMITATION (same class of issue as the CV agent's groundedness
 * check): this is a cheap word-overlap heuristic, not a semantic proof.
 * An attacker whose injected text happens to share incidental vocabulary
 * with their own fabricated rationale can defeat it. It is one layer
 * among several (schema strictness, leak detection, role separation),
 * not a standalone guarantee.
 */

const SYSTEM_PROMPT_LEAK_PHRASES = [
  'output format - mandatory',
  'security - mandatory',
  'untrusted data submitted by a user',
  'you are an expert at analyzing the sentiment',
  'repair request',
  'your previous response did not conform to the required schema',
] as const;

const SECRET_PATTERNS: RegExp[] = [/sk-ant-[a-zA-Z0-9_-]{6,}/i, /sk-[a-zA-Z0-9]{20,}/];

/**
 * Scans raw model output for signs it leaked this agent's own system
 * instructions or something shaped like a real secret/API key.
 */
export function detectLeakage(responseText: string): string[] {
  const lower = responseText.toLowerCase();
  const matches: string[] = [];

  for (const phrase of SYSTEM_PROMPT_LEAK_PHRASES) {
    if (lower.includes(phrase)) {
      matches.push(`system-prompt phrase: "${phrase}"`);
    }
  }

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(responseText)) {
      matches.push(`secret-like pattern: ${pattern}`);
    }
  }

  return matches;
}

// "positive"/"neutral"/"negative" are ordinary English words that could
// legitimately appear in genuine feedback text (e.g. "the team has a
// very positive attitude"). Excluding them from the grounding comparison
// avoids both: (a) a false positive against real feedback that happens
// to use the word, and (b) the same bypass found in the CV agent, where
// an injection naming its target label would "accidentally" overlap with
// fabricated rationale that just restates the label.
const SENTIMENT_LABEL_WORDS = new Set(['positive', 'neutral', 'negative']);

/**
 * Checks that the rationale actually shares vocabulary with the
 * submitted feedback text, excluding the sentiment label words
 * themselves. See the module-level KNOWN LIMITATION note above.
 */
export function isRationaleGrounded(rationale: string, feedbackText: string): boolean {
  const feedbackWords = feedbackText.toLowerCase();
  if (feedbackWords.trim().length === 0) {
    return true; // nothing to ground against; shouldn't happen given request-level min length
  }
  return sharesVocabulary(rationale, feedbackText, SENTIMENT_LABEL_WORDS);
}

/**
 * Output sanitization applied to accepted rationale text before it is
 * persisted/returned: strips HTML/XML-like tags and control characters,
 * normalizes whitespace. The unsanitized original is still preserved
 * verbatim in rawResponse for audit.
 */
export function sanitizeRationaleText(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
