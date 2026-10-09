/**
 * Content-safety checks applied to a model response AFTER it has already
 * passed CVClassificationResponseSchema (structural validation). These
 * are a separate, additional layer: schema validation proves the response
 * has the right SHAPE (valid categories, confidence range, non-empty
 * rationale); it cannot know whether the content is actually grounded in
 * the submitted CV, or whether the model was tricked into echoing its own
 * instructions. That is what this file checks.
 *
 * Both checks feed into the same validate -> repair -> fail pipeline as
 * schema validation (see CVClassificationAgent.attempt()) - a response
 * that fails either one is treated exactly like a schema violation: one
 * controlled repair retry, then a safe failure.
 *
 * KNOWN LIMITATION (documented, not hidden - see
 * docs/PROMPT_INJECTION_SECURITY.md "Known limitations"): the groundedness
 * check below is a cheap heuristic, not a semantic proof. An attacker
 * whose injected instruction text happens to share incidental vocabulary
 * with their own fabricated "evidence" (e.g. both mention "system" or
 * "override") can produce a false "grounded" result for the wrong
 * reason. This is why it is one layer among several (schema strictness,
 * leak detection, role separation) rather than a standalone guarantee -
 * tests in cvClassificationPromptInjection.test.ts exercise this exact
 * boundary rather than only testing the cases where it works cleanly.
 */

import { CV_CATEGORIES } from '../../utils/validators.js';

// Words drawn from the category names themselves (e.g. "Developer",
// "Engineer", "Automation") are excluded from the grounding comparison.
// Without this, a category-override attack that names its target
// category in the CV text (as it almost always must, to tell the model
// what to change the classification to) would "accidentally" overlap
// with fabricated evidence that just restates the same category name -
// exactly the case this check exists to catch.
const CATEGORY_NAME_WORDS = new Set(
  CV_CATEGORIES.flatMap(category => category.toLowerCase().split(/[^a-z0-9]+/)).filter(word => word.length >= 4)
);

// Distinctive, sentence-length phrases lifted verbatim from this agent's
// own system prompt (prompt.ts). Deliberately NOT single common words
// like "password", "API key", or "secret" - a genuine Back-End Developer
// or AI Engineer CV will very plausibly mention exactly those terms
// describing the CANDIDATE's own work, and flagging on them would be a
// false positive against real, legitimate CVs. A multi-word phrase taken
// verbatim from our own prompt has no plausible reason to appear in CV
// content or model output unless the model is echoing back what it was
// told - that's the actual signal worth catching.
const SYSTEM_PROMPT_LEAK_PHRASES = [
  'output format - mandatory',
  'security - mandatory',
  'untrusted data submitted by a job applicant',
  'you are an expert technical recruiter',
  'repair request',
  'your previous response did not conform to the required schema',
] as const;

// Real secret-key formats only. OpenAI project-scoped keys start with
// "sk-proj-"; a generic long "sk-"-prefixed token covers the classic
// OpenAI format as well as the same general style used by several other
// providers. Both are long, structured strings with no plausible reason
// to appear in CV content or a classification response.
const SECRET_PATTERNS: RegExp[] = [/sk-proj-[a-zA-Z0-9_-]{10,}/i, /sk-[a-zA-Z0-9_-]{20,}/];

/**
 * Scans raw model output for signs it leaked this agent's own system
 * instructions or something shaped like a real secret/API key. Returns
 * the list of matched indicators (empty if clean) so the caller can log
 * exactly what was matched without needing to re-derive it.
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

const STOPWORDS = new Set([
  'the', 'and', 'with', 'that', 'this', 'from', 'have', 'your', 'their',
  'which', 'about', 'into', 'they', 'them', 'were', 'been', 'will',
  'would', 'could', 'should', 'there', 'these', 'those', 'some', 'such',
  'only', 'also', 'than', 'then', 'when', 'what', 'where', 'while',
  'after', 'before', 'both', 'each', 'more', 'most', 'other', 'over',
  'under', 'does', 'not', 'cite', 'evidence', 'category',
]);

function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(word => word.length >= 4 && !STOPWORDS.has(word) && !CATEGORY_NAME_WORDS.has(word))
  );
}

/**
 * Checks that the rationale entry justifying primaryCategory actually
 * shares vocabulary with the submitted CV. This is a heuristic, not a
 * semantic proof - it cannot catch a sufficiently clever paraphrase - but
 * it is a real, cheap, zero-extra-LLM-call defense against exactly the
 * "return this category regardless of the CV" style of injection: if the
 * model complies, it has no genuine evidence to cite, and a fabricated
 * justification will not overlap with the CV's actual vocabulary.
 *
 * Deliberately scoped to the primaryCategory's entry only (not every
 * rationale entry) - that is the entry that justifies the actual
 * decision being made, and keeping the check narrow limits false
 * positives against legitimate, loosely-worded secondary-category notes.
 */
export function isPrimaryRationaleGrounded(
  primaryCategory: string,
  rationale: Array<{ category: string; evidence: string }>,
  cvContent: string
): boolean {
  const cvWords = significantWords(cvContent);
  if (cvWords.size === 0) {
    // Nothing meaningful to ground against (shouldn't happen given the
    // request-level minimum length check) - don't fail on our own gap.
    return true;
  }

  const primaryEntries = rationale.filter(entry => entry.category === primaryCategory);
  if (primaryEntries.length === 0) {
    return false; // schema already requires this to be non-empty; treat absence as ungrounded
  }

  return primaryEntries.some(entry => {
    const evidenceWords = significantWords(entry.evidence);
    for (const word of evidenceWords) {
      if (cvWords.has(word)) return true;
    }
    return false;
  });
}

/**
 * Output sanitization applied to accepted evidence text before it is
 * persisted/returned: strips HTML/XML-like tags and control characters,
 * and normalizes whitespace. This does not change the Zod-validated
 * shape or re-run business-rule checks - it is a narrow defense against
 * the free-text evidence field being used as a markup/control-character
 * injection vector for whatever eventually renders it (e.g. a future
 * dashboard). The unsanitized original is still preserved verbatim in
 * rawResponse for audit.
 */
export function sanitizeEvidenceText(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
