import { useEffect, useState } from 'react';
import type { CvDecisionRecord, CvRecommendation } from '../../types/index.js';
import { DecisionPanel } from './DecisionPanel.js';
import { CategoryChip, DecisionBadge, formatConfidence } from './cvUi.js';

function FinalDecision({ decision }: { decision: CvDecisionRecord }) {
  return (
    <div className="space-y-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <DecisionBadge type={decision.decisionType} />
        <span className="text-gray-500">{new Date(decision.timestamp).toLocaleString()}</span>
      </div>
      {decision.decisionType === 'REJECT' ? (
        <p className="text-gray-700">No category accepted.</p>
      ) : (
        <p className="text-gray-700">
          Final category: <strong>{decision.finalPrimaryCategory}</strong>
          {decision.finalSecondaryCategories.length > 0 && <> (also: {decision.finalSecondaryCategories.join(', ')})</>}
        </p>
      )}
      {decision.reason && (
        <p className="text-gray-700">
          Reason: <span className="italic">{decision.reason}</span>
        </p>
      )}
    </div>
  );
}

export function RecommendationCard({
  recommendation,
  highlighted,
  onDecided,
}: {
  recommendation: CvRecommendation;
  highlighted?: boolean;
  onDecided: () => void;
}) {
  const [decisions, setDecisions] = useState<CvDecisionRecord[]>(recommendation.decisions ?? []);
  const [editing, setEditing] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  useEffect(() => {
    setDecisions(recommendation.decisions ?? []);
  }, [recommendation.decisions]);

  const latest = decisions[0];
  const scores = Object.entries(recommendation.confidenceScores ?? {}).sort((a, b) => b[1] - a[1]);
  const title = recommendation.cvDocument?.fileName || `CV #${recommendation.cvDocumentId}`;

  const handleDecided = (decision: CvDecisionRecord) => {
    setDecisions(current => [decision, ...current]);
    setEditing(false);
    setConfirmation(`Decision saved: ${decision.decisionType}. The original AI recommendation is unchanged.`);
    onDecided();
  };

  return (
    <article
      id={`cv-result-${recommendation.id}`}
      className={`rounded-lg border bg-white p-4 shadow-sm sm:p-5 ${highlighted ? 'border-blue-400 ring-2 ring-blue-100' : 'border-gray-200'}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="break-words font-semibold text-gray-900">{title}</h3>
          <p className="text-xs text-gray-500">
            Result #{recommendation.id} · classified {new Date(recommendation.createdAt).toLocaleString()}
          </p>
        </div>
        <DecisionBadge type={latest?.decisionType ?? 'PENDING'} />
      </header>

      <section className="mt-4 space-y-4" aria-label="Original AI recommendation">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Original AI recommendation</p>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <p className="text-sm text-gray-500">Primary category</p>
            <p className="text-lg font-bold text-gray-900">{recommendation.primaryCategory}</p>
            <p className="text-sm text-gray-600">Confidence {formatConfidence(recommendation.confidenceScore)}</p>
          </div>
          <div>
            <p className="text-sm text-gray-500">Secondary categories</p>
            {recommendation.secondaryCategories.length === 0 ? (
              <p className="text-sm italic text-gray-500">None</p>
            ) : (
              <div className="mt-1 flex flex-wrap gap-1">
                {recommendation.secondaryCategories.map(c => (
                  <CategoryChip key={c} name={c} confidence={recommendation.confidenceScores?.[c]} />
                ))}
              </div>
            )}
          </div>
        </div>

        <details className="rounded-md border border-gray-200 p-3">
          <summary className="cursor-pointer text-sm font-medium text-gray-700">Confidence for every category (0-1)</summary>
          <ul className="mt-2 space-y-1">
            {scores.map(([category, value]) => (
              <li key={category} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-2 text-sm">
                <span className="truncate text-gray-700" title={category}>
                  {category}
                </span>
                <span className="h-2 overflow-hidden rounded-full bg-gray-200">
                  <span className="block h-full rounded-full bg-blue-500" style={{ width: `${Math.round(value * 100)}%` }} />
                </span>
                <span className="tabular-nums text-gray-600">{formatConfidence(value)}</span>
              </li>
            ))}
          </ul>
        </details>

        <div>
          <p className="text-sm font-medium text-gray-700">Rationale and evidence from the CV</p>
          <ul className="mt-2 space-y-2">
            {recommendation.rationale.map((entry, i) => (
              <li key={i} className="rounded-md bg-gray-50 p-3 text-sm">
                <p className="font-medium text-gray-800">
                  Why {entry.category}
                  {entry.category === recommendation.primaryCategory && <span className="ml-1 text-xs text-blue-700">(primary)</span>}
                </p>
                <blockquote className="mt-1 border-l-4 border-gray-300 pl-3 italic text-gray-700">“{entry.evidence}”</blockquote>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="mt-5 space-y-3 border-t border-gray-100 pt-4" aria-label="Decision">
        {confirmation && (
          <p role="status" className="rounded border border-green-200 bg-green-50 p-2 text-sm text-green-800">
            {confirmation}
          </p>
        )}

        {latest && !editing && (
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Final decision</p>
            <FinalDecision decision={latest} />
            {decisions.length > 1 && (
              <details className="mt-2 text-sm">
                <summary className="cursor-pointer text-gray-600">Earlier decisions ({decisions.length - 1})</summary>
                <ul className="mt-2 space-y-2 border-l-2 border-gray-200 pl-3">
                  {decisions.slice(1).map(d => (
                    <li key={d.id}>
                      <FinalDecision decision={d} />
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <button
              type="button"
              onClick={() => {
                setEditing(true);
                setConfirmation(null);
              }}
              className="mt-3 text-sm font-medium text-blue-700 underline hover:text-blue-900"
            >
              Change decision
            </button>
          </div>
        )}

        {(!latest || editing) && (
          <DecisionPanel
            key={decisions.length}
            recommendation={recommendation}
            onDecided={handleDecided}
            onCancel={latest ? () => setEditing(false) : undefined}
          />
        )}
      </section>
    </article>
  );
}
