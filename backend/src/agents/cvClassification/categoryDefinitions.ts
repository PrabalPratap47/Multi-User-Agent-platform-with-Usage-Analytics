import { CV_CATEGORIES } from '../../utils/validators.js';

type Category = (typeof CV_CATEGORIES)[number];

/**
 * The exact category definitions used to build the classifier's system
 * prompt. Keeping these centralized means the prompt, the JSON schema
 * documentation, and any future evaluation/labeling tooling all describe
 * the same categories the same way.
 */
export const CV_CATEGORY_DEFINITIONS: Record<Category, string> = {
  PSS: 'Experience with airline reservation, inventory, ticketing, or PSS platforms.',
  DCS: 'Experience with check-in, boarding, load control, or DCS platforms.',
  'Front-End Developer':
    'Angular, React, Ionic, front-end development, Tailwind CSS, Next.js, TanStack Query, Vite, Git, etc.',
  'Back-End Developer':
    'JavaScript/TypeScript with Node.js such as Express, NestJS, Fastify; Python such as Django, FastAPI, Flask; Java/Kotlin Spring Boot; etc.',
  'Web Automation': 'Web UI test automation using Selenium, Playwright, Cypress, etc.',
  'Mobile Automation': 'Mobile app test automation using Appium, Espresso, XCUITest, etc.',
  'AI Engineer': 'ML or LLM systems, RAG, AI agents, fine-tuning, model deployment, etc.',
  'Chatbot Application Tester':
    'Testing conversational applications, intent coverage, dialogue flows, LLM output quality, etc.',
  Other: 'Does not clearly fit the above categories.',
};
