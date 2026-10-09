import { describe, it, expect } from 'vitest';
import { computePrimaryCategoryMetrics, computeSecondaryLabelMetrics } from '../src/evaluation/metrics.js';

/**
 * Every expected value below is hand-computed in the comments next to
 * the assertion - this is pure math with no LLM call involved, so
 * unlike the evaluation run itself, these ARE fully verified against a
 * known confusion matrix, not just plausible-looking.
 */

describe('computePrimaryCategoryMetrics', () => {
  const categories = ['A', 'B', 'C'];

  // Confusion matrix:
  //  1. actual=A predicted=A  (TP-A)
  //  2. actual=A predicted=B  (FN-A, FP-B)
  //  3. actual=A predicted=A  (TP-A)
  //  4. actual=B predicted=B  (TP-B)
  //  5. actual=B predicted=C  (FN-B, FP-C)
  //  6. actual=C predicted=C  (TP-C)
  //  7. actual=C predicted=A  (FN-C, FP-A)
  //  8. actual=A predicted=null (evaluation failure - excluded from all metrics)
  const predictions = [
    { sampleId: '1', actual: 'A', predicted: 'A' },
    { sampleId: '2', actual: 'A', predicted: 'B' },
    { sampleId: '3', actual: 'A', predicted: 'A' },
    { sampleId: '4', actual: 'B', predicted: 'B' },
    { sampleId: '5', actual: 'B', predicted: 'C' },
    { sampleId: '6', actual: 'C', predicted: 'C' },
    { sampleId: '7', actual: 'C', predicted: 'A' },
    { sampleId: '8', actual: 'A', predicted: null },
  ];

  const result = computePrimaryCategoryMetrics(predictions, categories);

  it('counts evaluation failures separately and excludes them from the denominator', () => {
    expect(result.totalSamples).toBe(8);
    expect(result.evaluationFailures).toBe(1);
    expect(result.successfullyClassifiedSamples).toBe(7);
  });

  it('computes category A: TP=2, FP=1, FN=1, support=3, precision=recall=f1=2/3', () => {
    const a = result.perCategory.find(c => c.category === 'A')!;
    expect(a.truePositives).toBe(2);
    expect(a.falsePositives).toBe(1); // sample 7 predicted A but was actually C
    expect(a.falseNegatives).toBe(1); // sample 2 was actually A but predicted B
    expect(a.support).toBe(3); // samples 1, 2, 3 (NOT sample 8 - excluded as an evaluation failure)
    expect(a.precision).toBeCloseTo(2 / 3, 10);
    expect(a.recall).toBeCloseTo(2 / 3, 10);
    expect(a.f1).toBeCloseTo(2 / 3, 10);
  });

  it('computes category B: TP=1, FP=1, FN=1, support=2, precision=recall=f1=0.5', () => {
    const b = result.perCategory.find(c => c.category === 'B')!;
    expect(b.truePositives).toBe(1);
    expect(b.falsePositives).toBe(1); // sample 2 predicted B but was actually A
    expect(b.falseNegatives).toBe(1); // sample 5 was actually B but predicted C
    expect(b.support).toBe(2);
    expect(b.precision).toBeCloseTo(0.5, 10);
    expect(b.recall).toBeCloseTo(0.5, 10);
    expect(b.f1).toBeCloseTo(0.5, 10);
  });

  it('computes category C: TP=1, FP=1, FN=1, support=2, precision=recall=f1=0.5', () => {
    const c = result.perCategory.find(cat => cat.category === 'C')!;
    expect(c.truePositives).toBe(1);
    expect(c.falsePositives).toBe(1); // sample 5 predicted C but was actually B
    expect(c.falseNegatives).toBe(1); // sample 7 was actually C but predicted A
    expect(c.support).toBe(2);
    expect(c.precision).toBeCloseTo(0.5, 10);
    expect(c.recall).toBeCloseTo(0.5, 10);
    expect(c.f1).toBeCloseTo(0.5, 10);
  });

  it('computes overall accuracy = 4/7 (samples 1,3,4,6 correct out of 7 attempted)', () => {
    expect(result.overallAccuracy).toBeCloseTo(4 / 7, 10);
  });

  it('a category with zero support and zero predictions gets precision/recall/f1 of 0, not NaN', () => {
    const result2 = computePrimaryCategoryMetrics(
      [{ sampleId: '1', actual: 'A', predicted: 'A' }],
      ['A', 'B']
    );
    const b = result2.perCategory.find(c => c.category === 'B')!;
    expect(b.precision).toBe(0);
    expect(b.recall).toBe(0);
    expect(b.f1).toBe(0);
    expect(Number.isNaN(b.precision)).toBe(false);
  });

  it('when every sample fails evaluation, accuracy is 0 (not NaN) and all categories show 0 support', () => {
    const result3 = computePrimaryCategoryMetrics(
      [{ sampleId: '1', actual: 'A', predicted: null }],
      ['A', 'B']
    );
    expect(result3.overallAccuracy).toBe(0);
    expect(Number.isNaN(result3.overallAccuracy)).toBe(false);
    expect(result3.evaluationFailures).toBe(1);
  });
});

