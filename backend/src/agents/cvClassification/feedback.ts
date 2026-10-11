import { significantWords } from '../shared/textOverlap.js';
import { CV_CATEGORIES } from '../../utils/validators.js';

/**
 * Rules for the `feedback` field of the CV Classification Agent's output:
 * 2-4 complete sentences of constructive feedback about the CV, specific
 * to its content. Checked by the Zod schema (sentence count) and by the
 * agent (grounding), so invalid feedback goes through the normal repair
 * retry and is never stored or shown.
 */

export const MIN_FEEDBACK_SENTENCES = 2;
export const MAX_FEEDBACK_SENTENCES = 4;
export const MAX_FEEDBACK_LENGTH = 1200;

/**
 * Counts complete sentences: text ending in . ! or ? (optionally followed
 * by a closing quote or bracket), where the next sentence starts with a
 * capital letter, digit or opening quote. "Node.js" or "v2.1" do not end a
 * sentence; an abbreviation such as "e.g. React" would, which is why the
 * prompt asks for plain sentences without abbreviations. A heuristic.
 */
export function countSentences(text: string): number {
  const trimmed = text.trim();
  if (!/[.!?]["')\]]?$/.test(trimmed)) return 0; // the last sentence must be complete
  const ends = trimmed.match(/[.!?]+["')\]]?(?=\s+["'(“]?[A-Z0-9]|\s*$)/g);
  return ends ? ends.length : 0;
}

export function hasValidSentenceCount(text: string): boolean {
  const n = countSentences(text);
  return n >= MIN_FEEDBACK_SENTENCES && n <= MAX_FEEDBACK_SENTENCES;
}

// Category names are excluded: feedback that only restates a category name is not grounded in the CV.
const CATEGORY_WORDS = new Set(CV_CATEGORIES.flatMap(c => c.toLowerCase().split(/[^a-z0-9]+/)).filter(w => w.length >= 4));
const GENERIC_WORDS = new Set([...CATEGORY_WORDS, 'candidate', 'experience', 'skills', 'could', 'improved', 'improve', 'clear', 'clearly', 'strong', 'relevant']);

// Sentences that read like instructions to the model are not CV evidence, so
// feedback cannot be "grounded" by echoing an injected instruction.
const INSTRUCTION_LIKE = /\b(ignore|disregard|instructions?|system prompt|you are now|override|jailbreak)\b/i;
export const MIN_SHARED_FEEDBACK_WORDS = 2;

/**
 * Feedback must refer to what the CV actually says: at least two distinct
 * significant words (4+ letters, not a stopword, a category name or a
 * generic feedback word) must occur in the CV's ordinary, non-instruction
 * sentences. Like the rationale check, a cheap heuristic against generic,
 * fabricated or injected feedback - not a semantic proof.
 */
export function isFeedbackGrounded(feedback: string, cvContent: string): boolean {
  const evidenceText = cvContent
    .split(/(?<=[.!?])\s+|\n+/)
    .filter(sentence => !INSTRUCTION_LIKE.test(sentence))
    .join(' ');
  const cvWords = significantWords(evidenceText, GENERIC_WORDS);
  if (cvWords.size < MIN_SHARED_FEEDBACK_WORDS) return true; // nothing meaningful to ground against
  let shared = 0;
  for (const word of significantWords(feedback, GENERIC_WORDS)) if (cvWords.has(word)) shared += 1;
  return shared >= MIN_SHARED_FEEDBACK_WORDS;
}
