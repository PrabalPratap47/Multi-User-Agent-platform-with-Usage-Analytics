import type { EvaluationRunResult } from './types.js';

/**
 * Renders an EvaluationRunResult as the markdown report. Deliberately a
 * pure function of its input - it never computes a metric itself (that
 * already happened in metrics.ts before this is called), and it never
 * substitutes a placeholder number for a missing one. When
 * `result.executed` is false, the report says so prominently and stops
 * there; it does not print zeros dressed up as real results.
 */
export function generateMarkdownReport(result: EvaluationRunResult): string {
  const lines: string[] = [];

  lines.push('# CV Classification Evaluation Report');
  lines.push('');

  if (!result.executed) {
    lines.push('## ⚠️ NOT YET EXECUTED');
    lines.push('');
    lines.push(
      '**This evaluation has not been run.** No precision, recall, F1, or accuracy numbers exist yet - ' +
        'none are fabricated or estimated below. Every field that would normally hold a metric is explicitly ' +
        'absent, not a placeholder zero dressed up as a real result.'
    );
    lines.push('');
    if (result.notRunReason) {
      lines.push(`**Reason:** ${result.notRunReason}`);
      lines.push('');
    }
    lines.push('### How to produce real results');
    lines.push('```bash');
    lines.push('cd backend');
    lines.push('npm install');
    lines.push('npm run db:migrate:deploy && npm run db:seed   # registers the CV Classification Agent + admin user');
    lines.push('npm run eval:cv-classification');
    lines.push('```');
    lines.push('');
    lines.push(
      `This requires: Node.js, the seeded development SQLite database, and a valid \`OPENAI_API_KEY\` with available ` +
        `quota (the evaluation makes ${result.totalSamples} real API calls, one per dataset sample, plus up to ` +
        'one repair-retry call each if a response fails validation). Running it overwrites this file and ' +
        '`evaluation/cv-classification-results.json` with the actual results.'
    );
    lines.push('');
    lines.push('### Dataset (ready, already labeled)');
    lines.push('');
    lines.push(`- Dataset version: \`${result.datasetVersion}\``);
    lines.push(`- Dataset file: \`${result.datasetPath}\``);
    lines.push(`- Total samples: ${result.totalSamples} (3 per category across all 9 categories)`);
    lines.push('');
    lines.push('See "Methodology" below for exactly what will be calculated once this is run.');
    lines.push('');
  } else {
    lines.push(`**Status:** Executed`);
    lines.push(`**Run at:** ${result.startedAt} → ${result.completedAt}`);
    lines.push(`**Model used:** ${result.modelUsed}`);
    lines.push(`**Agent version:** ${result.agentVersion}`);
    lines.push(`**Run by:** ${result.runByUserEmail}`);
    lines.push(`**Dataset:** \`${result.datasetPath}\` (version \`${result.datasetVersion}\`)`);
    lines.push('');

    const primary = result.primaryCategoryEvaluation!;
    lines.push('## Primary Category Results');
    lines.push('');
    lines.push(
      `${primary.successfullyClassifiedSamples} of ${primary.totalSamples} samples were successfully classified ` +
        `(${primary.evaluationFailures} evaluation failure(s) excluded from the metrics below - see "Limitations").`
    );
    lines.push('');
    lines.push(`**Overall accuracy:** ${(primary.overallAccuracy * 100).toFixed(1)}%`);
    lines.push('');
    lines.push('| Category | Precision | Recall | F1 | Support |');
    lines.push('|---|---|---|---|---|');
    for (const c of primary.perCategory) {
      lines.push(
        `| ${c.category} | ${(c.precision * 100).toFixed(1)}% | ${(c.recall * 100).toFixed(1)}% | ${(c.f1 * 100).toFixed(1)}% | ${c.support} |`
      );
    }
    lines.push('');

    const secondary = result.secondaryCategoryEvaluation!;
    lines.push('## Secondary Category Results (different methodology - see below)');
    lines.push('');
    lines.push(`**Methodology:** ${secondary.methodology}`);
    lines.push('');
    lines.push(
      `Pooled over ${secondary.samplesEvaluated} sample(s): ${secondary.truePositives} true positives, ` +
        `${secondary.falsePositives} false positives, ${secondary.falseNegatives} false negatives.`
    );
    lines.push('');
    lines.push(`- Precision: ${(secondary.precision * 100).toFixed(1)}%`);
    lines.push(`- Recall: ${(secondary.recall * 100).toFixed(1)}%`);
    lines.push(`- F1: ${(secondary.f1 * 100).toFixed(1)}%`);
    lines.push('');

    lines.push('## Per-Sample Results');
    lines.push('');
    lines.push('| Sample | Ground Truth | Predicted | Confidence | Latency | Status |');
    lines.push('|---|---|---|---|---|---|');
    for (const s of result.samples) {
      lines.push(
        `| ${s.sampleId} | ${s.groundTruthPrimaryCategory} | ${s.predictedPrimaryCategory ?? '—'} | ${
          s.confidence !== null ? s.confidence.toFixed(2) : '—'
        } | ${s.latencyMs !== null ? `${s.latencyMs}ms` : '—'} | ${s.status} |`
      );
    }
    lines.push('');
  }

  lines.push('## Methodology');
  lines.push('');
  lines.push(
    '**Primary category** (single-label): standard multi-class precision/recall/F1 per category, computed from ' +
      'the confusion matrix (true positives, false positives, false negatives) across all dataset samples. ' +
      '`precision = TP/(TP+FP)`, `recall = TP/(TP+FN)`, `f1 = 2PR/(P+R)`, with 0 (not NaN) when a denominator is ' +
      'zero. Overall accuracy is `correct / successfully-classified-samples`.'
  );
  lines.push('');
  lines.push(
    '**Secondary categories** (multi-label) use a deliberately DIFFERENT methodology: micro-averaged ' +
      'precision/recall/F1 over every (sample, category) pair in the dataset, pooled into one confusion matrix ' +
      'rather than one per category. This is the standard approach for multi-label evaluation and is not ' +
      'comparable number-for-number with the primary-category per-category table above - see ' +
      '`backend/src/evaluation/metrics.ts` for the exact implementation.'
  );
  lines.push('');
  lines.push(
    'A sample the agent fails to classify at all (schema validation fails even after one repair retry) is ' +
      'excluded from precision/recall/F1/accuracy rather than counted as an automatic wrong answer - we have no ' +
      'actual prediction to compare against ground truth for it. It is still counted and reported as an ' +
      '"evaluation failure" so the true attempt rate is visible.'
  );
  lines.push('');

  lines.push('## Limitations');
  lines.push('');
  for (const limitation of result.limitations) {
    lines.push(`- ${limitation}`);
  }
  lines.push('');

  return lines.join('\n');
}