describe('computeSecondaryLabelMetrics', () => {
  const categories = ['A', 'B', 'C'];

  // Per-(sample,category) pair tally:
  //  1. actual=[A]    predicted=[A]    -> A:TP
  //  2. actual=[A,B]  predicted=[A]    -> A:TP, B:FN
  //  3. actual=[]     predicted=[C]    -> C:FP
  //  4. actual=[B]    predicted=[B,C]  -> B:TP, C:FP
  // Totals: TP=3 (1-A, 2-A, 4-B), FP=2 (3-C, 4-C), FN=1 (2-B)
  // precision = 3/5 = 0.6, recall = 3/4 = 0.75, f1 = 2*0.6*0.75/1.35 = 0.6667
  const predictions = [
    { sampleId: '1', actualSecondary: ['A'], predictedSecondary: ['A'] },
    { sampleId: '2', actualSecondary: ['A', 'B'], predictedSecondary: ['A'] },
    { sampleId: '3', actualSecondary: [], predictedSecondary: ['C'] },
    { sampleId: '4', actualSecondary: ['B'], predictedSecondary: ['B', 'C'] },
  ];

  const result = computeSecondaryLabelMetrics(predictions, categories);

  it('computes the correct micro-averaged TP/FP/FN totals', () => {
    expect(result.truePositives).toBe(3);
    expect(result.falsePositives).toBe(2);
    expect(result.falseNegatives).toBe(1);
  });

  it('computes precision=0.6, recall=0.75, f1≈0.6667', () => {
    expect(result.precision).toBeCloseTo(0.6, 10);
    expect(result.recall).toBeCloseTo(0.75, 10);
    expect(result.f1).toBeCloseTo((2 * 0.6 * 0.75) / (0.6 + 0.75), 10);
  });

  it('excludes evaluation failures (null predictions) from the pooled counts', () => {
    const withFailure = computeSecondaryLabelMetrics(
      [...predictions, { sampleId: '5', actualSecondary: ['A'], predictedSecondary: null }],
      categories
    );
    expect(withFailure.evaluationFailures).toBe(1);
    expect(withFailure.truePositives).toBe(3); // unchanged from the 4-sample case above
    expect(withFailure.samplesEvaluated).toBe(4);
  });

  it('a sample with no secondary categories at all on either side contributes nothing (no false positives)', () => {
    const result2 = computeSecondaryLabelMetrics(
      [{ sampleId: '1', actualSecondary: [], predictedSecondary: [] }],
      categories
    );
    expect(result2.truePositives).toBe(0);
    expect(result2.falsePositives).toBe(0);
    expect(result2.falseNegatives).toBe(0);
    expect(result2.precision).toBe(0);
    expect(result2.recall).toBe(0);
  });
});
