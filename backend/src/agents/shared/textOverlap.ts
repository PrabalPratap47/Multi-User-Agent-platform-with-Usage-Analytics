/**
 * Generic word-overlap heuristic, used by agent-specific groundedness
 * checks (e.g. agents/sentiment/outputGuard.ts) to verify a model's
 * free-text output actually shares vocabulary with the real input it was
 * supposedly derived from.
 *
 * NOTE: agents/cvClassification/outputGuard.ts has its own, separately
 * maintained copy of this same word-tokenization logic rather than
 * importing this file. That is a deliberate, acknowledged trade-off, not
 * an oversight: by the time this shared version was extracted, the CV
 * agent's version had already been hand-verified against its full test
 * suite, and changing its imports carried a real risk of a subtle
 * regression for no functional benefit. Consolidating the two into one
 * shared implementation is a reasonable follow-up, done as its own
 * careful, tested change rather than bundled into unrelated work.
 */

const DEFAULT_STOPWORDS = new Set([
  'the', 'and', 'with', 'that', 'this', 'from', 'have', 'your', 'their',
  'which', 'about', 'into', 'they', 'them', 'were', 'been', 'will',
  'would', 'could', 'should', 'there', 'these', 'those', 'some', 'such',
  'only', 'also', 'than', 'then', 'when', 'what', 'where', 'while',
  'after', 'before', 'both', 'each', 'more', 'most', 'other', 'over',
  'under', 'does', 'not',
]);

/**
 * Tokenizes text into lowercase words of 4+ characters, excluding common
 * English stopwords and any caller-supplied extra exclusions (e.g. the
 * sentiment labels themselves, which are common enough English words -
 * "positive", "negative" - that a legitimate piece of feedback could
 * mention them without that being evidence of anything).
 */
export function significantWords(text: string, extraExclusions: ReadonlySet<string> = new Set()): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(word => word.length >= 4 && !DEFAULT_STOPWORDS.has(word) && !extraExclusions.has(word))
  );
}

/** True if textA and textB share at least one significant word. */
export function sharesVocabulary(
  textA: string,
  textB: string,
  extraExclusions: ReadonlySet<string> = new Set()
): boolean {
  const wordsA = significantWords(textA, extraExclusions);
  const wordsB = significantWords(textB, extraExclusions);
  for (const word of wordsA) {
    if (wordsB.has(word)) return true;
  }
  return false;
}
