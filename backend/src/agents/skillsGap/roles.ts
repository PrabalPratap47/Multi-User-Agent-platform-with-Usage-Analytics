/**
 * Target roles and the skills expected for each, used by the CV Skills
 * Extraction & Gap Analysis Agent. This is the one place role requirements
 * live: the prompt, the output validation (every configured skill must be
 * classified exactly once, gap priority must match the configured
 * importance) and the frontend role picker all read it.
 *
 * importance -> gap priority: high -> High, medium -> Medium, low -> Low.
 *
 * Role ids are stable identifiers ("PSS", "DCS" - the same ids the CV
 * categories use); `label` is the full name shown to people and given to the model.
 */

export const SKILLS_GAP_ROLES = [
  'Front-End Developer',
  'Back-End Developer',
  'Web Automation Engineer',
  'Mobile Automation Engineer',
  'AI Engineer',
  'Chatbot Application Tester',
  'PSS',
  'DCS',
] as const;

export type SkillsGapRole = (typeof SKILLS_GAP_ROLES)[number];
export type SkillImportance = 'high' | 'medium' | 'low';
export type GapPriority = 'High' | 'Medium' | 'Low';

export interface RoleSkill {
  /** Exact name the model must use for this skill. */
  name: string;
  importance: SkillImportance;
  /** What counts as this skill, so the model and the reader judge evidence the same way. */
  description: string;
}

export const PRIORITY_FOR_IMPORTANCE: Record<SkillImportance, GapPriority> = { high: 'High', medium: 'Medium', low: 'Low' };

