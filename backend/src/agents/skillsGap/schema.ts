import { z } from 'zod';
import { SKILLS_GAP_ROLES } from './roles.js';

/**
 * Runtime validator for the CV Skills Extraction & Gap Analysis Agent's
 * required output. Every model response is parsed as JSON and checked here
 * before it is trusted, stored or returned; role-dependent rules (every
 * configured skill classified exactly once, gap priority = configured
 * importance, evidence present in the CV) are checked on top of this by
 * outputGuard.ts.
 *
 * The documented JSON Schema (draft-07) with the same contract is
 * skillsGapResponse.schema.json; tests/skillsGapSchema.test.ts keeps the
 * two in sync. Separate from the CV Classification schema on purpose.
 */

const text = (max: number) => z.string().trim().min(1).max(max);
const skillName = text(120);
const hours = z.number().int().min(1).max(400);
const weeks = z.number().min(0).max(104);

export const DemonstratedSkillSchema = z
  .object({
    skill: skillName,
    status: z.literal('demonstrated'),
    evidence: text(500),
  })
  .strict();

export const PartialSkillSchema = z
  .object({
    skill: skillName,
    status: z.literal('partially_demonstrated'),
    evidence: text(500),
    missingEvidence: text(500),
  })
  .strict();

export const GapSchema = z
  .object({
    skill: skillName,
    status: z.literal('not_demonstrated'),
    priority: z.enum(['High', 'Medium', 'Low']),
    whyItMatters: text(600),
    whatToUnderstand: text(600),
    topics: z.array(text(120)).min(1).max(8),
    practicalExercise: text(600),
    miniProject: text(600).nullable(),
    completionCriterion: text(400),
    estimatedLearningTime: z
      .object({ minHours: hours, maxHours: hours, isApproximate: z.literal(true) })
      .strict()
      .refine(t => t.minHours <= t.maxHours, { message: 'minHours must not exceed maxHours' }),
  })
  .strict();

export const RoadmapStageSchema = z
  .object({
    stage: z.number().int().min(1).max(6),
    title: text(80),
    objective: text(400),
    topics: z.array(text(120)).min(1).max(10),
    practicalTask: text(600),
    completionCriteria: text(400),
  })
  .strict();

export const SkillsGapResponseSchema = z
  .object({
    targetRole: z.enum(SKILLS_GAP_ROLES),
    overallSummary: text(1500),
    demonstratedSkills: z.array(DemonstratedSkillSchema).max(20),
    partiallyDemonstratedSkills: z.array(PartialSkillSchema).max(20),
    potentialGaps: z.array(GapSchema).max(20),
    learningRoadmap: z.array(RoadmapStageSchema).min(2).max(6),
    estimatedPreparationTime: z
      .object({
        minWeeks: weeks,
        maxWeeks: weeks,
        hoursPerWeekAssumed: z.number().int().min(1).max(80),
        isApproximate: z.literal(true),
        note: text(300),
      })
      .strict()
      .refine(t => t.minWeeks <= t.maxWeeks, { message: 'minWeeks must not exceed maxWeeks' }),
    limitations: z.array(text(300)).min(1).max(6),
  })
  .strict()
  .refine(data => data.learningRoadmap.every((stage, i) => stage.stage === i + 1), {
    message: 'learningRoadmap stages must be numbered 1, 2, 3, ... in order',
    path: ['learningRoadmap'],
  });

export type SkillsGapResponse = z.infer<typeof SkillsGapResponseSchema>;
