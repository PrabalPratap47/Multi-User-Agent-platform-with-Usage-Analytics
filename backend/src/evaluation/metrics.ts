/**
 * CV classification evaluation metrics.
 *
 * Primary-category evaluation is standard single-label multi-class
 * classification: each sample has exactly one ground-truth primary
 * category and exactly one predicted primary category, so precision/
 * recall/F1 per category follow the textbook confusion-matrix
 * definitions directly.
 *
 * Secondary-category evaluation is a DIFFERENT problem (multi-label,
 * not single-label) and uses a different, separately-documented
 * methodology - see computeSecondaryLabelMetrics below. Conflating the
 * two (e.g. by treating a secondary-category miss the same way as a
 * primary-category miss) would misrepresent what each type of error
 * means, which is why the task calls for distinguishing them explicitly.
 */

export interface PrimaryPrediction {
  sampleId: string;
  actual: string;
  predicted: string | null; // null = the agent failed to classify this sample at all (see runCvClassificationEvaluation.ts)
}

export interface CategoryMetrics {
  category: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  support: number; // count of samples whose ACTUAL category is this one
  precision: number;
  recall: number;
  f1: number;
}

export interface PrimaryCategoryEvaluation {
  perCategory: CategoryMetrics[];
  overallAccuracy: number;
  /** Samples attempted but excluded from accuracy/precision/recall because the agent never produced a classification (see docs). */
  evaluationFailures: number;
  totalSamples: number;
  successfullyClassifiedSamples: number;
}

/**
 * Standard multi-class precision/recall/F1/support per category, plus
 * overall accuracy. Samples where `predicted` is null (the agent failed
 * to classify, e.g. CvClassificationValidationError after a repair
 * retry) are EXCLUDED from these calculations - counting them as an
 * automatic wrong-category guess would imply information we don't
 * actually have about what the agent "would have" predicted. They are
 * still counted and reported separately via evaluationFailures, so a
 * reader can see the true denominator either way.
 */
export function computePrimaryCategoryMetrics(
  predictions: PrimaryPrediction[],
  categories: readonly string[]
): PrimaryCategoryEvaluation {
  const attempted = predictions.filter(p => p.predicted !== null) as Array<{
    sampleId: string;
    actual: string;
    predicted: string;
  }>;
  const evaluationFailures = predictions.length - attempted.length;

  const perCategory: CategoryMetrics[] = categories.map(category => {
    const truePositives = attempted.filter(p => p.actual === category && p.predicted === category).length;
    const falsePositives = attempted.filter(p => p.predicted === category && p.actual !== category).length;
    const falseNegatives = attempted.filter(p => p.actual === category && p.predicted !== category).length;
    const support = attempted.filter(p => p.actual === category).length;

    const precision = truePositives + falsePositives > 0 ? truePositives / (truePositives + falsePositives) : 0;
    const recall = truePositives + falseNegatives > 0 ? truePositives / (truePositives + falseNegatives) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    return { category, truePositives, falsePositives, falseNegatives, support, precision, recall, f1 };
  });

  const correct = attempted.filter(p => p.actual === p.predicted).length;
  const overallAccuracy = attempted.length > 0 ? correct / attempted.length : 0;

  return {
    perCategory,
    overallAccuracy,
    evaluationFailures,
    totalSamples: predictions.length,
    successfullyClassifiedSamples: attempted.length,
  };
}

export interface SecondaryLabelPrediction {
  sampleId: string;
  actualSecondary: string[];
  predictedSecondary: string[] | null; // null = evaluation failure for this sample, excluded below
}

export interface SecondaryLabelEvaluation {
  methodology: 'micro-averaged multi-label precision/recall/F1 over (sample, category) pairs';
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  samplesEvaluated: number;
  evaluationFailures: number;
}

/**
 * Secondary categories are MULTI-label (zero or more per sample), so
 * "precision per category" in the single-label sense doesn't apply the
 * same way - a sample can be simultaneously a true positive for one
 * secondary category and a false negative for another. This computes
 * MICRO-averaged precision/recall/F1: every (sample, category) pair
 * across the whole dataset is treated as one binary "is this category a
 * secondary label for this sample?" decision, and precision/recall are
 * computed over the pooled set of those decisions - not averaged
 * per-category, which is a deliberately different (and separately
 * documented) choice from the primary-category evaluation above.
 */
export function computeSecondaryLabelMetrics(
  predictions: SecondaryLabelPrediction[],
  categories: readonly string[]
): SecondaryLabelEvaluation {
  const attempted = predictions.filter(p => p.predictedSecondary !== null) as Array<{
    sampleId: string;
    actualSecondary: string[];
    predictedSecondary: string[];
  }>;
  const evaluationFailures = predictions.length - attempted.length;

  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  for (const sample of attempted) {
    for (const category of categories) {
      const actualHasIt = sample.actualSecondary.includes(category);
      const predictedHasIt = sample.predictedSecondary.includes(category);
      if (actualHasIt && predictedHasIt) truePositives += 1;
      else if (!actualHasIt && predictedHasIt) falsePositives += 1;
      else if (actualHasIt && !predictedHasIt) falseNegatives += 1;
      // (!actualHasIt && !predictedHasIt) is a true negative - not counted, consistent with standard micro-averaging
    }
  }

  const precision = truePositives + falsePositives > 0 ? truePositives / (truePositives + falsePositives) : 0;
  const recall = truePositives + falseNegatives > 0 ? truePositives / (truePositives + falseNegatives) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    methodology: 'micro-averaged multi-label precision/recall/F1 over (sample, category) pairs',
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1,
    samplesEvaluated: attempted.length,
    evaluationFailures,
  };
}
