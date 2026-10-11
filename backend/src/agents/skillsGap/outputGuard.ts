import { significantWords } from '../shared/textOverlap.js';
import { sanitizeEvidenceText } from '../cvClassification/outputGuard.js';
import { PRIORITY_FOR_IMPORTANCE, ROLE_REQUIREMENTS, type SkillsGapRole } from './roles.js';
import type { SkillsGapResponse } from './schema.js';

/**
 * Role- and content-level checks applied AFTER SkillsGapResponseSchema has
 * accepted the shape. Each returns problem descriptions built only from
 * fixed text and JSON paths - never from values the model returned - so
 * they can be fed into the repair prompt safely (see prompt.ts).
 */

/** Every configured skill classified exactly once, nothing else; gap priority = configured importance. */
export function checkRoleCoverage(response: SkillsGapResponse, role: SkillsGapRole): string[] {
  const problems: string[] = [];
  if (response.targetRole !== role) problems.push('targetRole: must be the requested target role');

  const expected = new Map(ROLE_REQUIREMENTS[role].skills.map(s => [s.name, s]));
  const seen = new Set<string>();
  const entries: Array<[string, string]> = [
    ...response.demonstratedSkills.map((e, i) => [e.skill, `demonstratedSkills.${i}.skill`] as [string, string]),
    ...response.partiallyDemonstratedSkills.map((e, i) => [e.skill, `partiallyDemonstratedSkills.${i}.skill`] as [string, string]),
    ...response.potentialGaps.map((e, i) => [e.skill, `potentialGaps.${i}.skill`] as [string, string]),
  ];
  for (const [skill, path] of entries) {
    if (!expected.has(skill)) problems.push(`${path}: is not one of the listed skill names`);
    else if (seen.has(skill)) problems.push(`${path}: this skill is classified more than once`);
    seen.add(skill);
  }
  const missing = [...expected.keys()].filter(name => !seen.has(name)).length;
  if (missing > 0) problems.push(`${missing} listed skill(s) are not classified - every listed skill must appear exactly once`);

  response.potentialGaps.forEach((gap, i) => {
    const configured = expected.get(gap.skill);
    if (configured && gap.priority !== PRIORITY_FOR_IMPORTANCE[configured.importance]) {
      problems.push(`potentialGaps.${i}.priority: must be the priority listed for this skill`);
    }
  });
  return problems;
}

/**
 * Non-fabrication check for evidence quoted from the CV: at least half of
 * the evidence's significant words (4+ letters) must occur in the CV; very
 * short evidence (e.g. "CSS") must occur in the CV verbatim. A heuristic,
 * like the CV Classification Agent's grounding check - not a semantic proof.
 */
export function isEvidenceInCv(evidence: string, cvContent: string): boolean {
  const words = significantWords(evidence);
  if (words.size === 0) return cvContent.toLowerCase().includes(evidence.trim().toLowerCase());
  const cvWords = significantWords(cvContent);
  let found = 0;
  for (const word of words) if (cvWords.has(word)) found += 1;
  return found / words.size >= 0.5;
}

export function checkEvidence(response: SkillsGapResponse, cvContent: string): string[] {
  const problems: string[] = [];
  response.demonstratedSkills.forEach((e, i) => {
    if (!isEvidenceInCv(e.evidence, cvContent)) problems.push(`demonstratedSkills.${i}.evidence: is not an excerpt of the CV text`);
  });
  response.partiallyDemonstratedSkills.forEach((e, i) => {
    if (!isEvidenceInCv(e.evidence, cvContent)) problems.push(`partiallyDemonstratedSkills.${i}.evidence: is not an excerpt of the CV text`);
  });
  return problems;
}

// Distinctive phrases from this agent's own system prompt, and real key formats.
const LEAK_PHRASES = [
  'role skills - use exactly these names',
  'analysis rules - mandatory',
  'security - mandatory',
  'untrusted data submitted by a user',
  'you are a careful technical career coach',
  'repair request',
];
const SECRET_PATTERNS = [/sk-proj-[a-zA-Z0-9_-]{10,}/i, /sk-[a-zA-Z0-9_-]{20,}/];

export function detectLeakage(responseText: string): boolean {
  const lower = responseText.toLowerCase();
  return LEAK_PHRASES.some(p => lower.includes(p)) || SECRET_PATTERNS.some(p => p.test(responseText));
}

/** Strips markup and control characters from every string in the accepted response (shape unchanged). */
export function sanitizeStrings<T>(value: T): T {
  if (typeof value === 'string') return sanitizeEvidenceText(value) as T;
  if (Array.isArray(value)) return value.map(v => sanitizeStrings(v)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeStrings(v)])) as T;
  }
  return value;
}
