import type { SkillsGapResponse } from '../../src/agents/skillsGap/schema.js';

/** A synthetic CV (no real person) for the Front-End Developer role. */
export const SAMPLE_CV = [
  'Sam Rivera - front-end developer (synthetic test CV).',
  'Built responsive layouts with CSS grid and flexbox for an e-commerce storefront.',
  'Wrote React components with hooks and context for the checkout flow.',
  'Created semantic HTML forms with labels and fieldsets.',
  'Some exposure to TypeScript in a weekend side project.',
].join('\n');

/**
 * A valid analysis of SAMPLE_CV: every one of the 8 Front-End Developer
 * skills classified once (3 demonstrated, 2 partial, 3 gaps with their
 * configured priorities), evidence copied from the CV, a 4-stage roadmap.
 */
export function validAnalysis(): SkillsGapResponse {
  const gap = (skill: string, priority: 'High' | 'Medium' | 'Low', topic: string) => ({
    skill,
    status: 'not_demonstrated' as const,
    priority,
    whyItMatters: `${skill} is expected of front-end developers shipping production interfaces.`,
    whatToUnderstand: `The core concepts of ${skill.toLowerCase()} and when to apply them.`,
    topics: [topic],
    practicalExercise: `Apply ${topic} to the checkout flow described in the CV.`,
    miniProject: `A small demo app that showcases ${topic}.`,
    completionCriterion: `A reviewed pull request that applies ${topic} with tests passing.`,
    estimatedLearningTime: { minHours: 6, maxHours: 12, isApproximate: true as const },
  });
  return {
    targetRole: 'Front-End Developer',
    overallSummary:
      'The CV shows practical layout, component and form work. Testing, accessibility and build tooling are not demonstrated in the submitted CV. This is an AI-generated learning aid.',
    demonstratedSkills: [
      { skill: 'HTML and semantic markup', status: 'demonstrated', evidence: 'Created semantic HTML forms with labels and fieldsets.' },
      { skill: 'CSS and responsive layout', status: 'demonstrated', evidence: 'Built responsive layouts with CSS grid and flexbox' },
      { skill: 'Component framework (React, Vue or Angular)', status: 'demonstrated', evidence: 'Wrote React components with hooks and context' },
    ],
    partiallyDemonstratedSkills: [
      {
        skill: 'JavaScript (ES2015+)',
        status: 'partially_demonstrated',
        evidence: 'React components with hooks and context for the checkout flow',
        missingEvidence: 'No JavaScript work outside React components is shown.',
      },
      {
        skill: 'TypeScript',
        status: 'partially_demonstrated',
        evidence: 'Some exposure to TypeScript in a weekend side project.',
        missingEvidence: 'No production TypeScript code is described.',
      },
    ],
    potentialGaps: [
      gap('Web accessibility (WCAG)', 'Medium', 'keyboard navigation and ARIA roles'),
      gap('Front-end testing', 'Medium', 'component tests with Testing Library'),
      gap('Build tooling and web performance', 'Low', 'code splitting with Vite'),
    ],
    learningRoadmap: [
      { stage: 1, title: 'Foundational skills', objective: 'Strengthen modern JavaScript and TypeScript.', topics: ['async/await', 'TypeScript generics'], practicalTask: 'Convert one checkout component to TypeScript.', completionCriteria: 'The component compiles with strict mode on.' },
      { stage: 2, title: 'Role-specific technical skills', objective: 'Learn accessibility and testing.', topics: ['WCAG 2.2 AA', 'Testing Library'], practicalTask: 'Audit the checkout form with a screen reader.', completionCriteria: 'No critical axe findings remain.' },
      { stage: 3, title: 'Practical application and projects', objective: 'Ship a tested, accessible feature.', topics: ['component tests', 'code splitting'], practicalTask: 'Build a product filter with tests.', completionCriteria: 'Test coverage of the feature is above 80%.' },
      { stage: 4, title: 'Interview preparation and review', objective: 'Explain the decisions made.', topics: ['React rendering', 'accessibility trade-offs'], practicalTask: 'Present the project to a peer.', completionCriteria: 'Answer five common front-end questions.' },
    ],
    estimatedPreparationTime: { minWeeks: 6, maxWeeks: 10, hoursPerWeekAssumed: 8, isApproximate: true, note: 'Assumes 8 hours of study per week; an approximate estimate.' },
    limitations: ['AI-generated learning aid based only on the submitted CV text; skills not shown in the CV may still be held.'],
  };
}

/** Synthetic airline CVs (no real person) for the PSS and DCS roles. */
export const PSS_CV = ['Jordan Park - airline systems analyst (synthetic test CV).', 'Configured airline reservations and booking workflows for a regional carrier.', 'Supported ticketing reissue and refund requests for agents.'].join('\n');
export const DCS_CV = ['Alex Moreno - airport systems specialist (synthetic test CV).', 'Ran passenger check-in at counters and kiosks for a hub airport.', 'Coordinated boarding workflows at the gate during peak hours.'].join('\n');

/**
 * A valid analysis for any role from its own configured skills: skills whose
 * name shares a word with a CV line are demonstrated (that line as evidence),
 * every other skill is a gap with its configured priority.
 */
export function analysisFor(role: import('../../src/agents/skillsGap/roles.js').SkillsGapRole, cv: string, roles: typeof import('../../src/agents/skillsGap/roles.js')): SkillsGapResponse {
  const lines = cv.split('\n').slice(1);
  const words = (name: string) => name.toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 5);
  const demonstratedSkills: SkillsGapResponse['demonstratedSkills'] = [];
  const potentialGaps: SkillsGapResponse['potentialGaps'] = [];
  for (const skill of roles.ROLE_REQUIREMENTS[role].skills) {
    const line = lines.find(l => words(skill.name).some(w => l.toLowerCase().includes(w)));
    if (line) demonstratedSkills.push({ skill: skill.name, status: 'demonstrated', evidence: line });
    else
      potentialGaps.push({
        skill: skill.name,
        status: 'not_demonstrated',
        priority: roles.PRIORITY_FOR_IMPORTANCE[skill.importance],
        whyItMatters: `${skill.name} is part of day-to-day ${roles.ROLE_REQUIREMENTS[role].label} work.`,
        whatToUnderstand: skill.description,
        topics: [`${skill.name} fundamentals`],
        practicalExercise: `Work through a realistic ${skill.name.toLowerCase()} scenario in a training environment.`,
        miniProject: null,
        completionCriterion: `Explain and demonstrate one ${skill.name.toLowerCase()} scenario end to end.`,
        estimatedLearningTime: { minHours: 8, maxHours: 16, isApproximate: true },
      });
  }
  const stage = (n: number, title: string) => ({ stage: n, title, objective: `${title} for ${roles.ROLE_REQUIREMENTS[role].label}.`, topics: [title], practicalTask: `A ${title.toLowerCase()} task.`, completionCriteria: 'Reviewed by a peer.' });
  return {
    targetRole: role,
    overallSummary: `Compared with the ${roles.ROLE_REQUIREMENTS[role].label} role.`,
    demonstratedSkills,
    partiallyDemonstratedSkills: [],
    potentialGaps,
    learningRoadmap: [stage(1, 'Foundational skills'), stage(2, 'Role-specific technical skills')],
    estimatedPreparationTime: { minWeeks: 4, maxWeeks: 8, hoursPerWeekAssumed: 6, isApproximate: true, note: 'Approximate.' },
    limitations: ['Based only on the submitted CV text.'],
  };
}
