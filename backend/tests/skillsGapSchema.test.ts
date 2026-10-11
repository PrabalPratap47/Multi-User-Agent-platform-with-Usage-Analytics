import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SkillsGapResponseSchema } from '../src/agents/skillsGap/schema.js';
import { SKILLS_GAP_ROLES } from '../src/agents/skillsGap/roles.js';
import { validAnalysis } from './fixtures/skillsGapFixtures.js';

const jsonSchema = JSON.parse(readFileSync(new URL('../src/agents/skillsGap/skillsGapResponse.schema.json', import.meta.url), 'utf8'));
const accepts = (value: unknown) => SkillsGapResponseSchema.safeParse(value).success;

describe('SkillsGapResponseSchema', () => {
  it('accepts a complete, valid analysis', () => {
    expect(accepts(validAnalysis())).toBe(true);
  });

  const invalid: Array<[string, (a: Record<string, unknown> & ReturnType<typeof validAnalysis>) => unknown]> = [
    ['an unknown target role', a => ({ ...a, targetRole: 'Astronaut' })],
    ['a missing required field (limitations)', ({ limitations: _l, ...rest }) => rest],
    ['an extra top-level field', a => ({ ...a, isAdmin: true })],
    ['an extra field inside a skill entry', a => ({ ...a, demonstratedSkills: [{ ...a.demonstratedSkills[0], confidence: 0.9 }] })],
    ['a wrong status on a demonstrated skill', a => ({ ...a, demonstratedSkills: [{ ...a.demonstratedSkills[0], status: 'not_demonstrated' }] })],
    ['an invalid gap priority', a => ({ ...a, potentialGaps: [{ ...a.potentialGaps[0], priority: 'Critical' }] })],
    ['an empty evidence string', a => ({ ...a, demonstratedSkills: [{ ...a.demonstratedSkills[0], evidence: '  ' }] })],
    ['learning hours of 0', a => ({ ...a, potentialGaps: [{ ...a.potentialGaps[0], estimatedLearningTime: { minHours: 0, maxHours: 4, isApproximate: true } }] })],
    ['minHours above maxHours', a => ({ ...a, potentialGaps: [{ ...a.potentialGaps[0], estimatedLearningTime: { minHours: 20, maxHours: 4, isApproximate: true } }] })],
    ['an estimate not marked approximate', a => ({ ...a, estimatedPreparationTime: { ...a.estimatedPreparationTime, isApproximate: false } })],
    ['minWeeks above maxWeeks', a => ({ ...a, estimatedPreparationTime: { ...a.estimatedPreparationTime, minWeeks: 12, maxWeeks: 2 } })],
    ['hours as a string', a => ({ ...a, potentialGaps: [{ ...a.potentialGaps[0], estimatedLearningTime: { minHours: '6', maxHours: 12, isApproximate: true } }] })],
    ['a single-stage roadmap', a => ({ ...a, learningRoadmap: [a.learningRoadmap[0]] })],
    ['roadmap stages out of order', a => ({ ...a, learningRoadmap: [a.learningRoadmap[1], a.learningRoadmap[0]] })],
    ['a gap with no topics', a => ({ ...a, potentialGaps: [{ ...a.potentialGaps[0], topics: [] }] })],
    ['an over-long summary', a => ({ ...a, overallSummary: 'x'.repeat(1501) })],
  ];
  for (const [name, mutate] of invalid) {
    it(`rejects ${name}`, () => {
      expect(accepts(mutate(validAnalysis() as Record<string, unknown> & ReturnType<typeof validAnalysis>))).toBe(false);
    });
  }

  it('allows miniProject to be null', () => {
    const a = validAnalysis();
    a.potentialGaps[0].miniProject = null;
    expect(accepts(a)).toBe(true);
  });
});

describe('documented JSON Schema stays in sync', () => {
  it('lists exactly the configured roles and the same required top-level fields', () => {
    expect(jsonSchema.properties.targetRole.enum).toEqual([...SKILLS_GAP_ROLES]);
    expect([...jsonSchema.required].sort()).toEqual(Object.keys(validAnalysis()).sort());
    expect(jsonSchema.additionalProperties).toBe(false);
    expect(jsonSchema.properties.potentialGaps.items.properties.priority.enum).toEqual(['High', 'Medium', 'Low']);
  });
});
