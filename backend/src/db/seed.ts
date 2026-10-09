import bcryptjs from 'bcryptjs';
import prisma from './client.js';
import { CV_CATEGORIES } from '../utils/validators.js';

/** Fills in the other 8 categories at 0 so demo confidence maps match the real agent's required shape (all 9 categories present). */
function confidenceMap(overrides: Partial<Record<(typeof CV_CATEGORIES)[number], number>>) {
  const map = Object.fromEntries(CV_CATEGORIES.map(category => [category, 0])) as Record<
    (typeof CV_CATEGORIES)[number],
    number
  >;
  return { ...map, ...overrides };
}

async function main() {
  console.log('Seeding database...');

  // Clean up existing data (for a fresh seed), children before parents.
  // RefreshToken/AgentRun/etc. would also cascade from deleting users, but
  // deleting explicitly in dependency order is safer than relying on that.
  await prisma.recommendationDecision.deleteMany();
  await prisma.cvRecommendation.deleteMany();
  await prisma.cvDocument.deleteMany();
  await prisma.sentimentResult.deleteMany();
  await prisma.llmUsageLog.deleteMany();
  await prisma.agentRun.deleteMany();
  await prisma.externalAgentLog.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();
  await prisma.agent.deleteMany();

  // Create agents
  const cvAgent = await prisma.agent.create({
    data: {
      name: 'CV Classification Agent',
      description: 'Classifies CVs into predefined categories',
      version: '1.0.0',
    },
  });

  const sentimentAgent = await prisma.agent.create({
    data: {
      name: 'Sentiment Analysis Agent',
      description: 'Analyzes sentiment in feedback and text',
      version: '1.0.0',
    },
  });

  console.log('✓ Created agents');

  // Create demo users
  // NOTE: these are LOCAL DEVELOPMENT credentials only. They are
  // intentionally weak and documented here because this seed script
  // only ever runs against a local/dev database - never use this
  // pattern to seed a staging or production environment.
  const passwordHash = await bcryptjs.hash('password123', 10);

  const adminUser = await prisma.user.create({
    data: {
      email: 'admin@example.com',
      password: passwordHash,
      role: 'ADMIN',
    },
  });

  const user1 = await prisma.user.create({
    data: {
      email: 'user1@example.com',
      password: passwordHash,
      role: 'USER',
    },
  });

  const user2 = await prisma.user.create({
    data: {
      email: 'user2@example.com',
      password: passwordHash,
      role: 'USER',
    },
  });

  const user3 = await prisma.user.create({
    data: {
      email: 'user3@example.com',
      password: passwordHash,
      role: 'USER',
    },
  });

  console.log(`✓ Created demo users (admin id=${adminUser.id})`);

  // ───────────────────────────────────────────────────────────────
  // Demo pipeline data: one full CV run (ACCEPT) for user1, one full
  // CV run (MODIFY, which requires a reason) for user2, and one
  // sentiment run for user3. Every LLMUsageLog row created here sets
  // isSeedData: true - real agent calls must never set this flag, so
  // dashboard/evaluation queries can filter demo rows out and never
  // mistake fabricated token counts for genuine usage data.
  // ───────────────────────────────────────────────────────────────

  // --- user1: CV run, ACCEPT decision (no reason required) ---
  const user1Document = await prisma.cvDocument.create({
    data: {
      userId: user1.id,
      fileName: 'jane-doe-resume.txt',
      content:
        'Jane Doe - 6 years building REST APIs in Node.js and PostgreSQL, ' +
        'leading a team of 4 backend engineers, designed event-driven ' +
        'microservices handling 10k req/s.',
    },
  });

  const user1Run = await prisma.agentRun.create({
    data: {
      userId: user1.id,
      agentId: cvAgent.id,
      agentName: cvAgent.name,
      status: 'SUCCESS',
      completedAt: new Date(),
    },
  });

  await prisma.llmUsageLog.create({
    data: {
      timestamp: user1Run.startedAt,
      runId: user1Run.id,
      userId: user1.id,
      agentId: cvAgent.id,
      agentName: cvAgent.name,
      model: 'gpt-4o',
      inputTokens: 612,
      outputTokens: 148,
      latencyMs: 1850,
      status: 'SUCCESS',
      estimatedCost: 0.0202,
      isSeedData: true,
    },
  });

  const user1Confidence = confidenceMap({ 'Back-End Developer': 0.91, 'AI Engineer': 0.22 });
  const user1Rationale = [
    {
      category: 'Back-End Developer',
      evidence:
        '"6 years building REST APIs in Node.js and PostgreSQL... designed event-driven microservices handling 10k req/s"',
    },
    {
      category: 'AI Engineer',
      evidence: 'No direct ML/LLM experience mentioned - low secondary confidence only.',
    },
  ];

  const user1Recommendation = await prisma.cvRecommendation.create({
    data: {
      cvDocumentId: user1Document.id,
      runId: user1Run.id,
      userId: user1.id,
      agentId: cvAgent.id,
      primaryCategory: 'Back-End Developer',
      secondaryCategories: ['AI Engineer'],
      confidenceScore: user1Confidence['Back-End Developer'],
      confidenceScores: user1Confidence,
      rationale: user1Rationale,
      rawResponse: {
        primaryCategory: 'Back-End Developer',
        secondaryCategories: ['AI Engineer'],
        confidence: user1Confidence,
        rationale: user1Rationale,
      },
    },
  });

  await prisma.recommendationDecision.create({
    data: {
      recommendationId: user1Recommendation.id,
      cvDocumentId: user1Document.id,
      agentRunId: user1Run.id,
      userId: user1.id,
      decisionType: 'ACCEPT',
      finalPrimaryCategory: 'Back-End Developer',
      finalSecondaryCategories: ['AI Engineer'],
      // reason intentionally omitted - optional for ACCEPT
    },
  });

  // --- user2: CV run, MODIFY decision (reason IS required) ---
  const user2Document = await prisma.cvDocument.create({
    data: {
      userId: user2.id,
      fileName: 'alex-smith-resume.txt',
      content:
        'Alex Smith - built React dashboards for 3 years, recently moved into ' +
        'designing the GraphQL API layer and owns the deployment pipeline for ' +
        'the backend services.',
    },
  });

  const user2Run = await prisma.agentRun.create({
    data: {
      userId: user2.id,
      agentId: cvAgent.id,
      agentName: cvAgent.name,
      status: 'SUCCESS',
      completedAt: new Date(),
    },
  });

  await prisma.llmUsageLog.create({
    data: {
      timestamp: user2Run.startedAt,
      runId: user2Run.id,
      userId: user2.id,
      agentId: cvAgent.id,
      agentName: cvAgent.name,
      model: 'gpt-4o',
      inputTokens: 548,
      outputTokens: 132,
      latencyMs: 1620,
      status: 'SUCCESS',
      estimatedCost: 0.0181,
      isSeedData: true,
    },
  });

  const user2Confidence = confidenceMap({ 'Front-End Developer': 0.68, 'Back-End Developer': 0.6 });
  const user2Rationale = [
    { category: 'Front-End Developer', evidence: '"built React dashboards for 3 years"' },
    {
      category: 'Back-End Developer',
      evidence: '"recently moved into designing the GraphQL API layer and owns the deployment pipeline"',
    },
  ];

  const user2Recommendation = await prisma.cvRecommendation.create({
    data: {
      cvDocumentId: user2Document.id,
      runId: user2Run.id,
      userId: user2.id,
      agentId: cvAgent.id,
      primaryCategory: 'Front-End Developer',
      secondaryCategories: ['Back-End Developer'],
      confidenceScore: user2Confidence['Front-End Developer'],
      confidenceScores: user2Confidence,
      rationale: user2Rationale,
      rawResponse: {
        primaryCategory: 'Front-End Developer',
        secondaryCategories: ['Back-End Developer'],
        confidence: user2Confidence,
        rationale: user2Rationale,
      },
    },
  });

  await prisma.recommendationDecision.create({
    data: {
      recommendationId: user2Recommendation.id,
      cvDocumentId: user2Document.id,
      agentRunId: user2Run.id,
      userId: user2.id,
      decisionType: 'MODIFY',
      finalPrimaryCategory: 'Back-End Developer',
      finalSecondaryCategories: [],
      reason:
        'Reviewer judged the GraphQL API design and deployment-pipeline ownership ' +
        'as more representative of this candidate\'s current role than the React work.',
    },
  });

  // --- user3: Sentiment run ---
  const user3Run = await prisma.agentRun.create({
    data: {
      userId: user3.id,
      agentId: sentimentAgent.id,
      agentName: sentimentAgent.name,
      status: 'SUCCESS',
      completedAt: new Date(),
    },
  });

  await prisma.llmUsageLog.create({
    data: {
      timestamp: user3Run.startedAt,
      runId: user3Run.id,
      userId: user3.id,
      agentId: sentimentAgent.id,
      agentName: sentimentAgent.name,
      model: 'gpt-4o',
      inputTokens: 210,
      outputTokens: 64,
      latencyMs: 890,
      status: 'SUCCESS',
      estimatedCost: 0.0068,
      isSeedData: true,
    },
  });

  await prisma.sentimentResult.create({
    data: {
      runId: user3Run.id,
      userId: user3.id,
      agentId: sentimentAgent.id,
      inputText: 'The onboarding process was confusing and took way longer than expected.',
      sentiment: 'NEGATIVE',
      confidence: 0.86,
      rationale: 'Explicit negative framing ("confusing", "longer than expected").',
      rawResponse: {
        sentiment: 'negative',
        confidence: 0.86,
        rationale: 'Explicit negative framing ("confusing", "longer than expected").',
      },
    },
  });

  console.log('✓ Created demo pipeline data (CV runs + decisions, sentiment run)');

  console.log('✅ Database seeded successfully!');
  console.log('\nDemo Users (LOCAL DEV ONLY - see backend/.env.example):');
  console.log('  Admin:  admin@example.com / password123');
  console.log('  User 1: user1@example.com / password123');
  console.log('  User 2: user2@example.com / password123');
  console.log('  User 3: user3@example.com / password123');
}

main()
  .catch(e => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
