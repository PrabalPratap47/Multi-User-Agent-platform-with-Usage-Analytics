# CV Classification Evaluation Report

**Status:** Executed
**Run at:** 2026-10-09T04:39:38.297Z → 2026-10-09T04:40:17.716Z
**Model used:** gpt-4o
**Agent version:** 1.0.0
**Run by:** admin@example.com
**Dataset:** `evaluation/datasets/cv-classification-eval-v1.json` (version `v1`)

## Primary Category Results

27 of 27 samples were successfully classified (0 evaluation failure(s) excluded from the metrics below - see "Limitations").

**Overall accuracy:** 100.0%

| Category | Precision | Recall | F1 | Support |
|---|---|---|---|---|
| PSS | 100.0% | 100.0% | 100.0% | 3 |
| DCS | 100.0% | 100.0% | 100.0% | 3 |
| Front-End Developer | 100.0% | 100.0% | 100.0% | 3 |
| Back-End Developer | 100.0% | 100.0% | 100.0% | 3 |
| Web Automation | 100.0% | 100.0% | 100.0% | 3 |
| Mobile Automation | 100.0% | 100.0% | 100.0% | 3 |
| AI Engineer | 100.0% | 100.0% | 100.0% | 3 |
| Chatbot Application Tester | 100.0% | 100.0% | 100.0% | 3 |
| Other | 100.0% | 100.0% | 100.0% | 3 |

## Secondary Category Results (different methodology - see below)

**Methodology:** micro-averaged multi-label precision/recall/F1 over (sample, category) pairs

Pooled over 27 sample(s): 2 true positives, 1 false positives, 0 false negatives.

- Precision: 66.7%
- Recall: 100.0%
- F1: 80.0%

## Per-Sample Results

| Sample | Ground Truth | Predicted | Confidence | Latency | Status |
|---|---|---|---|---|---|
| EVAL-PSS-01 | PSS | PSS | 1.00 | 1709ms | SUCCESS |
| EVAL-PSS-02 | PSS | PSS | 1.00 | 1207ms | SUCCESS |
| EVAL-PSS-03 | PSS | PSS | 1.00 | 1850ms | SUCCESS |
| EVAL-DCS-01 | DCS | DCS | 1.00 | 1184ms | SUCCESS |
| EVAL-DCS-02 | DCS | DCS | 1.00 | 1803ms | SUCCESS |
| EVAL-DCS-03 | DCS | DCS | 0.90 | 1580ms | SUCCESS |
| EVAL-FE-01 | Front-End Developer | Front-End Developer | 1.00 | 1212ms | SUCCESS |
| EVAL-FE-02 | Front-End Developer | Front-End Developer | 0.95 | 1297ms | SUCCESS |
| EVAL-FE-03 | Front-End Developer | Front-End Developer | 0.95 | 1108ms | SUCCESS |
| EVAL-BE-01 | Back-End Developer | Back-End Developer | 0.95 | 1243ms | SUCCESS |
| EVAL-BE-02 | Back-End Developer | Back-End Developer | 1.00 | 1328ms | SUCCESS |
| EVAL-BE-03 | Back-End Developer | Back-End Developer | 0.90 | 1407ms | SUCCESS |
| EVAL-WA-01 | Web Automation | Web Automation | 1.00 | 1261ms | SUCCESS |
| EVAL-WA-02 | Web Automation | Web Automation | 1.00 | 1280ms | SUCCESS |
| EVAL-WA-03 | Web Automation | Web Automation | 1.00 | 1218ms | SUCCESS |
| EVAL-MA-01 | Mobile Automation | Mobile Automation | 1.00 | 1332ms | SUCCESS |
| EVAL-MA-02 | Mobile Automation | Mobile Automation | 1.00 | 2153ms | SUCCESS |
| EVAL-MA-03 | Mobile Automation | Mobile Automation | 0.95 | 1334ms | SUCCESS |
| EVAL-AI-01 | AI Engineer | AI Engineer | 1.00 | 1291ms | SUCCESS |
| EVAL-AI-02 | AI Engineer | AI Engineer | 1.00 | 1322ms | SUCCESS |
| EVAL-AI-03 | AI Engineer | AI Engineer | 1.00 | 1443ms | SUCCESS |
| EVAL-CB-01 | Chatbot Application Tester | Chatbot Application Tester | 0.90 | 1469ms | SUCCESS |
| EVAL-CB-02 | Chatbot Application Tester | Chatbot Application Tester | 1.00 | 1271ms | SUCCESS |
| EVAL-CB-03 | Chatbot Application Tester | Chatbot Application Tester | 1.00 | 1315ms | SUCCESS |
| EVAL-OTH-01 | Other | Other | 1.00 | 1143ms | SUCCESS |
| EVAL-OTH-02 | Other | Other | 1.00 | 1188ms | SUCCESS |
| EVAL-OTH-03 | Other | Other | 1.00 | 1209ms | SUCCESS |

## Methodology

**Primary category** (single-label): standard multi-class precision/recall/F1 per category, computed from the confusion matrix (true positives, false positives, false negatives) across all dataset samples. `precision = TP/(TP+FP)`, `recall = TP/(TP+FN)`, `f1 = 2PR/(P+R)`, with 0 (not NaN) when a denominator is zero. Overall accuracy is `correct / successfully-classified-samples`.

**Secondary categories** (multi-label) use a deliberately DIFFERENT methodology: micro-averaged precision/recall/F1 over every (sample, category) pair in the dataset, pooled into one confusion matrix rather than one per category. This is the standard approach for multi-label evaluation and is not comparable number-for-number with the primary-category per-category table above - see `backend/src/evaluation/metrics.ts` for the exact implementation.

A sample the agent fails to classify at all (schema validation fails even after one repair retry) is excluded from precision/recall/F1/accuracy rather than counted as an automatic wrong answer - we have no actual prediction to compare against ground truth for it. It is still counted and reported as an "evaluation failure" so the true attempt rate is visible.

## Limitations

- 27 samples (3 per category) is a small evaluation set - per-category metrics are statistically noisy and a single misclassification materially changes a category's precision/recall. Not a substitute for a larger, professionally-curated benchmark.
- Samples are hand-written, not drawn from real anonymized CVs - real-world phrasing, length, and ambiguity will differ.
- LLM responses are not fully deterministic even at a fixed model version - re-running this evaluation may produce slightly different numbers from one run to the next.
- The secondary-category ground truth was assigned by the same person who wrote the dataset, not by an independent labeler - no inter-annotator agreement was measured.
- This evaluates only the CV Classification Agent's category decision, not the quality or specificity of its rationale text.
