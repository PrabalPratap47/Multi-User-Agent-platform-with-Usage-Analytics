/**
 * Valid `feedback` for scripted CV Classification replies: two complete
 * sentences that quote the reply's own CV evidence, so they pass the
 * sentence-count and grounding checks (agents/cvClassification/feedback.ts)
 * exactly like real feedback about that CV would.
 */
export function cvFeedbackFrom(evidence: string): string {
  const quoted = evidence
    .split(/\s+/)
    .slice(0, 16)
    .join(' ')
    .replace(/[.!?]+(?=\s|$)/g, '')
    .trim();
  return `The CV clearly presents this work: ${quoted}. It could be improved by adding measurable outcomes and more detail about the tools used.`;
}
