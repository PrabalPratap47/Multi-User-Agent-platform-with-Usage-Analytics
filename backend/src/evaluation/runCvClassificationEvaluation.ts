import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import prisma from '../db/client.js';
import { CvClassificationService } from '../services/cvClassificationService.js';
import { CV_CLASSIFICATION_AGENT_NAME, cvClassificationAgent } from '../agents/CVClassificationAgent.js';
import config from '../config/env.js';
import logger from '../config/logging.js';
import { computePrimaryCategoryMetrics, computeSecondaryLabelMetrics } from './metrics.js';
import { generateMarkdownReport } from './generateReport.js';
import type { EvalDataset, EvaluationRunResult, SampleResult } from './types.js';
import type { UserPayload } from '../types/index.js';
import { parseCategoryList } from '../utils/categoryList.js';

/**
 * Runs the full CV Classification Agent (the real agent, the real
 * CvClassificationService production code path, the real centralized
 * LLMService - the same code a genuine user request would hit) against
 * every sample in the labeled evaluation dataset, computes precision/
 * recall/F1/support per category and overall accuracy, and writes both
 * output artifacts.
 *
 * Requires: the development SQLite database (backend/data/dev.db) with
 * the CV Classification Agent and an admin user already seeded
 * (`npm run db:setup`), and a
 * valid OPENAI_API_KEY with available quota - this makes one real API
 * call per sample (plus up to one repair-retry call each).
 *
 * Run with: `npm run eval:cv-classification` from backend/.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..'); // backend/src/evaluation -> project root
const DATASET_PATH = join(PROJECT_ROOT, 'evaluation', 'datasets', 'cv-classification-eval-v1.json');
const RESULTS_JSON_PATH = join(PROJECT_ROOT, 'evaluation', 'cv-classification-results.json');
const REPORT_MD_PATH = join(PROJECT_ROOT, 'evaluation', 'cv-classification-report.md');

const EVAL_RUNNER_USER_EMAIL = 'admin@example.com';

async function main() {
  const dataset: EvalDataset = JSON.parse(readFileSync(DATASET_PATH, 'utf-8'));

  const runnerUser = await prisma.user.findUnique({ where: { email: EVAL_RUNNER_USER_EMAIL } });
  if (!runnerUser) {
    throw new Error(
      `Evaluation runner user "${EVAL_RUNNER_USER_EMAIL}" not found - run "npm run db:seed" first.`
    );
  }
  const userPayload: UserPayload = {
    id: runnerUser.id,
    email: runnerUser.email,
    role: runnerUser.role.toLowerCase() as 'admin' | 'user',
  };

  const agentRow = await prisma.agent.findUnique({ where: { name: CV_CLASSIFICATION_AGENT_NAME } });
  if (!agentRow) {
    throw new Error(`"${CV_CLASSIFICATION_AGENT_NAME}" is not registered - run "npm run db:seed" first.`);
  }

  const startedAt = new Date();
  logger.info(`Starting CV classification evaluation: ${dataset.samples.length} samples`);

  const sampleResults: SampleResult[] = [];

  for (const sample of dataset.samples) {
    logger.info(`Evaluating ${sample.sampleId}...`);
    try {
      // The real production path: creates a CvDocument, an AgentRun, and
      // (on success) a CvRecommendation, attributed to the eval runner
      // user - these are genuine database records of a genuine agent
      // invocation, not synthetic/seed data, because this genuinely did
      // call the real agent.
      const recommendation = await CvClassificationService.classifyContent(userPayload, {
        cvContent: sample.cvText,
        fileName: `eval:${sample.sampleId}`,
      });

      // Guard explicitly rather than passing `runId: recommendation.runId
      // ?? undefined` to Prisma - an `undefined` value in a `where`
      // clause means "no filter on this field" (matches any row), not
      // "find a null", which would silently return an unrelated log row
      // via orderBy if runId were ever actually null.
      const log = recommendation.runId
        ? await prisma.llmUsageLog.findFirst({ where: { runId: recommendation.runId }, orderBy: { id: 'desc' } })
        : null;

      sampleResults.push({
        sampleId: sample.sampleId,
        groundTruthPrimaryCategory: sample.groundTruthPrimaryCategory,
        groundTruthSecondaryCategories: sample.groundTruthSecondaryCategories,
        predictedPrimaryCategory: recommendation.primaryCategory,
        predictedSecondaryCategories: parseCategoryList(recommendation.secondaryCategories),
        confidence: recommendation.confidenceScore,
        latencyMs: log?.latencyMs ?? null,
        status: 'SUCCESS',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Evaluation failed for ${sample.sampleId}: ${message}`);
      sampleResults.push({
        sampleId: sample.sampleId,
        groundTruthPrimaryCategory: sample.groundTruthPrimaryCategory,
        groundTruthSecondaryCategories: sample.groundTruthSecondaryCategories,
        predictedPrimaryCategory: null,
        predictedSecondaryCategories: null,
        confidence: null,
        latencyMs: null,
        status: 'EVALUATION_FAILURE',
        errorMessage: message,
      });
    }
  }

  const completedAt = new Date();

  const primaryEvaluation = computePrimaryCategoryMetrics(
    sampleResults.map(s => ({
      sampleId: s.sampleId,
      actual: s.groundTruthPrimaryCategory,
      predicted: s.predictedPrimaryCategory,
    })),
    dataset.categories
  );

  const secondaryEvaluation = computeSecondaryLabelMetrics(
    sampleResults.map(s => ({
      sampleId: s.sampleId,
      actualSecondary: s.groundTruthSecondaryCategories,
      predictedSecondary: s.predictedSecondaryCategories,
    })),
    dataset.categories
  );

  const result: EvaluationRunResult = {
    executed: true,
    datasetVersion: dataset.datasetVersion,
    datasetPath: 'evaluation/datasets/cv-classification-eval-v1.json',
    modelUsed: config.OPENAI_MODEL,
    agentVersion: cvClassificationAgent.version,
    runByUserEmail: runnerUser.email,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    totalSamples: dataset.samples.length,
    samples: sampleResults,
    primaryCategoryEvaluation: primaryEvaluation,
    secondaryCategoryEvaluation: secondaryEvaluation,
    limitations: [
      '27 samples (3 per category) is a small evaluation set - per-category metrics are statistically noisy and a single misclassification materially changes a category\'s precision/recall. Not a substitute for a larger, professionally-curated benchmark.',
      'Samples are hand-written, not drawn from real anonymized CVs - real-world phrasing, length, and ambiguity will differ.',
      'LLM responses are not fully deterministic even at a fixed model version - re-running this evaluation may produce slightly different numbers from one run to the next.',
      'The secondary-category ground truth was assigned by the same person who wrote the dataset, not by an independent labeler - no inter-annotator agreement was measured.',
      'This evaluates only the CV Classification Agent\'s category decision, not the quality or specificity of its rationale text.',
    ],
  };

  mkdirSync(dirname(RESULTS_JSON_PATH), { recursive: true });
  writeFileSync(RESULTS_JSON_PATH, JSON.stringify(result, null, 2));
  writeFileSync(REPORT_MD_PATH, generateMarkdownReport(result));

  logger.info(`Evaluation complete. Overall accuracy: ${(primaryEvaluation.overallAccuracy * 100).toFixed(1)}%`);
  logger.info(`Results written to ${RESULTS_JSON_PATH} and ${REPORT_MD_PATH}`);
}

main()
  .catch(error => {
    logger.error('Evaluation run failed', { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