export const ROLE_REQUIREMENTS: Record<SkillsGapRole, { label: string; summary: string; skills: RoleSkill[] }> = {
  'Front-End Developer': {
    label: 'Front-End Developer',
    summary: 'Builds accessible, responsive user interfaces for web applications.',
    skills: [
      { name: 'HTML and semantic markup', importance: 'high', description: 'Structuring pages with semantic HTML elements and forms.' },
      { name: 'CSS and responsive layout', importance: 'high', description: 'Flexbox/grid layouts, responsive design, a CSS methodology or utility framework.' },
      { name: 'JavaScript (ES2015+)', importance: 'high', description: 'Modern JavaScript: modules, async/await, DOM and browser APIs.' },
      { name: 'Component framework (React, Vue or Angular)', importance: 'high', description: 'Building and composing components, state management, routing.' },
      { name: 'TypeScript', importance: 'medium', description: 'Typing components, props and API data.' },
      { name: 'Web accessibility (WCAG)', importance: 'medium', description: 'Keyboard support, ARIA, contrast, screen-reader testing.' },
      { name: 'Front-end testing', importance: 'medium', description: 'Unit and component tests (e.g. Jest, Vitest, Testing Library).' },
      { name: 'Build tooling and web performance', importance: 'low', description: 'Bundlers (Vite, Webpack), code splitting, Core Web Vitals.' },
    ],
  },
  'Back-End Developer': {
    label: 'Back-End Developer',
    summary: 'Builds and operates server-side services, APIs and data storage.',
    skills: [
      { name: 'Server-side programming language', importance: 'high', description: 'Production work in e.g. Node.js, Java, Python, Go or C#.' },
      { name: 'REST API design', importance: 'high', description: 'Resource design, status codes, validation, versioning.' },
      { name: 'Relational databases and SQL', importance: 'high', description: 'Schema design, queries, indexes, migrations, transactions.' },
      { name: 'Authentication and authorization', importance: 'high', description: 'Sessions or tokens (e.g. JWT), password hashing, role-based access.' },
      { name: 'Automated backend testing', importance: 'medium', description: 'Unit and integration tests for services and APIs.' },
      { name: 'Caching and performance', importance: 'medium', description: 'Caching layers (e.g. Redis), profiling, query optimization.' },
      { name: 'Containers and CI/CD', importance: 'medium', description: 'Docker images, automated build/test/deploy pipelines.' },
      { name: 'Logging and monitoring', importance: 'low', description: 'Structured logs, metrics, alerting, tracing.' },
    ],
  },
  'Web Automation Engineer': {
    label: 'Web Automation Engineer',
    summary: 'Automates end-to-end testing of web applications.',
    skills: [
      { name: 'Browser automation framework (Selenium, Playwright or Cypress)', importance: 'high', description: 'Writing and maintaining automated browser tests.' },
      { name: 'Programming for test automation', importance: 'high', description: 'Test code in e.g. JavaScript/TypeScript, Java or Python.' },
      { name: 'Locator strategies and page objects', importance: 'high', description: 'Stable selectors, page-object or screenplay patterns.' },
      { name: 'Test design and test case management', importance: 'medium', description: 'Deriving test cases from requirements, coverage, test data.' },
      { name: 'API testing', importance: 'medium', description: 'Testing REST APIs (e.g. Postman, REST Assured, Playwright request).' },
      { name: 'CI integration of test suites', importance: 'medium', description: 'Running suites in CI, parallelization, reports.' },
      { name: 'Flaky test diagnosis and reporting', importance: 'low', description: 'Finding root causes of unstable tests, clear defect reports.' },
    ],
  },
  'Mobile Automation Engineer': {
    label: 'Mobile Automation Engineer',
    summary: 'Automates testing of native and hybrid mobile apps.',
    skills: [
      { name: 'Mobile automation framework (Appium, Espresso or XCUITest)', importance: 'high', description: 'Writing and maintaining automated mobile UI tests.' },
      { name: 'Programming for test automation', importance: 'high', description: 'Test code in e.g. Java, Kotlin, Swift, Python or JavaScript.' },
      { name: 'Android and iOS platform fundamentals', importance: 'high', description: 'App lifecycle, permissions, builds (APK/IPA), platform differences.' },
      { name: 'Emulators, simulators and device farms', importance: 'medium', description: 'Running tests on virtual and real devices (e.g. BrowserStack, Sauce Labs).' },
      { name: 'Mobile test design', importance: 'medium', description: 'Gestures, interruptions, orientation, network conditions.' },
      { name: 'CI integration for mobile builds', importance: 'medium', description: 'Building apps and running mobile suites in CI.' },
      { name: 'Mobile performance and crash analysis', importance: 'low', description: 'Startup time, memory, crash logs and reports.' },
    ],
  },
  'AI Engineer': {
    label: 'AI Engineer',
    summary: 'Builds applications and services on top of machine learning and LLMs.',
    skills: [
      { name: 'Python for AI development', importance: 'high', description: 'Python with common AI/ML libraries.' },
      { name: 'LLM APIs and prompt engineering', importance: 'high', description: 'Calling LLM APIs, structured prompts, structured output.' },
      { name: 'Retrieval-augmented generation (RAG) and vector search', importance: 'high', description: 'Embeddings, vector databases, retrieval pipelines.' },
      { name: 'Machine learning fundamentals', importance: 'medium', description: 'Training, validation, overfitting, evaluation metrics.' },
      { name: 'Evaluation of AI output', importance: 'medium', description: 'Test sets, automated and human evaluation of model output.' },
      { name: 'Deploying AI services', importance: 'medium', description: 'Serving models or LLM features behind APIs, containers, cost control.' },
      { name: 'AI safety and prompt-injection defense', importance: 'low', description: 'Guardrails, input/output validation, abuse handling.' },
    ],
  },
  'Chatbot Application Tester': {
    label: 'Chatbot Application Tester',
    summary: 'Tests conversational applications, including LLM-based chatbots.',
    skills: [
      { name: 'Conversational flow testing', importance: 'high', description: 'Testing dialogs, context handling, fallbacks and hand-offs.' },
      { name: 'NLU test design (intents, entities, utterances)', importance: 'high', description: 'Utterance variations, intent confusion, entity extraction.' },
      { name: 'LLM output evaluation', importance: 'high', description: 'Accuracy, hallucination, tone and policy compliance of responses.' },
      { name: 'Prompt-injection and safety testing', importance: 'medium', description: 'Adversarial prompts, jailbreak attempts, data leakage checks.' },
      { name: 'API testing of chatbot backends', importance: 'medium', description: 'Testing the services and integrations behind the chat interface.' },
      { name: 'Test automation for chat interfaces', importance: 'medium', description: 'Automating conversations through UI or APIs.' },
      { name: 'Defect reporting and conversation analytics', importance: 'low', description: 'Clear defect reports, analyzing transcripts and metrics.' },
    ],
  },
  PSS: {
    label: 'Passenger Service System',
    summary: 'Works on airline reservation, inventory and ticketing systems (Passenger Service System platforms).',
    skills: [
      { name: 'Airline reservations and booking workflows', importance: 'high', description: 'Creating, changing and cancelling bookings (PNRs), itineraries and fares.' },
      { name: 'Inventory and availability management', importance: 'high', description: 'Flight inventory, seat availability, booking classes, overbooking controls.' },
      { name: 'Ticketing concepts', importance: 'high', description: 'Ticket issuance, reissue and refund, electronic tickets and EMDs.' },
      { name: 'PSS platforms (e.g. Amadeus Altea, Sabre, Navitaire)', importance: 'medium', description: 'Hands-on work with a Passenger Service System platform.' },
      { name: 'Airline system integrations', importance: 'medium', description: 'Integrating with PSS/GDS systems via APIs, NDC or EDIFACT/Type B messaging.' },
      { name: 'Airline industry standards (IATA)', importance: 'low', description: 'IATA standards and codes, GDS concepts, industry messaging formats.' },
    ],
  },
  DCS: {
    label: 'Departure Control System',
    summary: 'Works on airport check-in, boarding and load control systems (Departure Control System platforms).',
    skills: [
      { name: 'Passenger check-in', importance: 'high', description: 'Check-in channels (counter, web, mobile, kiosk), document checks, seat assignment, baggage acceptance.' },
      { name: 'Boarding workflows', importance: 'high', description: 'Boarding passes, gate processes, boarding reconciliation.' },
      { name: 'Departure control operations', importance: 'high', description: 'Flight opening and close-out, standby and upgrade lists, irregular operations.' },
      { name: 'Load control concepts', importance: 'medium', description: 'Weight and balance, load sheets, passenger and baggage figures.' },
      { name: 'DCS platforms (e.g. Amadeus Altea DCS, SITA, Navitaire)', importance: 'medium', description: 'Hands-on work with a Departure Control System platform.' },
      { name: 'Airport and airline system integrations', importance: 'low', description: 'Integrations with PSS, baggage and airport systems (APIs, Type B messages).' },
    ],
  },
};

export function isSkillsGapRole(value: unknown): value is SkillsGapRole {
  return typeof value === 'string' && (SKILLS_GAP_ROLES as readonly string[]).includes(value);
}
