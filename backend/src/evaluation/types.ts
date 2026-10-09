import type { PrimaryCategoryEvaluation, SecondaryLabelEvaluation } from './metrics.js';

export interface EvalSample {
  sampleId: string;
  groundTruthPrimaryCategory: string;
  groundTruthSecondaryCategories: string[];
  secondaryCategoryNote?: string;
  cvText: string;
}

export interface EvalDataset {
  datasetVersion: string;
  description: string;
  categories: string[];
  samples: EvalSample[];
}

export interface SampleResult {
  sampleId: string;
  groundTruthPrimaryCategory: string;
  groundTruthSecondaryCategories: string[];
  predictedPrimaryCategory: string | null;
  predictedSecondaryCategories: string[] | null;
  confidence: number | null;
  latencyMs: number | null;
  status: 'SUCCESS' | 'EVALUATION_FAILURE' | 'NOT_RUN';
  errorMessage?: string;
}

/**
 * The complete evaluation run artifact - this is exactly what gets
 * serialized to evaluation/cv-classification-results.json. `executed`
 * is the load-bearing field: when false, every metric below MUST be
 * zero/empty/null, never a fabricated number - see
 * runCvClassificationEvaluation.ts and generateReport.ts, both of which
 * branch on this flag rather than ever inventing a placeholder metric.
 */
export interface EvaluationRunResult {
  executed: boolean;
  notRunReason?: string;
  datasetVersion: string;
  datasetPath: string;
  modelUsed: string | null;
  agentVersion: string | null;
  runByUserEmail: string | null;
  startedAt: string | null; // ISO timestamp
  completedAt: string | null;
  totalSamples: number;
  samples: SampleResult[];
  primaryCategoryEvaluation: PrimaryCategoryEvaluation | null;
  secondaryCategoryEvaluation: SecondaryLabelEvaluation | null;
  limitations: string[];
}
